import { logWarn } from '../logger'
// 科普解读（260929 抓取三页签阅读改造）：science_fetch 扩展为完整幂等管道——抓全文 → en 术语表+
// 逐章翻译（产物 kind=translation 升格「原文（中文版）」载体）→ 概念提取建链（en 用术语表零调用 /
// zh 轻量单调用，LLM 未配置或失败静默跳过不阻 ready）→ 置 ready → embed_science。
// 导读卡/精读版改按需（共用 interpret.ts 生成器）。light 轻加工 / lecture 精讲退役。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, nowIso, userDataDir } from '../../db/db'
import { chatCompletion } from '../../ai/llm'
import { isLlmConfigured } from '../../ai/services'
import { mdWrite } from '../files'
import { toSimplified } from '../t2s'
import { registerTask, enqueue } from './queue'
import type { TaskContext } from './queue'
import { tokensSince } from './budget'
import { wrapMaterial } from './guardrails'
import { upsertInterpretation } from './papers'
import { generateDeepreadFor, generateDigestFor, hasTranslation, type InterpOwner } from './interpret'
import { ensureScienceFulltext, getScienceArticle, linkConcepts, mergeScienceConcepts, readScienceFulltext } from './science'
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

/** 简中全文守卫（管道保证 ready 后才可生成） */
function requireScienceFulltext(articleId: number): string {
  const txt = readScienceFulltext(articleId)
  if (txt && txt.length >= 200) return txt
  throw new Error('中文原文未就绪（请先重试抓取）')
}

function headOf(
  article: ScienceArticleRow,
  label: string,
  glossary?: { en: string; zh: string }[]
): string {
  const authors = article.authors.length ? ` ｜ ${article.authors.slice(0, 5).join(', ')}` : ''
  const date = article.date ?? (article.year != null ? String(article.year) : '')
  let head = `# ${label}：${toSimplified(article.title)}\n\n> 来源：${article.url}${authors}${date ? ` ｜ ${date}` : ''}`
  if (glossary && glossary.length > 0) {
    head += `\n\n## 术语表\n\n${glossary.map((g) => `- ${g.en} → ${toSimplified(g.zh)}`).join('\n')}\n`
  }
  return head
}

// ---------- 原文中文版翻译（en；术语表先行 + 逐章翻译，kind=translation） ----------

function glossaryOf(article: ScienceArticleRow): { en: string; zh: string }[] {
  return article.glossary ?? []
}

async function runScienceTranslate(article: ScienceArticleRow, ctx: TaskContext): Promise<void> {
  const delta = tokenTracker('agent:s-translate', ctx)
  const text = requireScienceFulltext(article.id)
  const chunks = chunkText(text)
  if (chunks.length === 0) throw new Error('全文为空')

  // ① 术语表先行（已有则复用，保证全文一致定译）
  let glossary = glossaryOf(article)
  if (glossary.length === 0) {
    ensureAlive(ctx)
    ctx.progress('提取术语表…')
    const res = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: `从以下科普文章材料中提取需要统一翻译的英文术语（概念、方法名、缩写、人名系统等），给出全文统一的简体中文定译。10-30 条，仅输出 JSON：{"glossary":[{"en":"原文","zh":"定译"}]}，不要其他文字。\n\n${wrapMaterial('文章材料', text.slice(0, GLOSSARY_INPUT_MAX))}`
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
        .map((g) => ({ en: g.en, zh: toSimplified(g.zh) }))
        .slice(0, 40)
    } catch {
      logWarn('agent', `[agent:s-translate] 《${article.title}》术语表生成失败，直接翻译`)
    }
    if (glossary.length > 0) {
      getDb()
        .prepare('UPDATE science_articles SET glossary = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(glossary), nowIso(), article.id)
    }
  }

  // ② 逐章翻译（术语表注入 system；`## 第 N 章` 幂等续跑）
  const rel = `md/interpretations/sa-${article.id}-translate.md`
  const abs = join(userDataDir(), rel)
  let md = existsSync(abs) ? readFileSync(abs, 'utf-8') : ''
  if (!md) md = headOf(article, '原文（中文）', glossary.length > 0 ? glossary : undefined)
  const done = (md.match(/^## 第 \d+ 章/gm) ?? []).length
  const glossaryJson = glossary.length ? JSON.stringify(glossary) : ''
  for (let i = done; i < chunks.length; i++) {
    ensureAlive(ctx)
    ctx.progress(`翻译第 ${i + 1}/${chunks.length} 部分…`)
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
          content: `请将下面科普文章《${article.title}》的第 ${i + 1}/${chunks.length} 部分翻译成简体中文（全文使用简体字、不要出现繁体字；通俗流畅，术语与全文统一；该部分可能从章节中间开始）。仅输出译文 Markdown，不要原文、不要解释。\n\n${wrapMaterial(`文章第 ${i + 1} 部分`, chunks[i])}`
        }
      ],
      temperature: 0.2,
      scene: 'agent:s-translate',
      signal: ctx.signal
    })
    delta()
    md += `\n## 第 ${i + 1} 章\n\n${toSimplified(res.content.trim())}\n`
    mdWrite(rel, md)
  }
  upsertInterpretation('science_article', article.id, 'translation', rel, 0)
  // 译文定译术语即概念词（零额外调用），合并建链
  mergeScienceConcepts(article.id, glossary.map((g) => g.zh))
  linkConcepts(article.id)
}

// ---------- zh 概念提取（轻量单调用；未配置/失败静默跳过，不阻 ready） ----------

async function extractConceptsZh(article: ScienceArticleRow, ctx: TaskContext): Promise<void> {
  if (!isLlmConfigured()) return
  const text = requireScienceFulltext(article.id)
  try {
    const delta = tokenTracker('agent:s-concepts', ctx)
    ensureAlive(ctx)
    ctx.progress('提取概念词…')
    const res = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: `从下面这篇简体中文科普文章中提取值得建词条/查词条的核心概念名（学科概念、理论、方法、专有名词），3-10 个、宁缺毋滥，全文简体中文。仅输出 JSON：{"concepts":["概念"]}，不要其他文字。\n\n${wrapMaterial('文章材料', text.slice(0, GLOSSARY_INPUT_MAX))}`
        }
      ],
      temperature: 0.2,
      jsonMode: true,
      scene: 'agent:s-concepts',
      signal: ctx.signal
    })
    delta()
    const cleaned = res.content.replace(/```(?:json)?/g, '').trim()
    const parsed = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1)) as {
      concepts?: unknown
    }
    const terms = Array.isArray(parsed.concepts)
      ? parsed.concepts.filter((x): x is string => typeof x === 'string').map((x) => toSimplified(x)).slice(0, 10)
      : []
    mergeScienceConcepts(article.id, terms)
  } catch (e) {
    logWarn('agent', `[agent:s-fetch] 《${article.title}》概念提取失败（跳过建链）：${(e as Error).message}`)
  }
}

// ---------- science_fetch 管道（幂等：抓缺 → 译缺/概念建链 → ready → embed） ----------

function scienceOwner(article: ScienceArticleRow): InterpOwner {
  return {
    ownerType: 'science_article',
    ownerId: article.id,
    title: toSimplified(article.title),
    authors: article.authors,
    url: article.url,
    dateText: article.date ?? (article.year != null ? String(article.year) : ''),
    filePrefix: `sa-${article.id}`,
    tags: article.tags
  }
}

async function scienceFetchRunner(ctx: TaskContext): Promise<void> {
  const article = getScienceArticle(ctx.refId ?? 0)
  if (!article) throw new Error('NOT_FOUND')
  ctx.progress('抓取全文中…')
  await ensureScienceFulltext(article)
  const fresh = getScienceArticle(article.id)
  if (!fresh) throw new Error('NOT_FOUND')
  const txt = readScienceFulltext(fresh.id)
  if (!txt || txt.length < 200) throw new Error('全文抓取失败（缓存缺失）')
  if (fresh.language === 'en') {
    if (!hasTranslation('science_article', fresh.id)) {
      if (!isLlmConfigured()) throw new Error('LLM 未配置，无法翻译为中文')
      await runScienceTranslate(fresh, ctx)
    }
  } else {
    await extractConceptsZh(fresh, ctx)
    linkConcepts(fresh.id)
  }
  getDb()
    .prepare("UPDATE science_articles SET status = 'ready', updated_at = ? WHERE id = ?")
    .run(nowIso(), fresh.id)
  // 完成尾挂语义索引 + 相关推荐（未启用/不可达时 runner 内静默跳过）
  enqueue('embed_science', { refId: fresh.id, trigger: 'auto' })
}

// ---------- 导读卡 / 精读版 runners（按需，共用 interpret.ts 生成器） ----------

async function scienceDigestRunner(ctx: TaskContext): Promise<void> {
  const article = getScienceArticle(ctx.refId ?? 0)
  if (!article) throw new Error('NOT_FOUND')
  if (!isLlmConfigured()) throw new Error('LLM 未配置')
  await generateDigestFor(scienceOwner(article), requireScienceFulltext(article.id), ctx, 'agent:s-digest')
}

async function scienceDeepreadRunner(ctx: TaskContext): Promise<void> {
  const article = getScienceArticle(ctx.refId ?? 0)
  if (!article) throw new Error('NOT_FOUND')
  if (!isLlmConfigured()) throw new Error('LLM 未配置')
  await generateDeepreadFor(scienceOwner(article), requireScienceFulltext(article.id), ctx, 'agent:s-deepread')
}

// ---------- 入口与注册 ----------

export type ScienceInterpretKind = 'digest' | 'deepread'

/** 按需触发；已有 running 抛错；已有 done 且未 force 抛 INTERPRET_EXISTS（渲染层转确认） */
export function runScienceInterpret(articleId: number, kind: ScienceInterpretKind, force = false): number {
  const existing = getDb()
    .prepare('SELECT id, status FROM interpretations WHERE owner_type = ? AND owner_id = ? AND kind = ?')
    .get('science_article', articleId, kind) as { id: number; status: string } | undefined
  if (existing?.status === 'running') throw new Error('该解读任务正在进行中')
  if (existing?.status === 'done' && !force) throw new Error('INTERPRET_EXISTS')
  return enqueue(kind === 'digest' ? 'science_digest' : 'science_deepread', { refId: articleId, trigger: 'manual' })
}

// 任务注册（模块顶层；bootstrap.ts side-effect import）
registerTask({ type: 'science_fetch', priority: 10, singleton: true, maxRetries: 1 }, scienceFetchRunner)
registerTask({ type: 'science_digest', priority: 10, singleton: true, maxRetries: 1 }, scienceDigestRunner)
registerTask({ type: 'science_deepread', priority: 5, singleton: true, maxRetries: 0 }, scienceDeepreadRunner)
