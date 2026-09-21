// 解读产物（超级工作台 2.0 批次B spec §3）：导读卡（终选后自动）/ 精讲 / 精译（按需）。
// 长文逐章落盘、按章幂等续跑；token 记账走 llm_usage 场景差值；不注入个人画像（白名单默认全关）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, nowIso, userDataDir } from '../../db/db'
import { chatCompletion } from '../../ai/llm'
import { isLlmConfigured } from '../../ai/services'
import { mdWrite } from '../files'
import { registerTask } from './queue'
import { tokensSince } from './budget'
import { wrapMaterial } from './guardrails'
import {
  ensureFulltext,
  getPaper,
  readFulltext,
  upsertInterpretation,
  writeInterpretationMd
} from './papers'
import { enqueue } from './queue'
import type { TaskContext } from './queue'
import type { PaperRow } from '../../../src/shared/types'

const DIGEST_INPUT_MAX = 60000
const LECTURE_INPUT_MAX = 40000
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

function requireFulltextOrThrow(paper: PaperRow): string {
  const txt = readFulltext(paper.id)
  if (txt && txt.length >= 200) return txt
  throw new Error('全文缺失，无法生成（可手动传 PDF 后重试）')
}

function glossaryOf(paper: PaperRow): { en: string; zh: string }[] {
  try {
    const p = JSON.parse(String(paper.glossary ?? '[]'))
    return Array.isArray(p) ? p.filter((x): x is { en: string; zh: string } => !!x?.en && !!x?.zh) : []
  } catch {
    return []
  }
}

// ---------- 导读卡 ----------

async function generateDigest(paper: PaperRow, ctx: TaskContext): Promise<string> {
  const delta = tokenTracker('agent:digest', ctx)
  const metaOnly = paper.status !== 'ready' || !readFulltext(paper.id)
  const source = metaOnly
    ? `（全文缺失，以下为摘要）\n${paper.summary}`
    : `（全文）\n${(readFulltext(paper.id) ?? '').slice(0, DIGEST_INPUT_MAX)}`
  ensureAlive(ctx)
  const res = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: `你是论文导读助手。请为下面这篇论文生成中文导读卡，严格按以下骨架输出 Markdown（六个二级标题缺一不可，总长 500-900 字）：

# 定位
# 它回答什么问题
# 用什么方法
# 得到什么结果
# 局限与边界
# 与你何干

「与你何干」一节请结合研究领域关键词谈这篇工作对该领域读者的适用性与实际价值，不要编造读者个人信息。
只输出 Markdown 正文，不要开场白。

领域关键词：${paper.tags.join('、') || '无'}
论文标题：${paper.title}

${wrapMaterial('论文材料', source)}`
      }
    ],
    temperature: 0.3,
    scene: 'agent:digest',
    signal: ctx.signal
  })
  delta()
  ensureAlive(ctx)
  let md = res.content.trim()
  if (!md) throw new Error('LLM 未返回内容')
  const head = `# 导读：${paper.title}\n\n> 来源：${paper.url}${paper.authors.length ? ` ｜ ${paper.authors.slice(0, 5).join(', ')}` : ''}${paper.year ? ` ｜ ${paper.year}` : ''}\n${metaOnly ? '> ⚠ 基于摘要生成（全文缺失，可手动传 PDF 后重生成）\n' : ''}\n`
  // 剥掉模型可能自带的一级标题行，统一用标准头
  md = md.replace(/^#\s+.*\n/, '').trim()
  const rel = writeInterpretationMd(`${paper.id}-digest.md`, head + md + '\n')
  upsertInterpretation('paper', paper.id, 'digest', rel, 0)
  getDb().prepare('UPDATE papers SET digest_md = ?, updated_at = ? WHERE id = ?').run(rel, nowIso(), paper.id)
  return rel
}

// ---------- 精讲 / 精译（逐章 + 续跑） ----------

function sectionCount(md: string, pattern: RegExp): number {
  return (md.match(pattern) ?? []).length
}

async function runLecture(paper: PaperRow, ctx: TaskContext): Promise<string> {
  const delta = tokenTracker('agent:lecture', ctx)
  const text = requireFulltextOrThrow(paper)
  const chunks = chunkText(text)
  if (chunks.length === 0) throw new Error('全文为空')
  const rel = `md/interpretations/${paper.id}-lecture.md`
  const abs = join(userDataDir(), rel)
  let md = existsSync(abs) ? readFileSync(abs, 'utf-8') : ''
  if (!md) {
    md = `# 精讲：${paper.title}\n\n> 来源：${paper.url} ｜ 逐章中文重述讲解，保留关键术语并给出直觉解释\n\n`
  }
  const done = sectionCount(md, /^## 第 \d+ 部分/gm)
  for (let i = done; i < chunks.length; i++) {
    ensureAlive(ctx)
    const res = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: `你是论文精讲老师。以下是论文《${paper.title}》的第 ${i + 1}/${chunks.length} 部分（可能从章节中间开始）。用中文重述讲解这部分内容：保留关键术语（英文原词可保留），解释方法与论证思路，给出直觉解释与必要例子；与论文其他部分衔接处以「（承前）」「（后文将）」轻量带过。只输出 Markdown 正文（不要一级标题，不要「好的」之类开场白）。\n\n${wrapMaterial(`论文第 ${i + 1} 部分`, chunks[i])}`
        }
      ],
      temperature: 0.3,
      scene: 'agent:lecture',
      signal: ctx.signal
    })
    delta()
    md += `## 第 ${i + 1} 部分\n\n${res.content.trim()}\n\n`
    mdWrite(rel, md)
  }
  upsertInterpretation('paper', paper.id, 'lecture', rel, 0)
  return rel
}

async function runTranslate(paper: PaperRow, ctx: TaskContext): Promise<string> {
  const delta = tokenTracker('agent:translate', ctx)
  const text = requireFulltextOrThrow(paper)
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
          content: `从以下论文材料中提取需要统一翻译的英文术语（方法名、缩写、专业概念、人名系统等），给出全文统一的中文定译。10-30 条，仅输出 JSON：{"glossary":[{"en":"原文","zh":"定译"}]}，不要其他文字。\n\n${wrapMaterial('论文材料', text.slice(0, LECTURE_INPUT_MAX))}`
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
      console.warn(`[agent:translate] 《${paper.title}》术语表生成失败，直接翻译`)
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
    md = `# 精译：${paper.title}\n\n> 来源：${paper.url}${glossary.length ? `\n\n## 术语表\n\n${table}\n` : '\n'}`
  }
  const done = sectionCount(md, /^## 第 \d+ 章/gm)
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

// ---------- 入口与注册 ----------

export type InterpretKind = 'digest' | 'lecture' | 'translate'

/** 按需触发生成；已有 running 抛错；已有 done 且未 force 抛「需确认」 */
export async function runInterpret(paperId: number, kind: InterpretKind, force = false, trigger: 'manual' | 'auto' = 'manual'): Promise<number> {
  const d = getDb()
  const existing = d
    .prepare('SELECT id, status FROM interpretations WHERE owner_type = ? AND owner_id = ? AND kind = ?')
    .get('paper', paperId, kind === 'digest' ? 'digest' : kind === 'lecture' ? 'lecture' : 'translation') as
    | { id: number; status: string }
    | undefined
  if (existing?.status === 'running') throw new Error('该解读任务正在进行中')
  if (existing?.status === 'done' && !force) throw new Error('INTERPRET_EXISTS')
  return enqueue(kind === 'digest' ? 'make_digest' : kind, { refId: paperId, trigger })
}

async function makeDigestRunner(ctx: TaskContext): Promise<void> {
  const paper = getPaper(ctx.refId ?? 0)
  if (!paper) throw new Error('NOT_FOUND')
  if (!isLlmConfigured()) throw new Error('LLM 未配置')
  await ensureFulltext(paper)
  const fresh = getPaper(paper.id) ?? paper
  await generateDigest(fresh, ctx)
  // 全文就绪后自动索引 + 相关推荐
  enqueue('embed_index', { refId: paper.id, trigger: 'auto' })
}

async function lectureRunner(ctx: TaskContext): Promise<void> {
  const paper = getPaper(ctx.refId ?? 0)
  if (!paper) throw new Error('NOT_FOUND')
  if (!isLlmConfigured()) throw new Error('LLM 未配置')
  await ensureFulltext(paper)
  await runLecture(getPaper(paper.id) ?? paper, ctx)
}

async function translateRunner(ctx: TaskContext): Promise<void> {
  const paper = getPaper(ctx.refId ?? 0)
  if (!paper) throw new Error('NOT_FOUND')
  if (!isLlmConfigured()) throw new Error('LLM 未配置')
  await ensureFulltext(paper)
  await runTranslate(getPaper(paper.id) ?? paper, ctx)
}

// 任务注册（模块顶层；bootstrap.ts side-effect import）
registerTask({ type: 'make_digest', priority: 10, singleton: true, maxRetries: 1 }, makeDigestRunner)
registerTask({ type: 'lecture', priority: 5, singleton: true, maxRetries: 0 }, lectureRunner)
registerTask({ type: 'translate', priority: 5, singleton: true, maxRetries: 0 }, translateRunner)
