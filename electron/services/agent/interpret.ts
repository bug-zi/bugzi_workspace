import { logWarn } from '../logger'
// 解读产物（260929 抓取三页签阅读改造）：抓取+翻译并入 paper_fetch 幂等管道（en 译文 kind=translation
// 升格「原文（中文版）」载体）；导读卡（大致内容+文章脉络）/精读版（关键部分拆解）改按需，生成器
// 参数化 owner 供论文/科普共用（原文统一简中后 prompt 一致）。逐章落盘、按章幂等续跑；token 记账走
// llm_usage 场景差值；不注入个人画像（白名单默认全关）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, nowIso, userDataDir } from '../../db/db'
import { chatCompletion } from '../../ai/llm'
import { isLlmConfigured } from '../../ai/services'
import { mdWrite } from '../files'
import { registerTask, enqueue } from './queue'
import { tokensSince } from './budget'
import { wrapMaterial } from './guardrails'
import { ensureFulltext, getPaper, readFulltext, upsertInterpretation, writeInterpretationMd } from './papers'
import type { TaskContext } from './queue'
import type { PaperRow } from '../../../src/shared/types'

const DIGEST_INPUT_MAX = 60000
const GLOSSARY_INPUT_MAX = 40000
const CHUNK_SIZE = 10000
const MAX_CHUNKS = 20

function ensureAlive(ctx: TaskContext): void {
  if (ctx.signal.aborted) throw new Error('已取消')
}

/** 场景 token 差值累加器 */
function tokenTracker(scene: string, ctx: TaskContext): () => number {
  const start = nowIso()
  let reported = 0
  return (): number => {
    const total = tokensSince(start, scene)
    const delta = Math.max(0, total - reported)
    reported = total
    if (delta > 0) ctx.addTokens(delta)
    return delta
  }
}

/** 段落边界切块（~CHUNK_SIZE，上限 MAX_CHUNKS） */
function chunkText(text: string, size = CHUNK_SIZE): string[] {
  const paras = text.split(/\n\s*\n/)
  const chunks: string[] = []
  let cur = ''
  for (const p of paras) {
    if (cur.length + p.length > size && cur) {
      chunks.push(cur.trim())
      cur = ''
      if (chunks.length >= MAX_CHUNKS) break
    }
    cur += (cur ? '\n\n' : '') + p
  }
  if (cur.trim() && chunks.length < MAX_CHUNKS) chunks.push(cur.trim())
  return chunks.slice(0, MAX_CHUNKS)
}

/** 中文原文守卫：全文缓存缺失/过短即抛（打开与生成同受 ready 门禁，正常不会命中） */
function requireChineseFulltext(paperId: number): string {
  const txt = readFulltext(paperId)
  if (txt && txt.length >= 200) return txt
  throw new Error('中文原文未就绪（请先重试抓取或导入 PDF）')
}

/** 共用 owner 描述（论文/科普导读卡与精读版；原文统一为简体中文全文） */
export interface InterpOwner {
  ownerType: 'paper' | 'science_article'
  ownerId: number
  title: string
  authors: string[]
  url: string
  dateText: string
  /** 产物文件名前缀：论文 `${id}`、科普 `sa-${id}`（md/interpretations/ 同目录防撞） */
  filePrefix: string
  tags: string[]
}

function headOf(owner: InterpOwner, label: string, extra?: string): string {
  const authors = owner.authors.length ? ` ｜ ${owner.authors.slice(0, 5).join(', ')}` : ''
  return `# ${label}：${owner.title}\n\n> 来源：${owner.url}${authors}${owner.dateText ? ` ｜ ${owner.dateText}` : ''}${extra ?? ''}\n`
}

/** 该 owner 是否已有简中译文（paper_fetch / science_fetch 幂等判定共用） */
export function hasTranslation(ownerType: InterpOwner['ownerType'], ownerId: number): boolean {
  return !!getDb()
    .prepare(
      "SELECT id FROM interpretations WHERE owner_type = ? AND owner_id = ? AND kind = 'translation' AND status = 'done'"
    )
    .get(ownerType, ownerId)
}

// ---------- 导读卡（大致内容 + 文章脉络，两模块共用，单次调用） ----------

export async function generateDigestFor(
  owner: InterpOwner,
  fulltext: string,
  ctx: TaskContext,
  scene: string
): Promise<string> {
  const delta = tokenTracker(scene, ctx)
  ensureAlive(ctx)
  const res = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: `你是文章导读助手。请为下面这篇简体中文文章生成中文导读卡，严格按以下骨架输出 Markdown（两个二级标题缺一不可，总长 400-700 字）：

# 大致内容
（200-400 字概括这篇内容：核心问题、主要观点或发现、最终结论）

# 文章脉络
（按原文行进顺序梳理结构，每个主要部分一行「部分主题——该部分讲了什么」，让读者不读原文也能看清行文骨架）

只输出 Markdown 正文，不要开场白。

文章标题：${owner.title}

${wrapMaterial('文章材料', fulltext.slice(0, DIGEST_INPUT_MAX))}`
      }
    ],
    temperature: 0.3,
    scene,
    signal: ctx.signal
  })
  delta()
  ensureAlive(ctx)
  let md = res.content.trim()
  if (!md) throw new Error('LLM 未返回内容')
  // 剥掉模型可能自带的一级标题行，统一用标准头
  md = md.replace(/^#\s+.*\n/, '').trim()
  const rel = writeInterpretationMd(`${owner.filePrefix}-digest.md`, headOf(owner, '导读') + md + '\n')
  upsertInterpretation(owner.ownerType, owner.ownerId, 'digest', rel, 0)
  return rel
}

// ---------- 精读版（关键部分/关键句拆解，逐章续跑，两模块共用） ----------

export async function generateDeepreadFor(
  owner: InterpOwner,
  fulltext: string,
  ctx: TaskContext,
  scene: string
): Promise<string> {
  const delta = tokenTracker(scene, ctx)
  const chunks = chunkText(fulltext)
  if (chunks.length === 0) throw new Error('全文为空')
  const rel = `md/interpretations/${owner.filePrefix}-deepread.md`
  const abs = join(userDataDir(), rel)
  let md = existsSync(abs) ? readFileSync(abs, 'utf-8') : ''
  if (!md) {
    md = headOf(owner, '精读', '\n> 对原文关键部分与关键句的逐段拆解分析（引用原句 → 论证/术语/隐含假设/与主线关系）\n')
  }
  const done = (md.match(/^## 第 \d+ 部分/gm) ?? []).length
  for (let i = done; i < chunks.length; i++) {
    ensureAlive(ctx)
    const res = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: `你是文章精读助手。以下是《${owner.title}》的第 ${i + 1}/${chunks.length} 部分（简体中文全文的一部分，可能从章节中间开始）。请对本部分做精读拆解：
1. 挑出本部分最关键的论述与关键句（以 Markdown 引用块 > 引用原句），逐条给出拆解分析：它在论证什么、关键术语的含义、隐含假设或前提、与全文主线的关系；
2. 宁精勿多：每部分挑 3-6 处真正关键的内容，不要逐句复述原文。
只输出 Markdown 正文（不要一级标题，不要开场白），全文简体中文。\n\n${wrapMaterial(`文章第 ${i + 1} 部分`, chunks[i])}`
        }
      ],
      temperature: 0.3,
      scene,
      signal: ctx.signal
    })
    delta()
    md += `## 第 ${i + 1} 部分\n\n${res.content.trim()}\n\n`
    mdWrite(rel, md)
  }
  upsertInterpretation(owner.ownerType, owner.ownerId, 'deepread', rel, 0)
  return rel
}

// ---------- 原文中文版翻译（paper_fetch 管道调用；kind=translation 即「原文」载体） ----------

function glossaryOf(paper: PaperRow): { en: string; zh: string }[] {
  try {
    const parsed = JSON.parse(String(paper.glossary ?? '[]')) as { en?: unknown; zh?: unknown }[]
    return Array.isArray(parsed)
      ? parsed.filter((g): g is { en: string; zh: string } => typeof g?.en === 'string' && typeof g?.zh === 'string')
      : []
  } catch {
    return []
  }
}

async function runPaperTranslate(paper: PaperRow, ctx: TaskContext): Promise<string> {
  const delta = tokenTracker('agent:translate', ctx)
  const text = requireChineseFulltext(paper.id)
  const chunks = chunkText(text)
  if (chunks.length === 0) throw new Error('全文为空')
  // ① 术语表先行（已有则复用；保证全文一致定译）
  let glossary = glossaryOf(paper)
  if (glossary.length === 0) {
    ensureAlive(ctx)
    const res = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: `从以下论文材料中提取需要统一翻译的英文术语（方法名、缩写、专业概念、人名系统等），给出全文统一的中文定译。10-30 条，仅输出 JSON：{"glossary":[{"en":"原文","zh":"定译"}]}，不要其他文字。\n\n${wrapMaterial('论文材料', text.slice(0, GLOSSARY_INPUT_MAX))}`
        }
      ],
      temperature: 0.2,
      jsonMode: true,
      scene: 'agent:translate',
      signal: ctx.signal
    })
    delta()
    try {
      const cleaned = res.content.replace(/```(?:json)?/g, '').trim()
      const parsed = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1)) as {
        glossary?: { en?: unknown; zh?: unknown }[]
      }
      glossary = (parsed.glossary ?? [])
        .filter((g): g is { en: string; zh: string } => typeof g?.en === 'string' && typeof g?.zh === 'string')
        .slice(0, 40)
    } catch {
      /* 术语表失败不阻塞翻译，仅一致性下降 */
      logWarn('agent', `[agent:translate] 《${paper.title}》术语表生成失败，直接翻译`)
    }
    if (glossary.length > 0) {
      getDb()
        .prepare('UPDATE papers SET glossary = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(glossary), nowIso(), paper.id)
    }
  }
  // ② 逐章翻译（术语表注入 system）
  const rel = `md/interpretations/${paper.id}-trans.md`
  const abs = join(userDataDir(), rel)
  let md = existsSync(abs) ? readFileSync(abs, 'utf-8') : ''
  if (!md) {
    const table = glossary.map((g) => `- ${g.en} → ${g.zh}`).join('\n')
    md = `# 原文（中文）：${paper.title}\n\n> 来源：${paper.url}${glossary.length ? `\n\n## 术语表\n\n${table}\n` : '\n'}`
  }
  const done = (md.match(/^## 第 \d+ 章/gm) ?? []).length
  const glossaryJson = glossary.length ? JSON.stringify(glossary) : ''
  for (let i = done; i < chunks.length; i++) {
    ensureAlive(ctx)
    const res = await chatCompletion({
      messages: [
        ...(glossaryJson
          ? [
              {
                role: 'system' as const,
                content: `你是学术论文译者。以下术语表是全文统一约定，翻译时必须采用其中的定译：${glossaryJson}`
              }
            ]
          : []),
        {
          role: 'user',
          content: `请将下面论文《${paper.title}》的第 ${i + 1}/${chunks.length} 部分翻译成中文（学术语体，术语与全文统一；该部分可能从章节中间开始）。仅输出译文 Markdown，不要原文、不要解释。\n\n${wrapMaterial(`论文第 ${i + 1} 部分`, chunks[i])}`
        }
      ],
      temperature: 0.2,
      scene: 'agent:translate',
      signal: ctx.signal
    })
    delta()
    md += `## 第 ${i + 1} 章\n\n${res.content.trim()}\n\n`
    mdWrite(rel, md)
  }
  upsertInterpretation('paper', paper.id, 'translation', rel, 0)
  return rel
}

// ---------- paper_fetch 管道（幂等：抓缺 → 译缺 → ready → embed；接受/重试/导入 PDF 共用） ----------

async function paperFetchRunner(ctx: TaskContext): Promise<void> {
  const paper = getPaper(ctx.refId ?? 0)
  if (!paper) throw new Error('NOT_FOUND')
  await ensureFulltext(paper)
  const fresh = getPaper(paper.id)
  if (!fresh) throw new Error('NOT_FOUND')
  const txt = readFulltext(fresh.id)
  if (!txt || txt.length < 200) throw new Error('全文抓取失败（缓存缺失）')
  if (fresh.language === 'en' && !hasTranslation('paper', fresh.id)) {
    if (!isLlmConfigured()) throw new Error('LLM 未配置，无法翻译为中文')
    await runPaperTranslate(fresh, ctx)
  }
  getDb().prepare("UPDATE papers SET status = 'ready', updated_at = ? WHERE id = ?").run(nowIso(), fresh.id)
  // 全文就绪后自动索引 + 相关推荐
  enqueue('embed_index', { refId: fresh.id, trigger: 'auto' })
}

// ---------- 导读卡 / 精读版 runners（按需） ----------

function paperOwner(paper: PaperRow): InterpOwner {
  return {
    ownerType: 'paper',
    ownerId: paper.id,
    title: paper.title,
    authors: paper.authors,
    url: paper.url,
    dateText: paper.date ?? (paper.year != null ? String(paper.year) : ''),
    filePrefix: String(paper.id),
    tags: paper.tags
  }
}

async function makeDigestRunner(ctx: TaskContext): Promise<void> {
  const paper = getPaper(ctx.refId ?? 0)
  if (!paper) throw new Error('NOT_FOUND')
  if (!isLlmConfigured()) throw new Error('LLM 未配置')
  const txt = requireChineseFulltext(paper.id)
  const rel = await generateDigestFor(paperOwner(paper), txt, ctx, 'agent:digest')
  getDb().prepare('UPDATE papers SET digest_md = ?, updated_at = ? WHERE id = ?').run(rel, nowIso(), paper.id)
}

async function paperDeepreadRunner(ctx: TaskContext): Promise<void> {
  const paper = getPaper(ctx.refId ?? 0)
  if (!paper) throw new Error('NOT_FOUND')
  if (!isLlmConfigured()) throw new Error('LLM 未配置')
  const txt = requireChineseFulltext(paper.id)
  await generateDeepreadFor(paperOwner(paper), txt, ctx, 'agent:deepread')
}

// ---------- 按需入口 ----------

export type InterpretKind = 'digest' | 'deepread'

/** 按需触发生成；已有 running 抛错；已有 done 且未 force 抛「需确认」 */
export async function runInterpret(
  paperId: number,
  kind: InterpretKind,
  force = false,
  trigger: 'manual' | 'auto' = 'manual'
): Promise<number> {
  const d = getDb()
  const existing = d
    .prepare('SELECT id, status FROM interpretations WHERE owner_type = ? AND owner_id = ? AND kind = ?')
    .get('paper', paperId, kind) as { id: number; status: string } | undefined
  if (existing?.status === 'running') throw new Error('该解读任务正在进行中')
  if (existing?.status === 'done' && !force) throw new Error('INTERPRET_EXISTS')
  return enqueue(kind === 'digest' ? 'make_digest' : 'paper_deepread', { refId: paperId, trigger })
}

// 任务注册（模块顶层；bootstrap.ts side-effect import）
registerTask({ type: 'paper_fetch', priority: 10, singleton: true, maxRetries: 1 }, paperFetchRunner)
registerTask({ type: 'make_digest', priority: 10, singleton: true, maxRetries: 1 }, makeDigestRunner)
registerTask({ type: 'paper_deepread', priority: 5, singleton: true, maxRetries: 0 }, paperDeepreadRunner)
