// LLM 客户端（主进程）：OpenAI 兼容 chat/completions，读默认 LLM 配置
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
  signal?: AbortSignal
}

export interface ChatResult {
  content: string
}

/** 429 限流自动重试次数（中转服务账号并发超限属瞬态错误，等待后重试即可） */
const RATE_LIMIT_RETRIES = 3

/** 调用默认 LLM 的一次 chat completion。失败抛带 message 的 Error（渲染层 toast 展示）；
 *  signal 取消 → 抛「已取消」（含 429 退避等待期，取消立即中断不等计时） */
export async function chatCompletion(opts: ChatOptions): Promise<ChatResult> {
  const cfg = getDefaultLlm() // 未配置时抛 LlmNotConfiguredError
  const url = normalizeChatUrl(cfg.apiUrl)
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: opts.messages,
    stream: false
  }
  if (opts.temperature != null) body.temperature = opts.temperature
  if (opts.jsonMode) body.response_format = { type: 'json_object' }

  let res: Response
  for (let attempt = 0; ; attempt++) {
    ensureNotCancelled(opts.signal)
    try {
      res = await fetch(url, {
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
      throw new Error(`网络请求失败：${(e as Error).message}`)
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
  }
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('LLM 返回格式异常（无 choices[0].message.content）')
  return { content }
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
    res = await fetch(url, {
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

/** LLM「测试连接」：发一次最小请求（个人中心 specs §3.4）；signal 取消 → 抛「已取消」 */
export async function testLlmConnection(config: LlmConfig, signal?: AbortSignal): Promise<void> {
  const url = normalizeChatUrl(config.apiUrl)
  let res: Response
  try {
    res = await fetch(url, {
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
