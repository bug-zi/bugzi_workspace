// LLM 客户端（主进程）：OpenAI 兼容 chat/completions。
// v2（260910 推理角效率优化）：chatCompletion 保持唯一咽喉点，调用方透明获得
// 模型池溢出路由 + llm_usage 记账 + llm:activity 活动广播；
// 手动诊断路径（测试连接/拉模型列表）不经咽喉点，不路由不记账。
import { BrowserWindow, net } from 'electron'
import { getDb, nowIso } from '../db/db'
import { getJsonSetting, getSetting } from '../db/settings'
import type { LlmConfig } from '../../src/shared/types'
import { SettingsKeys } from '../../src/shared/types'
import { ensureNotCancelled } from './jobs'

export class LlmNotConfiguredError extends Error {
  constructor() {
    super('LLM_NOT_CONFIGURED')
  }
}

/** 取默认 LLM 配置；无配置或默认项缺失 → LlmNotConfiguredError */
export function getDefaultLlm(): LlmConfig {
  const configs = getJsonSetting<LlmConfig[]>(SettingsKeys.LlmConfigs, [])
  if (configs.length === 0) throw new LlmNotConfiguredError()
  const defaultId = getSetting(SettingsKeys.LlmDefaultId)
  const def = configs.find((c) => c.id === defaultId) ?? configs[0]
  if (!def) throw new LlmNotConfiguredError()
  return def
}

// ---------- 模型池溢出路由（260910 设计 §1） ----------

/** 在途调用登记：key = 自增序号；value 含路由计数（按 configId）与活动指示（scene/配置名）所需字段 */
const activeCalls = new Map<number, { scene: string; configId: string; configName: string }>()
let callSeq = 0

function countInflight(configId: string): number {
  let n = 0
  for (const v of activeCalls.values()) if (v.configId === configId) n++
  return n
}

/** 在途快照广播（活动指示，设计 §5）：调用起止各发一次，payload 只含 scene 与配置名 */
function broadcastActivity(): void {
  const items = [...activeCalls.values()].map((v) => ({ scene: v.scene, configName: v.configName }))
  BrowserWindow.getAllWindows()[0]?.webContents.send('llm:activity', { items })
}

/** 路由纯函数（无副作用，便于脚本验证）：默认未满用默认；否则挑在途最低的可用备选；
 *  全满仍回默认（不排队，429 三层兜底收尾）。maxConcurrent 缺省/非正 = 不限。 */
export function pickConfigFrom(
  configs: LlmConfig[],
  defaultId: string,
  inflightOf: (id: string) => number
): LlmConfig {
  const def = configs.find((c) => c.id === defaultId) ?? configs[0]
  if (!def) throw new LlmNotConfiguredError()
  const cap = (c: LlmConfig): number =>
    typeof c.maxConcurrent === 'number' && c.maxConcurrent > 0 ? c.maxConcurrent : Infinity
  if (inflightOf(def.id) < cap(def)) return def
  const spare = configs.filter((c) => c.id !== def.id && inflightOf(c.id) < cap(c))
  if (spare.length === 0) return def
  return spare.sort((a, b) => inflightOf(a.id) - inflightOf(b.id))[0]
}

// ---------- usage 记账（260910 设计 §2；静默容错，绝不影响调用本身） ----------

function recordUsage(row: {
  scene: string
  configName: string
  model: string
  ok: boolean
  durationMs: number
  promptTokens: number
  completionTokens: number
  tokensEstimated: boolean
  errorBrief: string | null
}): void {
  try {
    getDb()
      .prepare(
        'INSERT INTO llm_usage (created_at, scene, config_name, model, ok, duration_ms, prompt_tokens, completion_tokens, tokens_estimated, error_brief) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        nowIso(),
        row.scene,
        row.configName,
        row.model,
        row.ok ? 1 : 0,
        row.durationMs,
        row.promptTokens,
        row.completionTokens,
        row.tokensEstimated ? 1 : 0,
        row.errorBrief
      )
  } catch (e) {
    console.warn('[llm] usage 记账失败（忽略）：', e)
  }
}

/** 标准化 API URL：自动拼 /v1/chat/completions（调用方给 base 或完整路径均可） */
export function normalizeChatUrl(apiUrl: string): string {
  const u = apiUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(u)) return u
  if (/\/v\d+($|\/)/.test(u)) return `${u}/chat/completions`
  return `${u}/v1/chat/completions`
}

export interface ChatOptions {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  temperature?: number
  jsonMode?: boolean
  /** 思维链控制（260910 格言提速）：缺省 = 不发参数（上游默认行为，现有场景零变化）。
   *  仅 glm 系模型实际生效（chatWithConfig 内映射），见下。 */
  thinking?: 'enabled' | 'disabled'
  signal?: AbortSignal
  /** 场景标签（260910 记账/活动指示用，两段式 模块:动作；缺省 other） */
  scene?: string
}

export interface ChatResult {
  content: string
}

/**
 * 主进程 HTTP 统一走 Electron net.fetch（Chromium 网络栈），不用 Node 全局 fetch（undici）：
 * undici 有写死的 headersTimeout 300s 且无公开句柄可调——非流式 LLM 调用的响应头要等
 * 整段生成完才到，慢中转下大 prompt 出题/审题超 5 分钟即 UND_ERR_HEADERS_TIMEOUT 被掐
 * （260909 推理角补充泵排障定位）；Chromium 栈无此固定上限，且天然跟随系统代理。
 * net 模块须 app ready 后使用——本文件全部调用点（IPC/泵/定时器）均满足。
 */

/** 429 限流自动重试次数（中转服务账号并发超限属瞬态错误，等待后重试即可） */
const RATE_LIMIT_RETRIES = 3

/** 调用 LLM 的唯一咽喉点（260910 v2）：路由选模型 → 在途登记/广播 → 调用 → 记账。
 *  429 重试在内部完成，一次逻辑调用只记一行（耗时含重试等待）。
 *  失败抛带 message 的 Error（渲染层 toast 展示）；signal 取消 → 抛「已取消」
 *  （含 429 退避等待期，取消立即中断不等计时）。 */
export async function chatCompletion(opts: ChatOptions): Promise<ChatResult> {
  const cfg = pickConfigFrom(
    getJsonSetting<LlmConfig[]>(SettingsKeys.LlmConfigs, []),
    getSetting(SettingsKeys.LlmDefaultId) ?? '',
    countInflight
  )
  const scene = opts.scene ?? 'other'
  const seq = ++callSeq
  activeCalls.set(seq, { scene, configId: cfg.id, configName: cfg.name })
  broadcastActivity()
  const t0 = Date.now()
  try {
    const res = await chatWithConfig(cfg, opts)
    // usage 提取：上游报了用真的；任一侧缺失按字符粗估（中文 ~2 字符/token）并打估算标记
    const pt = res.usage?.prompt_tokens
    const ct = res.usage?.completion_tokens
    let promptTokens = typeof pt === 'number' ? pt : 0
    let completionTokens = typeof ct === 'number' ? ct : 0
    let tokensEstimated = false
    if (typeof pt !== 'number') {
      promptTokens = Math.ceil(opts.messages.reduce((n, m) => n + m.content.length, 0) / 2)
      tokensEstimated = true
    }
    if (typeof ct !== 'number') {
      completionTokens = Math.ceil(res.content.length / 2)
      tokensEstimated = true
    }
    recordUsage({
      scene,
      configName: cfg.name,
      model: cfg.model,
      ok: true,
      durationMs: Date.now() - t0,
      promptTokens,
      completionTokens,
      tokensEstimated,
      errorBrief: null
    })
    return { content: res.content }
  } catch (e) {
    recordUsage({
      scene,
      configName: cfg.name,
      model: cfg.model,
      ok: false,
      durationMs: Date.now() - t0,
      promptTokens: 0,
      completionTokens: 0,
      tokensEstimated: false,
      errorBrief: String((e as Error)?.message ?? e).slice(0, 200)
    })
    throw e
  } finally {
    activeCalls.delete(seq)
    broadcastActivity()
  }
}

/** 实际网络调用（原 chatCompletion 主体固定单一配置版；额外透传上游 usage） */
async function chatWithConfig(
  cfg: LlmConfig,
  opts: ChatOptions
): Promise<{ content: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }> {
  const url = normalizeChatUrl(cfg.apiUrl)
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: opts.messages,
    stream: false
  }
  if (opts.temperature != null) body.temperature = opts.temperature
  if (opts.jsonMode) body.response_format = { type: 'json_object' }
  // 思维链按模型家族映射（260910 格言提速）：glm 系 → 智谱 thinking 参数；其余模型一律不发送
  // ——防 OpenAI 严格端点对未知参数 400，防溢出路由把调用甩给非 glm 配置时炸请求（甩到即按其默认行为跑）
  if (opts.thinking && /^glm/i.test(cfg.model)) body.thinking = { type: opts.thinking }

  let res: Response
  for (let attempt = 0; ; attempt++) {
    ensureNotCancelled(opts.signal)
    try {
      res = await net.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify(body),
        signal: opts.signal
      })
    } catch (e) {
      if (opts.signal?.aborted) throw new Error('已取消')
      // undici 网络错误（fetch failed 等）的根因藏在 cause（ECONNRESET / ETIMEDOUT /
      // UND_ERR_CONNECT_TIMEOUT 等）——带上便于区分通道掐连接、超时与本机网络问题
      const cause = (e as { cause?: { code?: string; message?: string } }).cause
      const causeText = cause ? `（${cause.code ?? cause.message}）` : ''
      throw new Error(`网络请求失败：${(e as Error).message}${causeText}`)
    }
    // 429 账号并发/限流：尊重 Retry-After 头，否则指数退避 2s/4s/8s 后自动重试
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) break
    const retryAfter = Number(res.headers.get('retry-after'))
    const backoff = [2000, 4000, 8000]
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 15_000)
        : (backoff[attempt] ?? 8000)
    await sleepOrAbort(waitMs, opts.signal)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM 服务返回 ${res.status}：${text.slice(0, 300)}`)
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('LLM 返回格式异常（无 choices[0].message.content）')
  return { content, usage: data?.usage }
}

/** 退避等待：与 signal abort race（取消立即中断，不等计时走完） */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms))
  if (signal.aborted) return Promise.reject(new Error('已取消'))
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new Error('已取消'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 标准化 models URL：自动拼 /v1/models（调用方给 base 或完整路径均可） */
export function normalizeModelsUrl(apiUrl: string): string {
  const u = apiUrl.trim().replace(/\/+$/, '')
  if (/\/models$/.test(u)) return u
  if (/\/v\d+($|\/)/.test(u)) return `${u}/models`
  return `${u}/v1/models`
}

/** 从上游获取模型列表（OpenAI 兼容 GET /models，优化建议区 #1）。失败抛带 message 的 Error */
export async function listUpstreamModels(config: LlmConfig): Promise<string[]> {
  const url = normalizeModelsUrl(config.apiUrl)
  let res: Response
  try {
    res = await net.fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` }
    })
  } catch (e) {
    throw new Error(`网络请求失败：${(e as Error).message}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM 服务返回 ${res.status}：${text.slice(0, 300)}`)
  }
  const data = (await res.json()) as { data?: { id?: string }[] }
  const models = (data?.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (models.length === 0) throw new Error('上游未返回任何模型')
  return models.sort((a, b) => a.localeCompare(b))
}

/** LLM「测试连接」：发一次最小请求（个人中心 specs §3.4）；signal 取消 → 抛「已取消」。
 *  手动诊断动作：不经咽喉点，不路由不记账（设计 §9）。 */
export async function testLlmConnection(config: LlmConfig, signal?: AbortSignal): Promise<void> {
  const url = normalizeChatUrl(config.apiUrl)
  let res: Response
  try {
    res = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1
      }),
      signal
    })
  } catch (e) {
    if (signal?.aborted) throw new Error('已取消')
    throw new Error(`网络请求失败：${(e as Error).message}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM 服务返回 ${res.status}：${text.slice(0, 300)}`)
  }
}
