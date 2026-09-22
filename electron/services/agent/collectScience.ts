// 科普线海选巡检（超级工作台 2.0 批次D spec §2）：领域 → MCP 渠道（渠道注册表留扩展点）→
// 海选 LLM（科普向遴选：排除学术论文/新闻稿/营销文，无结果合法）→ url 白名单防编造 +
// url_hash/embedding 近重复去重（复用 collectDeep 导出件，近重复判定跨线共享）→ discover_items
// （source_type='article'）。
import { getDb, nowIso } from '../../db/db'
import { chatCompletion } from '../../ai/llm'
import { isLlmConfigured } from '../../ai/services'
import { registerTask } from './queue'
import { collectionAllowed } from './budget'
import { wrapMaterial } from './guardrails'
import { searchViaMcp } from './sources/mcpSearch'
import { embedDiscoverVector, extractJson, isNearDuplicate, matchesWhitelist, urlHash, type Selection } from './collectDeep'
import type { TaskContext } from './queue'

interface Candidate {
  title: string
  url: string
  source: string
}

/** 科普海选输出项：LLM 可带 date（渠道原文含日期时），兜底 null */
interface ScienceSelection extends Selection {
  date?: string | null
}

/** 渠道注册点（总纲 §7 扩展点）：科普线后续新增渠道往本数组加，返回原始文本或结构化候选 */
const CHANNELS: ((keywords: string[], signal?: AbortSignal) => Promise<Candidate[]> | Promise<string>)[] = [
  async (keywords, signal) =>
    searchViaMcp(
      `${keywords.join(' ')} 科普 深入浅出 文章`,
      (m) => console.info(`[agent:collect:s] ${m}`),
      signal
    )
]

function ensureAlive(ctx: TaskContext): void {
  if (ctx.signal.aborted) throw new Error('已取消')
}

/** 从渠道原始文本抽取 url 白名单（防编造：origin+path 归一，同 collectDeep 口径） */
function whitelistFromText(text: string): Set<string> {
  const set = new Set<string>()
  for (const raw of text.match(/https?:\/\/[^\s"'<>）)\]]+/g) ?? []) {
    const clean = raw.replace(/[.,;:!?]+$/, '').replace(/\/+$/, '')
    set.add(clean)
    try {
      const u = new URL(clean)
      set.add(u.origin + u.pathname.replace(/\/+$/, ''))
    } catch {
      /* 非法 url 跳过 */
    }
  }
  return set
}

export async function runCollectScience(domainId: number, ctx: TaskContext): Promise<void> {
  const domain = getDb()
    .prepare('SELECT * FROM agent_domains WHERE id = ?')
    .get(domainId) as { id: number; name: string; track: string; keywords: string } | undefined
  if (!domain) throw new Error('领域不存在（可能已被删除）')
  if (!isLlmConfigured()) throw new Error('LLM 未配置')
  if (!collectionAllowed()) {
    console.info(`[agent:collect:s] 领域「${domain.name}」超出每日预算，本轮跳过`)
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

  ctx.progress('科普渠道检索中…')
  const channelTexts: string[] = []
  for (const channel of CHANNELS) {
    try {
      const out = await channel(keywords, ctx.signal)
      const text = String(out)
      if (text.trim()) channelTexts.push(text)
    } catch (e) {
      console.warn(`[agent:collect:s] 科普渠道失败：${(e as Error).message}`)
    }
  }
  if (channelTexts.length === 0) {
    console.info(`[agent:collect:s] 领域「${domain.name}」本轮科普渠道均无结果`)
    return
  }

  ensureAlive(ctx)
  ctx.progress('AI 科普遴选筛选中…')
  const material = channelTexts.join('\n\n')
  const prompt = `你是大众科普文章遴选助手。领域：「${domain.name}」（兴趣拓展科普线，关注深入浅出的科普文章）。

以下是检索资料。请从中挑选最值得阅读的科普文章，要求：
1. 最多 8 条，宁缺毋滥；没有合适结果就输出空数组，不要硬凑。
2. 只选大众可读的科普向内容；**排除学术论文（含 preprint/期刊原文）、纯新闻稿、营销/推广软文**。
3. 每条输出：source_type 固定为 "article"、title（原题）、authors（数组，可空）、year、summary（120 字内中文概括）、tags（1-3 个）、language（"zh" 或 "en"，按文章语言判定）、length_est（篇幅估计如「6 分钟」）、url（必须与资料原文完全一致，禁止编造或改写）、source（资料中标注的渠道标识）、reason（一句话中文推荐理由：与领域的相关性 + 价值）。
4. 仅输出 JSON 对象：{"items":[...]}，不要任何其他文字。

${wrapMaterial('科普检索原始结果', material.slice(0, 30000))}`
  const res = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    jsonMode: true,
    scene: 'agent:collect',
    signal: ctx.signal
  })
  ensureAlive(ctx)

  const d = getDb()
  const whitelist = whitelistFromText(material)
  let items: ScienceSelection[] = []
  try {
    const parsed = extractJson(res.content)
    items = Array.isArray(parsed.items) ? (parsed.items as ScienceSelection[]) : []
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
    items = (extractJson(res2.content).items as ScienceSelection[]) ?? []
  }

  let added = 0
  for (const it of items) {
    if (!it.title?.trim() || !it.url?.trim()) continue
    if (!matchesWhitelist(it.url, whitelist)) {
      console.warn(`[agent:collect:s] 丢弃编造 url 候选：${it.title}`)
      continue
    }
    const hash = urlHash(it.url)
    const dup = d.prepare('SELECT id FROM discover_items WHERE url_hash = ?').get(hash)
    if (dup) continue
    if (await isNearDuplicate(it.title, it.summary ?? '')) {
      console.info(`[agent:collect:s] 近重复跳过：${it.title}`)
      continue
    }
    try {
      const now = nowIso()
      const r = d
        .prepare(
          "INSERT INTO discover_items (source_type, title, authors, year, date, summary, tags, language, length_est, url, source, reason, status, url_hash, domain_id, created_at) VALUES ('article', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)"
        )
        .run(
          it.title.trim(),
          JSON.stringify((it.authors ?? []).slice(0, 12)),
          typeof it.year === 'number' ? it.year : null,
          it.date ?? null,
          it.summary ?? '',
          JSON.stringify((it.tags ?? []).slice(0, 5)),
          it.language === 'zh' ? 'zh' : 'en',
          it.length_est ?? '',
          it.url.trim(),
          it.source || 'mcp',
          it.reason ?? '',
          hash,
          domainId,
          now
        )
      added++
      const vec = await embedDiscoverVector(it.title, it.summary ?? '')
      if (vec) {
        const { storeEmbedding } = await import('./embedding')
        storeEmbedding('discover', Number(r.lastInsertRowid), vec)
      }
    } catch {
      /* UNIQUE 冲突等逐条忽略 */
    }
  }
  console.info(`[agent:collect:s] 领域「${domain.name}」科普海选完成：入选 ${items.length}，新增 ${added}`)
}

// 任务注册（模块顶层；bootstrap.ts side-effect import）
registerTask({ type: 'collect_science', priority: 10, singleton: true, maxRetries: 2 }, (ctx) =>
  runCollectScience(ctx.refId ?? 0, ctx)
)
