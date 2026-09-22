// 深读线海选巡检（超级工作台 2.0 批次B spec §1）：领域 → arXiv + MCP 双渠道 →
// 海选 LLM（jsonMode 元信息+一句话推荐理由，无结果合法）→ url 白名单防编造 +
// url_hash/embedding 近重复去重 → discover_items。
import { createHash } from 'node:crypto'
import { getDb, nowIso } from '../../db/db'
import { chatCompletion } from '../../ai/llm'
import { isLlmConfigured } from '../../ai/services'
import { registerTask } from './queue'
import { collectionAllowed } from './budget'
import { wrapMaterial } from './guardrails'
import { searchArxiv } from './sources/arxiv'
import { searchViaMcp } from './sources/mcpSearch'
import { embedTexts, storeEmbedding, getEmbeddingConfig } from './embedding'
import type { TaskContext } from './queue'

export function urlHash(url: string): string {
  return createHash('sha1').update(url.trim().replace(/\/+$/, '')).digest('hex')
}

interface Candidate {
  title: string
  authors: string[]
  year: number | null
  date: string | null
  summary: string
  url: string
  source: string
}

export interface Selection {
  title: string
  authors?: string[]
  year?: number | null
  summary?: string
  tags?: string[]
  language?: string
  length_est?: string
  url: string
  source?: string
  reason?: string
}

/** 容错 JSON 提取：剥代码围栏后取首 { 到尾 }（collectScience 复用） */
export function extractJson(raw: string): Record<string, unknown> {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()
  const s = cleaned.indexOf('{')
  const e = cleaned.lastIndexOf('}')
  if (s < 0 || e <= s) throw new Error('LLM 未返回 JSON')
  return JSON.parse(cleaned.slice(s, e + 1)) as Record<string, unknown>
}

function urlWhitelist(candidates: Candidate[]): Set<string> {
  const set = new Set<string>()
  for (const c of candidates) {
    set.add(c.url.trim().replace(/\/+$/, ''))
    try {
      set.add(new URL(c.url).origin + new URL(c.url).pathname.replace(/\/+$/, ''))
    } catch {
      /* 非法 url 跳过 */
    }
  }
  return set
}

export function matchesWhitelist(url: string, whitelist: Set<string>): boolean {
  const clean = url.trim().replace(/\/+$/, '')
  if (whitelist.has(clean)) return true
  try {
    const u = new URL(url)
    return whitelist.has(u.origin + u.pathname.replace(/\/+$/, ''))
  } catch {
    return false
  }
}

/** 候选 url（origin+path 归一键）→ 原始元信息：日期/渠道直接映射材料值，不经 LLM 转述防篡改 */
export function candidateMetaMap(candidates: Candidate[]): Map<string, { date: string | null; source: string }> {
  const map = new Map<string, { date: string | null; source: string }>()
  for (const c of candidates) {
    try {
      const u = new URL(c.url)
      map.set(u.origin + u.pathname.replace(/\/+$/, ''), { date: c.date, source: c.source })
    } catch {
      /* 非法 url 跳过 */
    }
  }
  return map
}

function lookupMeta(
  url: string,
  map: Map<string, { date: string | null; source: string }>
): { date: string | null; source: string } {
  try {
    const u = new URL(url)
    return map.get(u.origin + u.pathname.replace(/\/+$/, '')) ?? { date: null, source: '' }
  } catch {
    return { date: null, source: '' }
  }
}

/** 与发现箱既有向量近重复判定（> 0.92 视为重复）；embedding 不可用返回 false（降级放行） */
export async function isNearDuplicate(title: string, summary: string): Promise<boolean> {
  const cfg = getEmbeddingConfig()
  if (!cfg.enabled) return false
  try {
    const existing = getDb()
      .prepare("SELECT COUNT(*) AS n FROM embeddings WHERE entity_type = 'discover'")
      .get() as { n: number }
    if (existing.n === 0) return false
    const [vec] = await embedTexts([`${title}。${summary}`])
    const rows = getDb()
      .prepare("SELECT entity_id, vector FROM embeddings WHERE entity_type = 'discover'")
      .all() as { entity_id: number; vector: Uint8Array }[]
    const { cosine } = await import('./embedding')
    let dup = false
    for (const r of rows) {
      const f32 = new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength >> 2)
      if (cosine(vec, f32) > 0.92) {
        dup = true
        break
      }
    }
    return dup
  } catch {
    return false
  }
}

export async function runCollectDeep(domainId: number, ctx: TaskContext): Promise<void> {
  const domain = getDb()
    .prepare('SELECT * FROM agent_domains WHERE id = ?')
    .get(domainId) as { id: number; name: string; track: string; keywords: string } | undefined
  if (!domain) throw new Error('领域不存在（可能已被删除）')
  if (!isLlmConfigured()) throw new Error('LLM 未配置')
  if (!collectionAllowed()) {
    console.info(`[agent:collect] 领域「${domain.name}」超出每日预算，本轮跳过`)
    return
  }
  let keywords: string[] = []
  try {
    const p = JSON.parse(domain.keywords)
    if (Array.isArray(p)) keywords = p.filter((k): k is string => typeof k === 'string')
  } catch {
    /* 空 keywords */
  }
  if (keywords.length === 0) keywords = [domain.name]

  ctx.progress('双渠道检索中…')
  // 双渠道并行，单渠道失败留痕不炸
  const [arxivRes, mcpRes] = await Promise.allSettled([
    searchArxiv(keywords, ctx.signal),
    searchViaMcp(
      `${domain.name} ${keywords.join(' ')} 最新论文 research`,
      (m) => console.info(`[agent:collect] ${m}`),
      ctx.signal
    )
  ])
  const candidates: Candidate[] = []
  if (arxivRes.status === 'fulfilled') {
    for (const c of arxivRes.value) {
      candidates.push({
        title: c.title,
        authors: c.authors,
        year: c.year,
        date: c.date,
        summary: c.summary.slice(0, 600),
        url: c.url,
        source: 'arxiv'
      })
    }
  } else {
    console.warn(`[agent:collect] arXiv 渠道失败：${(arxivRes.reason as Error)?.message}`)
  }
  const mcpText = mcpRes.status === 'fulfilled' ? String(mcpRes.value) : ''
  if (mcpRes.status === 'rejected') {
    console.warn(`[agent:collect] MCP 搜索渠道失败：${(mcpRes.reason as Error)?.message}`)
  }
  if (candidates.length === 0 && !mcpText.trim()) {
    console.info(`[agent:collect] 领域「${domain.name}」本轮双渠道均无结果`)
    return
  }

  ensureAlive(ctx)
  ctx.progress('AI 海选筛选中…')
  const arxivJson = JSON.stringify(
    candidates.map((c) => ({ ...c, summary: c.summary.slice(0, 300) }))
  )
  const prompt = `你是研究文献遴选助手。领域：「${domain.name}」（职业发展深读线，关注学术论文）。

以下是两份检索资料（${candidates.length} 条 arXiv 结构化候选 + MCP 搜索原始结果）。请从中挑选最值得深读的论文，要求：
1. 最多 8 条，宁缺毋滥；没有合适结果就输出空数组，不要硬凑。
2. 每条输出：title（原题）、authors（数组）、year、summary（120 字内中文概括）、tags（1-3 个）、language、length_est（篇幅估计如「12 页」）、url（必须与资料原文完全一致，禁止编造或改写）、source（资料中标注的渠道标识）、reason（一句话中文推荐理由：与领域的相关性 + 价值）。
3. 仅输出 JSON 对象：{"items":[...]}，不要任何其他文字。

${wrapMaterial('arXiv 结构化候选', arxivJson)}

${mcpText.trim() ? wrapMaterial('MCP 搜索原始结果', mcpText.slice(0, 30000)) : ''}`
  const res = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    jsonMode: true,
    scene: 'agent:collect',
    signal: ctx.signal
  })
  ensureAlive(ctx)

  const whitelist = urlWhitelist(candidates)
  const metaMap = candidateMetaMap(candidates)
  let items: Selection[] = []
  try {
    const parsed = extractJson(res.content)
    items = Array.isArray(parsed.items) ? (parsed.items as Selection[]) : []
  } catch {
    // 重试一次：纯 JSON 指令
    const res2 = await chatCompletion({
      messages: [
        { role: 'user', content: `${prompt}\n\n注意：上一次输出不是合法 JSON。这次仅输出 {"items":[...]} 形式的合法 JSON，不要任何解释文字。` }
      ],
      temperature: 0,
      jsonMode: true,
      scene: 'agent:collect',
      signal: ctx.signal
    })
    items = (extractJson(res2.content).items as Selection[]) ?? []
  }

  const d = getDb()
  let added = 0
  for (const it of items) {
    if (!it.title?.trim() || !it.url?.trim()) continue
    if (!matchesWhitelist(it.url, whitelist)) {
      console.warn(`[agent:collect] 丢弃编造 url 候选：${it.title}`)
      continue
    }
    const hash = urlHash(it.url)
    const dup = d.prepare('SELECT id FROM discover_items WHERE url_hash = ?').get(hash)
    if (dup) continue
    if (await isNearDuplicate(it.title, it.summary ?? '')) {
      console.info(`[agent:collect] 近重复跳过：${it.title}`)
      continue
    }
    try {
      const now = nowIso()
      const meta = lookupMeta(it.url, metaMap)
      const r = d
        .prepare(
          "INSERT INTO discover_items (source_type, title, authors, year, date, summary, tags, language, length_est, url, source, reason, status, url_hash, domain_id, created_at) VALUES ('paper', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)"
        )
        .run(
          it.title.trim(),
          JSON.stringify((it.authors ?? []).slice(0, 12)),
          typeof it.year === 'number' ? it.year : null,
          meta.date,
          it.summary ?? '',
          JSON.stringify((it.tags ?? []).slice(0, 5)),
          it.language === 'zh' ? 'zh' : 'en',
          it.length_est ?? '',
          it.url.trim(),
          meta.source || it.source || 'arxiv',
          it.reason ?? '',
          hash,
          domainId,
          now
        )
      added++
      const vec = await embedDiscoverVector(it.title, it.summary ?? '')
      if (vec) storeEmbedding('discover', Number(r.lastInsertRowid), vec)
    } catch {
      /* UNIQUE 冲突等逐条忽略 */
    }
  }
  console.info(`[agent:collect] 领域「${domain.name}」海选完成：候选 ${candidates.length}，入选 ${items.length}，新增 ${added}`)
}

export async function embedDiscoverVector(title: string, summary: string): Promise<number[] | null> {
  const cfg = getEmbeddingConfig()
  if (!cfg.enabled) return null
  try {
    const [vec] = await embedTexts([`${title}。${summary}`])
    return vec
  } catch {
    return null
  }
}

function ensureAlive(ctx: TaskContext): void {
  if (ctx.signal.aborted) throw new Error('已取消')
}

// 任务注册（模块顶层；bootstrap.ts side-effect import）
registerTask({ type: 'collect_deep', priority: 10, singleton: true, maxRetries: 2 }, (ctx) =>
  runCollectDeep(ctx.refId ?? 0, ctx)
)
