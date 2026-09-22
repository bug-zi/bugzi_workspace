// 科普解读（超级工作台 2.0 批次D spec §4）：英文全文解读（术语表先行 + 逐章翻译，kind=translation）、
// 中文轻加工（逐块 JSON {md, concepts} 加注版全文——结构导航 + 术语括注 + wiki:// 概念内链，
// 硬约束不删减原文信息点，kind=light）、精讲（按需，kind=lecture）。
// interpret.ts 逐块落盘/幂等续跑模式照搬（零回归风险，不重构 paper 路径）；产物完成尾 linkConcepts 建链。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, nowIso, userDataDir } from '../../db/db'
import { chatCompletion } from '../../ai/llm'
import { isLlmConfigured } from '../../ai/services'
import { mdWrite } from '../files'
import { registerTask, enqueue } from './queue'
import type { TaskContext } from './queue'
import { tokensSince } from './budget'
import { wrapMaterial } from './guardrails'
import { upsertInterpretation } from './papers'
import { ensureScienceFulltext, getScienceArticle, linkConcepts, mergeScienceConcepts } from './science'
import type { ScienceArticleRow } from '../../../src/shared/types'

const CHUNK_SIZE = 10000
const MAX_CHUNKS = 20
const GLOSSARY_INPUT_MAX = 40000

function ensureAlive(ctx: TaskContext): void {
  if (ctx.signal.aborted) throw new Error('已取消')
}

/** 场景 token 差值累加器（interpret.ts 同款） */
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

/** 段落边界切块（interpret.ts 同款） */
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

/** 全文源：全文就绪用全文；meta_only 退化为摘要（卡头注明），两者皆空才抛错 */
function sourceOf(article: ScienceArticleRow): { text: string; metaOnly: boolean } {
  const p = join(userDataDir(), 'science', `${article.id}.txt`)
  if (article.status === 'ready' && existsSync(p)) {
    const txt = readFileSync(p, 'utf-8')
    if (txt.length >= 200) return { text: txt, metaOnly: false }
  }
  if (article.summary.trim()) return { text: article.summary, metaOnly: true }
  throw new Error('全文与摘要均缺失，无法生成（可「重试抓取」后再试）')
}

function metaOnlyHead(metaOnly: boolean): string {
  return metaOnly ? '\n> ⚠ 全文缺失，以下基于摘要生成（可在阅读视图「重试抓取」后重新生成）\n' : '\n'
}

function headOf(article: ScienceArticleRow, label: string, metaOnly: boolean, glossary?: { en: string; zh: string }[]): string {
  const authors = article.authors.length ? ` ｜ ${article.authors.slice(0, 5).join(', ')}` : ''
  const date = article.date ?? (article.year != null ? String(article.year) : '')
  let head = `# ${label}：${article.title}\n\n> 来源：${article.url}${authors}${date ? ` ｜ ${date}` : ''}`
  head += metaOnlyHead(metaOnly)
  if (glossary && glossary.length > 0) {
    head += `\n## 术语表\n\n${glossary.map((g) => `- ${g.en} → ${g.zh}`).join('\n')}\n`
  }
  return head
}

function sectionCount(md: string, pattern: RegExp): number {
  return (md.match(pattern) ?? []).length
}

function glossaryOf(article: ScienceArticleRow): { en: string; zh: string }[] {
  return article.glossary ?? []
}

function relPathOf(articleId: number, name: string): string {
  return `md/interpretations/${name}`
}

// ---------- 英文全文解读（术语表先行 + 逐章翻译） ----------

async function runScienceTranslate(article: ScienceArticleRow, ctx: TaskContext): Promise<void> {
  const delta = tokenTracker('agent:s-translate', ctx)
  const { text, metaOnly } = sourceOf(article)
  const chunks = metaOnly ? [] : chunkText(text)
  const rel = relPathOf(article.id, `sa-${article.id}-translate.md`)
  const abs = join(userDataDir(), rel)

  if (metaOnly) {
    // 摘要退化版（单调用）
    ensureAlive(ctx)
    const res = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: `你是科普解读助手。以下为一篇英文科普文章的摘要（全文缺失），请用中文完整转述其内容与要点，不要补充原文之外的信息。只输出 Markdown 正文。\n\n${wrapMaterial('文章摘要', text)}`
        }
      ],
      temperature: 0.3,
      scene: 'agent:s-translate',
      signal: ctx.signal
    })
    delta()
    mdWrite(rel, headOf(article, '解读', true) + '\n' + res.content.trim() + '\n')
    upsertInterpretation('science_article', article.id, 'translation', rel, 0)
    mergeScienceConcepts(article.id, [])
    linkConcepts(article.id)
    return
  }

  // ① 术语表先行（已有则复用，保证全文一致定译）
  let glossary = glossaryOf(article)
  if (glossary.length === 0) {
    ensureAlive(ctx)
    const res = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: `从以下科普文章材料中提取需要统一翻译的英文术语（概念、方法名、缩写、人名系统等），给出全文统一的中文定译。10-30 条，仅输出 JSON：{"glossary":[{"en":"原文","zh":"定译"}]}，不要其他文字。\n\n${wrapMaterial('文章材料', text.slice(0, GLOSSARY_INPUT_MAX))}`
        }
      ],
      temperature: 0.2,
      jsonMode: true,
      scene: 'agent:s-translate',
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
      console.warn(`[agent:s-translate] 《${article.title}》术语表生成失败，直接翻译`)
    }
    if (glossary.length > 0) {
      getDb()
        .prepare('UPDATE science_articles SET glossary = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(glossary), nowIso(), article.id)
    }
  }

  // ② 逐章翻译（术语表注入 system；`## 第 N 章` 幂等续跑）
  let md = existsSync(abs) ? readFileSync(abs, 'utf-8') : ''
  if (!md) md = headOf(article, '解读', false, glossary.length > 0 ? glossary : undefined)
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
                content: `你是科普文章译者。以下术语表是全文统一约定，翻译时必须采用其中的定译：${glossaryJson}`
              }
            ]
          : []),
        {
          role: 'user',
          content: `请将下面科普文章《${article.title}》的第 ${i + 1}/${chunks.length} 部分翻译成中文（通俗流畅，术语与全文统一；该部分可能从章节中间开始）。仅输出译文 Markdown，不要原文、不要解释。\n\n${wrapMaterial(`文章第 ${i + 1} 部分`, chunks[i])}`
        }
      ],
      temperature: 0.2,
      scene: 'agent:s-translate',
      signal: ctx.signal
    })
    delta()
    md += `\n## 第 ${i + 1} 章\n\n${res.content.trim()}\n`
    mdWrite(rel, md)
  }
  upsertInterpretation('science_article', article.id, 'translation', rel, 0)
  mergeScienceConcepts(article.id, glossary.map((g) => g.zh))
  linkConcepts(article.id)
}

// ---------- 中文轻加工（逐块 JSON 加注版全文，不删减信息点） ----------

interface LightChunk {
  md: string
  concepts: string[]
}

function parseLightChunk(raw: string): LightChunk {
  const cleaned = raw.replace(/```(?:json)?/g, '')
  const s = cleaned.indexOf('{')
  const e = cleaned.lastIndexOf('}')
  if (s < 0 || e <= s) throw new Error('LLM 未返回 JSON')
  const parsed = JSON.parse(cleaned.slice(s, e + 1)) as { md?: unknown; concepts?: unknown }
  const md = typeof parsed.md === 'string' ? parsed.md.trim() : ''
  if (!md) throw new Error('LLM 未返回加注正文')
  const concepts = Array.isArray(parsed.concepts)
    ? parsed.concepts.filter((x): x is string => typeof x === 'string')
    : []
  return { md, concepts }
}

async function runScienceLight(article: ScienceArticleRow, ctx: TaskContext): Promise<void> {
  const delta = tokenTracker('agent:s-light', ctx)
  const { text, metaOnly } = sourceOf(article)

  if (metaOnly) {
    ensureAlive(ctx)
    const res = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: `你是中文科普编辑。以下为一篇科普文章的摘要（全文缺失），请在保留其全部信息点的前提下整理为结构清晰、要点提示齐全的加注版（不为摘要外的内容杜撰）。同时给出值得建词条/查词条的核心概念名（无则空数组）。仅输出 JSON：{"md":"加注版 Markdown","concepts":["术语"]}。\n\n${wrapMaterial('文章摘要', text)}`
        }
      ],
      temperature: 0.3,
      jsonMode: true,
      scene: 'agent:s-light',
      signal: ctx.signal
    })
    delta()
    const parsed = parseLightChunk(res.content)
    const rel = relPathOf(article.id, `sa-${article.id}-light.md`)
    mdWrite(rel, headOf(article, '加注版', true) + '\n' + parsed.md + '\n')
    upsertInterpretation('science_article', article.id, 'light', rel, 0)
    mergeScienceConcepts(article.id, parsed.concepts)
    linkConcepts(article.id)
    return
  }

  const chunks = chunkText(text)
  if (chunks.length === 0) throw new Error('正文为空')
  const rel = relPathOf(article.id, `sa-${article.id}-light.md`)
  const abs = join(userDataDir(), rel)
  let md = existsSync(abs) ? readFileSync(abs, 'utf-8') : ''
  if (!md) md = headOf(article, '加注版', false)
  const done = sectionCount(md, /^## 第 \d+ 部分/gm)
  const allConcepts: string[] = []
  for (let i = done; i < chunks.length; i++) {
    ensureAlive(ctx)
    const res = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: `你是中文科普编辑。下面是科普文章《${article.title}》第 ${i + 1}/${chunks.length} 部分的原文（可能从章节中间开始）。请输出该部分的「完整加注版」，要求：
1. **不删减任何原文信息点**（不概括、不压缩、不省略，科普不压缩红线），可调整语序使表达更顺。
2. 结构导航：为内容加小节标题（用 ### 三级标题）与要点提示，层级清晰。
3. 术语加注：专业术语首次出现处以括注给出一句简释。
4. 概念内链：确定是概念/术语的词改为 Markdown 链接 [术语](wiki://术语)（URL 部分就是术语本身，不要编码），每部分最多标注 10 处，只标真正的概念词，宁缺毋滥。
5. 仅输出 JSON：{"md":"该部分加注版全文","concepts":["该部分值得建词条/查词条的核心概念名，最多 10 个"]}\n\n${wrapMaterial(`文章第 ${i + 1} 部分`, chunks[i])}`
        }
      ],
      temperature: 0.2,
      jsonMode: true,
      scene: 'agent:s-light',
      signal: ctx.signal
    })
    delta()
    const parsed = parseLightChunk(res.content)
    md += `\n## 第 ${i + 1} 部分\n\n${parsed.md}\n`
    mdWrite(rel, md)
    allConcepts.push(...parsed.concepts)
  }
  upsertInterpretation('science_article', article.id, 'light', rel, 0)
  mergeScienceConcepts(article.id, allConcepts)
  linkConcepts(article.id)
}

// ---------- 精讲（按需，双语言可用） ----------

async function runScienceLecture(article: ScienceArticleRow, ctx: TaskContext): Promise<void> {
  const delta = tokenTracker('agent:s-lecture', ctx)
  const { text, metaOnly } = sourceOf(article)
  const chunks = metaOnly ? [text] : chunkText(text)
  const rel = relPathOf(article.id, `sa-${article.id}-lecture.md`)
  const abs = join(userDataDir(), rel)
  let md = existsSync(abs) ? readFileSync(abs, 'utf-8') : ''
  if (!md) md = headOf(article, '精讲', metaOnly) + '\n> 逐部分中文精讲：重述讲解、解释论证与直觉、关键术语保留\n'
  const done = sectionCount(md, /^## 第 \d+ 部分/gm)
  for (let i = done; i < chunks.length; i++) {
    ensureAlive(ctx)
    const res = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: `你是科普精讲老师。以下是科普文章《${article.title}》的第 ${i + 1}/${chunks.length} 部分（可能从章节中间开始）。用中文重述讲解这部分内容：解释概念与论证思路，给出直觉解释与必要例子；与其他部分衔接处以「（承前）」「（后文将）」轻量带过。只输出 Markdown 正文（不要一级标题，不要开场白）。\n\n${wrapMaterial(`文章第 ${i + 1} 部分`, chunks[i])}`
        }
      ],
      temperature: 0.3,
      scene: 'agent:s-lecture',
      signal: ctx.signal
    })
    delta()
    md += `\n## 第 ${i + 1} 部分\n\n${res.content.trim()}\n`
    mdWrite(rel, md)
  }
  upsertInterpretation('science_article', article.id, 'lecture', rel, 0)
}

// ---------- 入口与注册 ----------

export type ScienceInterpretKind = 'translate' | 'light' | 'lecture'

const KIND_TASK: Record<ScienceInterpretKind, string> = {
  translate: 'science_translate',
  light: 'science_light',
  lecture: 'science_lecture'
}
const KIND_DB: Record<ScienceInterpretKind, 'translation' | 'light' | 'lecture'> = {
  translate: 'translation',
  light: 'light',
  lecture: 'lecture'
}

/** 按需触发；已有 running 抛错；已有 done 且未 force 抛 INTERPRET_EXISTS（渲染层转确认） */
export function runScienceInterpret(
  articleId: number,
  kind: ScienceInterpretKind,
  force = false,
  trigger: 'manual' | 'auto' = 'manual'
): number {
  const existing = getDb()
    .prepare('SELECT id, status FROM interpretations WHERE owner_type = ? AND owner_id = ? AND kind = ?')
    .get('science_article', articleId, KIND_DB[kind]) as { id: number; status: string } | undefined
  if (existing?.status === 'running') throw new Error('该解读任务正在进行中')
  if (existing?.status === 'done' && !force) throw new Error('INTERPRET_EXISTS')
  return enqueue(KIND_TASK[kind], { refId: articleId, trigger })
}

async function scienceRunnerOf(kind: ScienceInterpretKind, ctx: TaskContext): Promise<void> {
  const article = getScienceArticle(ctx.refId ?? 0)
  if (!article) throw new Error('NOT_FOUND')
  if (!isLlmConfigured()) throw new Error('LLM 未配置')
  await ensureScienceFulltext(article)
  const fresh = getScienceArticle(article.id) ?? article
  if (kind === 'translate') await runScienceTranslate(fresh, ctx)
  else if (kind === 'light') await runScienceLight(fresh, ctx)
  else await runScienceLecture(fresh, ctx)
  // 完成尾挂语义索引 + 相关推荐（批次F：embed_science；未启用/不可达时 runner 内静默跳过）
  enqueue('embed_science', { refId: article.id, trigger: 'auto' })
}

// 任务注册（模块顶层；bootstrap.ts side-effect import）
registerTask({ type: 'science_translate', priority: 10, singleton: true, maxRetries: 1 }, (ctx) =>
  scienceRunnerOf('translate', ctx)
)
registerTask({ type: 'science_light', priority: 10, singleton: true, maxRetries: 1 }, (ctx) =>
  scienceRunnerOf('light', ctx)
)
registerTask({ type: 'science_lecture', priority: 5, singleton: true, maxRetries: 0 }, (ctx) =>
  scienceRunnerOf('lecture', ctx)
)
