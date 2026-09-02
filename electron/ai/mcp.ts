// MCP 客户端（主进程）：Streamable HTTP（JSON-RPC 2.0 over HTTP POST + SSE 响应解析）
// v1 仅 http 传输（个人中心 specs §3.5：字段按「名称+地址+开关」）
import { getJsonSetting } from '../db/settings'
import { SettingsKeys } from '../../src/shared/types'
import type { McpConfig } from '../../src/shared/types'

export class McpNotEnabledError extends Error {
  constructor() {
    super('MCP_NOT_ENABLED')
  }
}

/** 当前启用的 MCP 配置列表（个人中心配置 + 开关） */
export function getEnabledMcps(): McpConfig[] {
  const configs = getJsonSetting<McpConfig[]>(SettingsKeys.McpConfigs, [])
  return configs.filter((c) => c.enabled)
}

let rpcId = 0

/** 单个 MCP 会话：initialize → tools/list → tools/call，带会话头 */
export class McpSession {
  private sessionId: string | null = null
  private initialized = false

  constructor(
    private config: { name: string; url: string; authType?: 'none' | 'bearer'; apiKey?: string },
    private onLog?: (msg: string) => void
  ) {}

  private log(msg: string): void {
    this.onLog?.(msg)
  }

  /** 通用请求头：bearer 鉴权时带 Authorization（问题疑惑区 MCP 方案） */
  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.config.authType === 'bearer' && this.config.apiKey
        ? { Authorization: `Bearer ${this.config.apiKey}` }
        : {})
    }
  }

  private async rpc(method: string, params?: unknown): Promise<any> {
    const body = { jsonrpc: '2.0', id: ++rpcId, method, params }
    let res: Response
    try {
      res = await fetch(this.config.url, {
        method: 'POST',
        headers: { ...this.headers(), ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}) },
        body: JSON.stringify(body)
      })
    } catch (e) {
      throw new Error(`MCP ${this.config.name} 请求失败：${(e as Error).message}`)
    }
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    if (!res.ok) {
      throw new Error(`MCP ${this.config.name} 返回 ${res.status}`)
    }
    const ct = res.headers.get('content-type') ?? ''
    const payload = ct.includes('text/event-stream') ? await parseSseResponse(res) : await res.json()
    // JSON-RPC 信封解包：响应是 {"result": ...} / {"error": {...}}，工具等数据在 result 里
    // （实测 Firecrawl/Tavily 的 SSE data 即完整信封；不解包则 listTools 恒为空数组）
    if (payload && typeof payload === 'object') {
      const p = payload as { result?: unknown; error?: { message?: string } }
      if (p.error) throw new Error(`MCP ${this.config.name} 返回错误：${p.error.message ?? JSON.stringify(p.error)}`)
      if ('result' in p) return p.result
    }
    return payload
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    const res = await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'bugzi-workspace', version: '1.0.0' }
    })
    // 按协议规范发送 initialized 通知（无 id，不期待响应）
    try {
      await fetch(this.config.url, {
        method: 'POST',
        headers: { ...this.headers(), ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
      })
    } catch {
      /* 通知无需响应，失败可容忍 */
    }
    this.initialized = true
    this.log(
      res?.serverInfo?.name ? `已连接 ${res.serverInfo.name}` : `已连接 ${this.config.name}`
    )
  }

  /** 返回工具列表 [{name, description}] */
  async listTools(): Promise<{ name: string; description?: string }[]> {
    await this.initialize()
    const res = await this.rpc('tools/list', {})
    return (res?.tools ?? []).map((t: any) => ({
      name: t.name as string,
      description: t.description as string | undefined
    }))
  }

  /** 调用工具，返回文本结果（MCP tools/call 的 content 数组取 text） */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.initialize()
    const res = await this.rpc('tools/call', { name, arguments: args })
    const contents = res?.content ?? []
    const texts: string[] = []
    for (const c of contents) {
      if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text)
    }
    return texts.join('\n')
  }
}

async function parseSseResponse(res: Response): Promise<any> {
  const raw = await res.text()
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim()
      if (payload && payload !== '[DONE]') {
        try {
          return JSON.parse(payload)
        } catch {
          /* 跳过无法解析的行 */
        }
      }
    }
  }
  return null
}

/** 取第一个可用的搜索类工具（辩真阁用）：优先名字含 search/query/fetch 的工具 */
export async function findSearchTool(
  onLog?: (msg: string) => void
): Promise<{ mcp: McpSession; tool: string } | null> {
  const mcps = getEnabledMcps()
  if (mcps.length === 0) throw new McpNotEnabledError()
  for (const config of mcps) {
    try {
      const session = new McpSession(config, onLog)
      const tools = await session.listTools()
      const search = tools.find((t) => /search|query|fetch/i.test(t.name))
      if (search) return { mcp: session, tool: search.name }
    } catch {
      // 单个 MCP 失败跳过，尝试下一个
    }
  }
  return null
}

/** 列出全部启用 MCP 的工具（调试/后续扩展用） */
export async function listAllTools(): Promise<
  { mcpName: string; tools: { name: string; description?: string }[] }[]
> {
  const out: { mcpName: string; tools: { name: string; description?: string }[] }[] = []
  for (const config of getEnabledMcps()) {
    try {
      const session = new McpSession(config)
      const tools = await session.listTools()
      out.push({ mcpName: config.name, tools })
    } catch {
      /* 跳过失败项 */
    }
  }
  return out
}
