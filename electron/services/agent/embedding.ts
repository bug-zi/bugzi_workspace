// Embedding 服务（总纲 §4.6）：本地 Ollama /api/embed 客户端 + 向量存取
// （Float32 BLOB + 余弦暴力扫描，个人规模毫秒级，不引入外部向量库）。
// enabled=false 或不可达一律抛 EmbedUnavailableError，调用方 catch 降级，绝不阻塞主管道。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { net } from 'electron'
import { getDb, nowIso } from '../../db/db'
import { getSetting, setSetting } from '../../db/settings'
import { SettingsKeys } from '../../../src/shared/types'
import type { EmbeddingConfig } from '../../../src/shared/types'

export const EMBEDDING_DEFAULTS: EmbeddingConfig = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:11434',
  model: 'bge-m3',
  ollamaPath: 'D:\\AI\\Ollama\\ollama.exe'
}

/** settings 读 + 逐字段兜底合并（坏 JSON 回默认，噪音引擎 loadState 同款容错取向） */
export function getEmbeddingConfig(): EmbeddingConfig {
  const raw = getSetting(SettingsKeys.EmbeddingConfig)
  if (!raw) return { ...EMBEDDING_DEFAULTS }
  try {
    const o = JSON.parse(raw) as Partial<EmbeddingConfig>
    return {
      enabled: o.enabled === true,
      baseUrl: typeof o.baseUrl === 'string' && o.baseUrl ? o.baseUrl : EMBEDDING_DEFAULTS.baseUrl,
      model: typeof o.model === 'string' && o.model ? o.model : EMBEDDING_DEFAULTS.model,
      ollamaPath:
        typeof o.ollamaPath === 'string' && o.ollamaPath
          ? o.ollamaPath
          : EMBEDDING_DEFAULTS.ollamaPath
    }
  } catch {
    return { ...EMBEDDING_DEFAULTS }
  }
}

export function saveEmbeddingConfig(cfg: EmbeddingConfig): void {
  setSetting(SettingsKeys.EmbeddingConfig, JSON.stringify(cfg))
}

export class EmbedUnavailableError extends Error {
  constructor(msg = 'Embedding 服务不可用') {
    super(msg)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function callEmbed(texts: string[], model: string): Promise<number[][]> {
  const cfg = getEmbeddingConfig()
  const res = await net.fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(30000)
  })
  if (!res.ok) throw new EmbedUnavailableError(`Ollama 返回 ${res.status}`)
  const data = (await res.json()) as { embeddings?: unknown }
  const embs = data.embeddings
  if (!Array.isArray(embs) || embs.length !== texts.length) {
    throw new EmbedUnavailableError('Ollama 响应格式异常')
  }
  return embs as number[][]
}

/** 批量向量化：30s 超时，网络/超时/5xx 重试 1 次（4xx 不重试直接失败） */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const cfg = getEmbeddingConfig()
  if (!cfg.enabled) throw new EmbedUnavailableError('语义检索未启用')
  if (texts.length === 0) return []
  try {
    return await callEmbed(texts, cfg.model)
  } catch (e) {
    if (e instanceof EmbedUnavailableError && /^Ollama 返回 4/.test(e.message)) throw e
    try {
      return await callEmbed(texts, cfg.model)
    } catch {
      throw e instanceof Error ? e : new EmbedUnavailableError()
    }
  }
}

export function cosine(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function toF32(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2)
}

/** UPSERT 一条实体向量（BLOB = Float32Array 原始字节） */
export function storeEmbedding(entityType: string, entityId: number, vec: number[]): void {
  const buf = Buffer.from(new Float32Array(vec).buffer)
  getDb()
    .prepare(
      'INSERT INTO embeddings (entity_type, entity_id, vector, model, created_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT (entity_type, entity_id) DO UPDATE SET vector = excluded.vector, model = excluded.model, created_at = excluded.created_at'
    )
    .run(entityType, entityId, buf, getEmbeddingConfig().model, nowIso())
}

export function getEmbedding(entityType: string, entityId: number): number[] | null {
  const row = getDb()
    .prepare('SELECT vector FROM embeddings WHERE entity_type = ? AND entity_id = ?')
    .get(entityType, entityId) as { vector: Uint8Array } | undefined
  if (!row) return null
  return Array.from(toF32(row.vector))
}

/** 余弦暴力扫描 topK（可按 entity_type 白名单过滤）；规模超限时再评估 sqlite-vec（总纲 §3） */
export function searchSimilar(
  vec: number[],
  topK: number,
  filterTypes?: string[]
): { entityType: string; entityId: number; score: number }[] {
  const rows = (
    filterTypes && filterTypes.length > 0
      ? getDb()
          .prepare(
            `SELECT entity_type, entity_id, vector FROM embeddings WHERE entity_type IN (${filterTypes
              .map(() => '?')
              .join(',')})`
          )
          .all(...filterTypes)
      : getDb().prepare('SELECT entity_type, entity_id, vector FROM embeddings').all()
  ) as { entity_type: string; entity_id: number; vector: Uint8Array }[]
  const q = new Float32Array(vec)
  return rows
    .map((r) => ({
      entityType: r.entity_type,
      entityId: r.entity_id,
      score: cosine(q, toF32(r.vector))
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

/** 「测试连接」：向量化一个词取维度 */
export async function testEmbedding(): Promise<{ dim: number }> {
  const embs = await embedTexts(['ping'])
  return { dim: embs[0]?.length ?? 0 }
}

async function probeTags(baseUrl: string): Promise<boolean> {
  try {
    const res = await net.fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(2000)
    })
    return res.ok
  } catch {
    return false
  }
}

/** 探测 + 一键拉起：不可达时 spawn ollama serve（路径可配），轮询至多 8s */
export async function ensureOllama(): Promise<boolean> {
  const cfg = getEmbeddingConfig()
  if (await probeTags(cfg.baseUrl)) return true
  if (!cfg.ollamaPath || !existsSync(cfg.ollamaPath)) return false
  try {
    spawn(cfg.ollamaPath, ['serve'], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    return false
  }
  for (let i = 0; i < 16; i++) {
    await sleep(500)
    if (await probeTags(cfg.baseUrl)) return true
  }
  return false
}
