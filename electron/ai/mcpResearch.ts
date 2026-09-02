// AI 辅助 MCP 配置研究（问题疑惑区方案）：三步降级找配置元数据
// ① 官方 Registry API（registry.modelcontextprotocol.io）→ ② 厂商文档 fetch + llms.txt → ③ LLM 自有知识
import { chatCompletion } from './llm'
import type { McpResearch, McpResearchKey } from '../../src/shared/types'

const FETCH_TIMEOUT = 15_000

/** 带超时的 GET 文本 */
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'bugzi-workspace/1.0 (MCP config research)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

// ---------- 第①步：官方 Registry API ----------

interface RegistryServer {
  name?: string
  title?: string
  description?: string
  websiteUrl?: string
  repository?: { url?: string }
  remotes?: { type?: string; url?: string }[]
  packages?: {
    environmentVariables?: { name?: string; description?: string; isSecret?: boolean; isRequired?: boolean }[]
  }[]
}

/** Registry 命中条目是否官方（owner 路径含关键词，如 io.github.tavily-ai/tavily-mcp） */
function isOfficialRegistryEntry(s: RegistryServer, lower: string): boolean {
  const n = (s.name ?? '').toLowerCase()
  const owner = n.includes('/') ? n.slice(0, n.indexOf('/')) : ''
  return owner.includes(lower) || n === lower
}

/** 占位符归一：文档常见写法 → {apiKey}（如 <your-api-key> / YOUR_API_KEY / <tavilyApiKey>） */
function normalizeUrlTemplate(url: string): string {
  return url.replace(/([?&][^=]*?)=(?:<[^>]*key[^>]*>|your[-_]?api[-_]?key|<[^>]*token[^>]*>|\{[a-z_-]*key[a-z_-]*\})/gi, (m, p1) => `${p1}={apiKey}`)
}

/**
 * 第①步结果：official=官方且带 remote（直接可用）；officialRepo=官方但只有 stdio 包
 * （remote 端点要去官方文档里找，转给第②步）；fallback=第三方 remote（仅兜底）
 */
interface RegistryOutcome {
  official?: McpResearch
  officialRepo?: string // 官方仓库/官网 URL，供第②步查文档
  fallback?: McpResearch
}

/** Registry 查询：按「官方优先」分类命中项，不再见 remote 就用（防第三方网关冒名顶替） */
async function researchViaRegistry(name: string): Promise<RegistryOutcome> {
  const raw = await fetchText(
    `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(name)}`
  ).catch(() => null)
  if (!raw) return {}
  let data: { servers?: { server?: RegistryServer }[] }
  try {
    data = JSON.parse(raw) as { servers?: { server?: RegistryServer }[] }
  } catch {
    return {}
  }
  const servers = (data.servers ?? [])
    .map((s) => s.server)
    .filter((s): s is RegistryServer => !!s)
  const lower = name.toLowerCase()
  const ranked = servers.sort((a, b) => score(b) - score(a))
  function score(s: RegistryServer): number {
    const n = (s.name ?? '').toLowerCase()
    if (n.endsWith(`/${lower}`) || n === lower) return 3
    if (n.includes(lower)) return 2
    return (s.title ?? '').toLowerCase().includes(lower) ? 1 : 0
  }  const toResearch = (s: RegistryServer, remoteUrl: string): McpResearch => {
    const envKeys = (s.packages ?? []).flatMap((p) => p.environmentVariables ?? [])
    const secretNames = new Set(
      envKeys.filter((v) => v.isSecret || v.isRequired).map((v) => v.name).filter(Boolean) as string[]
    )
    const keys: McpResearchKey[] = [...secretNames].map((k) => ({
      name: k,
      description: envKeys.find((v) => v.name === k)?.description ?? 'API 密钥',
      applyUrl: s.websiteUrl ?? s.repository?.url ?? ''
    }))
    return {
      title: s.title ?? s.name ?? name,
      description: s.description ?? '',
      urlTemplate: normalizeUrlTemplate(remoteUrl),
      authType: 'none',
      keys,
      docsUrl: s.repository?.url ?? s.websiteUrl ?? remoteUrl,
      source: 'registry',
      notes: `官方 MCP Registry 命中「${s.name ?? name}」；远程端点 ${remoteUrl}${
        keys.length ? `；需密钥：${keys.map((k) => k.name).join('、')}` : ''
      }。`
    }
  }
  // 官方条目优先处理；顺带记录第一个第三方 remote 作兜底
  let fallback: McpResearch | undefined
  for (const s of ranked) {
    const remote = (s.remotes ?? []).find(
      (r) => r.url && /^https?:/.test(r.url) && (r.type ?? '').includes('http')
    )
    const official = isOfficialRegistryEntry(s, lower)
    if (official && remote?.url) return { official: toResearch(s, remote.url) }
    if (official && !remote) {
      // 官方条目但只有 stdio 包：remote 端点在官方文档里（如 Tavily mcp.tavily.com/mcp/?tavilyApiKey=）
      return { officialRepo: s.websiteUrl ?? s.repository?.url ?? '', fallback }
    }
    if (!official && remote?.url && !fallback) {
      fallback = toResearch(s, remote.url) // 第三方 remote 记下但不当选
    }
  }
  return { fallback }
}

// ---------- 第②步：LLM 定位文档 → fetch 提取 ----------

/** 从文档文本里让 LLM 提取结构化配置 */
async function extractFromDocs(name: string, docText: string): Promise<McpResearch | null> {
  const prompt = `你在为桌面 App 的 MCP 配置功能提取信息。用户想配置名为「${name}」的远程 MCP 服务器（Streamable HTTP 传输）。

以下是其官方文档内容（可能截断）：

<docs>
${docText.slice(0, 24_000)}
</docs>

请从中提取该 MCP 的远程连接配置，仅输出 JSON 对象（不要其他文字）：
{
  "title": "服务名称",
  "description": "一句话说明该服务做什么",
  "urlTemplate": "远程端点 URL。若需 API key 拼在 URL 参数里，用 {apiKey} 占位（如 https://mcp.example.com/mcp/?key={apiKey}）；无需则给完整 URL",
  "useBearer": true/false,  // true=需在 HTTP 头带 Authorization: Bearer <key>；false=无需鉴权或 key 在 URL 里
  "keys": [{"name":"TAVILY_API_KEY","description":"Tavily API 密钥","applyUrl":"https://app.tavily.com"}],  // 无鉴权则空数组
  "docsUrl": "配置文档页面 URL"
}
文档中没有的信息宁可留空/空数组，不要编造 URL。若文档与远程 MCP 连接无关，输出 {"error":"no remote mcp info"}。`

  const r = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    jsonMode: true,
    temperature: 0
  })
  let parsed: any
  try {
    parsed = JSON.parse(r.content)
  } catch {
    return null
  }
  if (!parsed || parsed.error || typeof parsed.urlTemplate !== 'string' || !/^https?:/.test(parsed.urlTemplate)) {
    return null
  }
  return {
    title: String(parsed.title ?? name),
    description: String(parsed.description ?? ''),
    urlTemplate: parsed.urlTemplate,
    authType: parsed.useBearer ? 'bearer' : 'none',
    keys: Array.isArray(parsed.keys)
      ? parsed.keys
          .filter((k: any) => k && typeof k.name === 'string')
          .map((k: any) => ({
            name: String(k.name),
            description: String(k.description ?? 'API 密钥'),
            applyUrl: String(k.applyUrl ?? '')
          }))
          .slice(0, 3)
      : [],
    docsUrl: String(parsed.docsUrl ?? ''),
    source: 'docs',
    notes: `已读取厂商文档并提取配置${parsed.useBearer ? '（Bearer 头鉴权）' : ''}。`
  }
}

/** LLM 生成候选文档 URL → 逐个 fetch（含 llms.txt）→ 提取。seedUrl：Registry 给的官方仓库/官网优先查 */
async function researchViaDocs(name: string, seedUrl?: string): Promise<McpResearch | null> {
  // ① LLM 生成候选 URL
  const gen = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: `用户想配置名为「${name}」的远程 MCP 服务器（HTTP 传输）。请给出 3~5 个最可能包含其「远程 MCP 端点与鉴权方式」官方文档的 URL（优先 docs 官网、github 仓库 README）。仅输出 JSON 数组，如 ["https://docs.example.com/mcp", ...]，不要其他文字。不确定的域名不要编造。`
      }
    ],
    jsonMode: true,
    temperature: 0
  })
  let urls: string[] = []
  try {
    const p = JSON.parse(gen.content)
    if (Array.isArray(p)) urls = p.filter((u: unknown) => typeof u === 'string' && /^https?:\/\//.test(u))
  } catch {
    /* 继续走兜底 */
  }
  // Registry 给的官方仓库/官网排最前；github 仓库页转 raw README（直接抓 HTML 冗长且有噪音）
  if (seedUrl) {
    const gh = seedUrl.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/?$/)
    const seed = gh ? `${gh[1].replace('github.com', 'raw.githubusercontent.com')}/main/README.md` : seedUrl
    urls = [seed, ...urls.filter((u) => u !== seed)]
  }
  // 追加 llms.txt 惯例路径（域名取自用户输入或候选 URL）
  const domains = new Set<string>()
  for (const u of urls) {
    try {
      domains.add(new URL(u).origin)
    } catch {
      /* 无效 URL 跳过 */
    }
  }
  const candidates = [...urls, ...[...domains].map((d) => `${d}/llms.txt`)]

  // ② 逐个 fetch，取到可提取内容即返回
  for (const u of candidates.slice(0, 8)) {
    const text = await fetchText(u).catch(() => null)
    if (!text || text.length < 200) continue
    const r = await extractFromDocs(name, text).catch(() => null)
    if (r) {
      if (!r.docsUrl) r.docsUrl = u
      return r
    }
  }
  return null
}

// ---------- 第③步：LLM 自有知识兜底 ----------

async function researchViaLlm(name: string): Promise<McpResearch | null> {
  const r = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: `用户想在桌面 App 配置名为「${name}」的远程 MCP 服务器（Streamable HTTP）。根据你的知识给出其官方远程端点与鉴权方式。仅输出 JSON 对象（不要其他文字）：
{
  "title": "服务名称",
  "description": "一句话说明",
  "urlTemplate": "远程端点 URL（需 API key 时用 {apiKey} 占位）",
  "useBearer": true/false,
  "keys": [{"name":"字段名","description":"说明","applyUrl":"申请入口 URL"}],
  "docsUrl": "官方文档 URL"
}
若你不确定该服务存在官方远程 MCP 端点，输出 {"error":"unknown"}，不要编造。`
      }
    ],
    jsonMode: true,
    temperature: 0
  })
  let parsed: any
  try {
    parsed = JSON.parse(r.content)
  } catch {
    return null
  }
  if (!parsed || parsed.error || typeof parsed.urlTemplate !== 'string' || !/^https?:/.test(parsed.urlTemplate)) {
    return null
  }
  return {
    title: String(parsed.title ?? name),
    description: String(parsed.description ?? ''),
    urlTemplate: parsed.urlTemplate,
    authType: parsed.useBearer ? 'bearer' : 'none',
    keys: Array.isArray(parsed.keys)
      ? parsed.keys
          .filter((k: any) => k && typeof k.name === 'string')
          .map((k: any) => ({
            name: String(k.name),
            description: String(k.description ?? 'API 密钥'),
            applyUrl: String(k.applyUrl ?? '')
          }))
          .slice(0, 3)
      : [],
    docsUrl: String(parsed.docsUrl ?? ''),
    source: 'llm',
    notes: '未找到官方文档，以上为模型知识给出的配置，请核对官方文档后使用。'
  }
}

/** 主入口：三步降级研究 MCP 配置（官方优先，第三方 remote 仅兜底）。全失败抛带 message 的 Error */
export async function researchMcpConfig(name: string): Promise<McpResearch> {
  const notes: string[] = []
  let fallback: McpResearch | undefined

  // ① Registry：official 直接用；officialRepo 转第②步查官方文档
  try {
    const reg = await researchViaRegistry(name)
    if (reg.official) return reg.official
    fallback = reg.fallback
    // ② 文档（需要 LLM，未配置时 chatCompletion 抛 LLM_NOT_CONFIGURED）
    const docR = await researchViaDocs(name, reg.officialRepo).catch((e: Error) => {
      if (e.message.includes('LLM_NOT_CONFIGURED')) throw e // LLM 未配置直抛，弹「去配置」
      return null
    })
    if (docR) {
      // 文档结果补上 Registry 声明的密钥信息（如官方条目 environmentVariables 的 TAVILY_API_KEY）
      return {
        ...docR,
        keys: docR.keys.length ? docR.keys : fallback?.keys ?? [],
        notes: reg.officialRepo
          ? `Registry 命中官方条目（仅 stdio 包），已读官方文档找到远程端点。${docR.notes}`
          : docR.notes
      }
    }
    notes.push('官方路径未能定位远程端点')
  } catch (e) {
    if ((e as Error).message.includes('LLM_NOT_CONFIGURED')) throw e
    notes.push('Registry 查询失败')
  }

  // ③ LLM 兜底（自有知识）
  try {
    const r = await researchViaLlm(name)
    if (r && !fallback) return { ...r, notes: `${notes.join('；')}；${r.notes}` }
    if (r && r.source === 'llm') {
      // LLM 知识与第三方 remote 二选一：优先 LLM 官方知识，第三方作附注
      return {
        ...r,
        keys: r.keys.length ? r.keys : fallback?.keys ?? [],
        notes: `${notes.join('；')}；${r.notes}${fallback ? `；另有第三方端点 ${fallback.urlTemplate}（非官方，不建议）` : ''}`
      }
    }
  } catch (e) {
    if ((e as Error).message.includes('LLM_NOT_CONFIGURED')) throw e
  }

  // ③' 第三方 remote 兜底（明确标注非官方）
  if (fallback) {
    return {
      ...fallback,
      notes: `⚠ 未找到官方远程端点，以下为 Registry 收录的第三方网关，可用性与安全性自担：${fallback.notes}`
    }
  }
  throw new Error(
    `未研究出「${name}」的远程 MCP 配置：${notes.join('；')}。请查阅其官方文档手动填写，或确认服务名称是否正确。`
  )
}

/** 测试连接：跑一次 initialize + tools/list；0 工具视为端点不可用（占位网关/订阅墙）抛错 */
export async function testMcpConnection(config: {
  name: string
  url: string
  authType?: 'none' | 'bearer'
  apiKey?: string
}): Promise<{ tools: string[] }> {
  const { McpSession } = await import('./mcp')
  const session = new McpSession(config)
  const tools = await session.listTools()
  if (tools.length === 0) {
    throw new Error('连接成功但未提供任何工具（可能是占位网关或需订阅），请换官方端点')
  }
  return { tools: tools.map((t) => t.name) }
}
