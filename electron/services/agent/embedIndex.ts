// embedding 索引与相关推荐（超级工作台 2.0 批次B spec §4）：导读卡/摘要向量化入库；
// 首次运行顺带补索引万象库词条；余弦 top-3 写 knowledge_links（similarity）。
// Ollama 不可达 → 静默跳过（console 留痕），不重试不炸主管道。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, nowIso, userDataDir } from '../../db/db'
import { registerTask } from './queue'
import type { TaskContext } from './queue'
import { EmbedUnavailableError, embedTexts, getEmbeddingConfig, searchSimilar, storeEmbedding } from './embedding'

const WIKI_BATCH = 32
const LINK_MIN_SCORE = 0.6
const LINK_TOP_K = 3

function hasEmbedding(entityType: string, entityId: number): boolean {
  return !!getDb()
    .prepare('SELECT id FROM embeddings WHERE entity_type = ? AND entity_id = ?')
    .get(entityType, entityId)
}

/** 万象库词条补索引（每次批量 32 条直到无缺失或出错） */
async function backfillWikiIndex(): Promise<void> {
  const rows = getDb()
    .prepare(
      "SELECT w.id, w.term, w.summary FROM wiki_entries w WHERE w.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.entity_type = 'wiki' AND e.entity_id = w.id) LIMIT ?"
    )
    .all(WIKI_BATCH) as { id: number; term: string; summary: string }[]
  if (rows.length === 0) return
  const vecs = await embedTexts(rows.map((r) => `${r.term}：${r.summary}`))
  rows.forEach((r, i) => storeEmbedding('wiki', r.id, vecs[i]))
  console.info(`[agent:embed] 万象库词条补索引 ${rows.length} 条`)
}

function recordLink(srcType: string, srcId: number, dstType: string, dstId: number, score: number): void {
  if (srcType === dstType && srcId === dstId) return
  try {
    getDb()
      .prepare(
        "INSERT OR IGNORE INTO knowledge_links (src_type, dst_type, src_id, dst_id, origin, score, created_at) VALUES (?, ?, ?, ?, 'similarity', ?, ?)"
      )
      .run(srcType, srcId, dstType, dstId, score, nowIso())
  } catch {
    /* 链接失败不影响索引 */
  }
}

async function embedIndexRunner(paperId: number, ctx: TaskContext): Promise<void> {
  const cfg = getEmbeddingConfig()
  if (!cfg.enabled) {
    console.info('[agent:embed] 语义检索未启用，跳过索引')
    return
  }
  // 万象库词条补索引（每次触发推进一批）
  try {
    await backfillWikiIndex()
  } catch (e) {
    if (e instanceof EmbedUnavailableError) {
      console.warn('[agent:embed] Ollama 不可达，本轮跳过（含词条补索引）')
      return
    }
    console.warn(`[agent:embed] 词条补索引失败：${(e as Error).message}`)
  }
  const paper = getDb().prepare('SELECT * FROM papers WHERE id = ?').get(paperId) as
    | { id: number; title: string; summary: string; digest_md: string | null }
    | undefined
  if (!paper || hasEmbedding('paper', paperId)) return
  ctx.progress('向量化索引中…')
  let input = paper.summary
  if (paper.digest_md) {
    const abs = join(userDataDir(), paper.digest_md)
    if (existsSync(abs)) input = readFileSync(abs, 'utf-8').slice(0, 8000)
  }
  const [vec] = await embedTexts([`${paper.title}。${input}`])
  storeEmbedding('paper', paperId, vec)
  // 相关推荐：余弦 top-3（≥0.6）→ knowledge_links（paper→paper / paper→wiki）
  const hits = searchSimilar(vec, 10, ['paper', 'wiki']).filter(
    (h) => h.score >= LINK_MIN_SCORE && !(h.entityType === 'paper' && h.entityId === paperId)
  )
  for (const h of hits.slice(0, LINK_TOP_K)) {
    recordLink('paper', paperId, h.entityType, h.entityId, h.score)
  }
  console.info(`[agent:embed] 论文 #${paperId} 索引完成，相关推荐 ${Math.min(hits.length, LINK_TOP_K)} 条`)
}

registerTask({ type: 'embed_index', priority: 20, singleton: true, maxRetries: 1 }, (ctx) =>
  embedIndexRunner(ctx.refId ?? 0, ctx)
)
