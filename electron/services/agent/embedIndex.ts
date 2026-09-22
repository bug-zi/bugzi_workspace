// embedding 索引与相关推荐（超级工作台 2.0 批次B + 批次F 实体扩容）：导读卡/科普解读/书导读
// 向量化入库；每次运行顺带补索引万象库词条与学习库知识点（各推进一批）；余弦 top-3 写
// knowledge_links（similarity，白名单 paper/wiki/science_article/book）。
// Ollama 不可达 → 静默跳过（console 留痕），不重试不炸主管道。
import { getDb, nowIso, userDataDir } from '../../db/db'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerTask } from './queue'
import type { TaskContext } from './queue'
import { EmbedUnavailableError, embedTexts, getEmbeddingConfig, searchSimilar, storeEmbedding } from './embedding'
import { getScienceArticle } from './science'
import { getBookRow } from './booktext'

const BATCH = 32
const LINK_MIN_SCORE = 0.6
const LINK_TOP_K = 3
const INPUT_SLICE = 8000

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
    .all(BATCH) as { id: number; term: string; summary: string }[]
  if (rows.length === 0) return
  const vecs = await embedTexts(rows.map((r) => `${r.term}：${r.summary}`))
  rows.forEach((r, i) => storeEmbedding('wiki', r.id, vecs[i]))
  console.info(`[agent:embed] 万象库词条补索引 ${rows.length} 条`)
}

/** 学习库知识点补索引（批次F：level=2 未删，title：summary 输入，同批量口径） */
async function backfillLearnNodes(): Promise<void> {
  const rows = getDb()
    .prepare(
      "SELECT l.id, l.title, l.summary FROM learn_nodes l WHERE l.level = 2 AND l.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.entity_type = 'learn_node' AND e.entity_id = l.id) LIMIT ?"
    )
    .all(BATCH) as { id: number; title: string; summary: string }[]
  if (rows.length === 0) return
  const vecs = await embedTexts(rows.map((r) => `${r.title}：${r.summary}`))
  rows.forEach((r, i) => storeEmbedding('learn_node', r.id, vecs[i]))
  console.info(`[agent:embed] 学习库知识点补索引 ${rows.length} 条`)
}

/** 两个补索引各推进一批；返回 false = Embedding 不可达（调用方本轮直接放弃） */
async function runBackfills(): Promise<boolean> {
  try {
    await backfillWikiIndex()
  } catch (e) {
    if (e instanceof EmbedUnavailableError) {
      console.warn('[agent:embed] Ollama 不可达，本轮跳过（含补索引）')
      return false
    }
    console.warn(`[agent:embed] 词条补索引失败：${(e as Error).message}`)
  }
  try {
    await backfillLearnNodes()
  } catch (e) {
    if (e instanceof EmbedUnavailableError) {
      console.warn('[agent:embed] Ollama 不可达，本轮跳过（含补索引）')
      return false
    }
    console.warn(`[agent:embed] 知识点补索引失败：${(e as Error).message}`)
  }
  return true
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

/** 相关推荐：余弦 top-3（≥0.6，四实体白名单）→ similarity 链接；返回条数供日志 */
function linkRelated(srcType: string, srcId: number, vec: number[]): number {
  const hits = searchSimilar(vec, 10, ['paper', 'wiki', 'science_article', 'book']).filter(
    (h) => h.score >= LINK_MIN_SCORE && !(h.entityType === srcType && h.entityId === srcId)
  )
  for (const h of hits.slice(0, LINK_TOP_K)) {
    recordLink(srcType, srcId, h.entityType, h.entityId, h.score)
  }
  return Math.min(hits.length, LINK_TOP_K)
}

/** 解读产物 md 节选（缺失/读失败返回空串） */
function readMdSlice(relPath: string | null | undefined, max: number): string {
  if (!relPath) return ''
  const abs = join(userDataDir(), relPath)
  if (!existsSync(abs)) return ''
  try {
    return readFileSync(abs, 'utf-8').slice(0, max)
  } catch {
    return ''
  }
}

async function embedIndexRunner(paperId: number, ctx: TaskContext): Promise<void> {
  const cfg = getEmbeddingConfig()
  if (!cfg.enabled) {
    console.info('[agent:embed] 语义检索未启用，跳过索引')
    return
  }
  if (!(await runBackfills())) return
  const paper = getDb().prepare('SELECT * FROM papers WHERE id = ?').get(paperId) as
    | { id: number; title: string; summary: string; digest_md: string | null }
    | undefined
  if (!paper || hasEmbedding('paper', paperId)) return
  ctx.progress('向量化索引中…')
  const input = readMdSlice(paper.digest_md, INPUT_SLICE) || paper.summary
  const [vec] = await embedTexts([`${paper.title}。${input}`])
  storeEmbedding('paper', paperId, vec)
  const n = linkRelated('paper', paperId, vec)
  console.info(`[agent:embed] 论文 #${paperId} 索引完成，相关推荐 ${n} 条`)
}

/** 科普文章索引（批次F）：标题 + 轻加工/解读产物节选（translation||light 优先） */
async function embedScienceRunner(articleId: number, ctx: TaskContext): Promise<void> {
  const cfg = getEmbeddingConfig()
  if (!cfg.enabled) {
    console.info('[agent:embed] 语义检索未启用，跳过索引')
    return
  }
  if (!(await runBackfills())) return
  const article = getScienceArticle(articleId)
  if (!article || hasEmbedding('science_article', articleId)) return
  ctx.progress('向量化索引中…')
  const rows = getDb()
    .prepare(
      "SELECT md_path FROM interpretations WHERE owner_type = 'science_article' AND owner_id = ? AND kind IN ('translation','light') AND status = 'done' ORDER BY CASE kind WHEN 'translation' THEN 0 ELSE 1 END LIMIT 1"
    )
    .all(articleId) as { md_path: string | null }[]
  const input = readMdSlice(rows[0]?.md_path, INPUT_SLICE) || article.summary
  const [vec] = await embedTexts([`${article.title}。${input}`])
  storeEmbedding('science_article', articleId, vec)
  const n = linkRelated('science_article', articleId, vec)
  console.info(`[agent:embed] 科普文章 #${articleId} 索引完成，相关推荐 ${n} 条`)
}

/** 书籍索引（批次F）：书名 + 作者 + 导读节选 */
async function embedBookRunner(bookId: number, ctx: TaskContext): Promise<void> {
  const cfg = getEmbeddingConfig()
  if (!cfg.enabled) {
    console.info('[agent:embed] 语义检索未启用，跳过索引')
    return
  }
  if (!(await runBackfills())) return
  const book = getBookRow(bookId)
  if (!book || hasEmbedding('book', bookId)) return
  ctx.progress('向量化索引中…')
  const rows = getDb()
    .prepare(
      "SELECT md_path FROM interpretations WHERE owner_type = 'book' AND owner_id = ? AND kind = 'book_digest' AND status = 'done' ORDER BY id DESC LIMIT 1"
    )
    .all(bookId) as { md_path: string | null }[]
  const digest = readMdSlice(rows[0]?.md_path, INPUT_SLICE)
  const input = `${book.title}。${book.author ?? ''}${digest ? `。${digest}` : ''}`
  const [vec] = await embedTexts([input])
  storeEmbedding('book', bookId, vec)
  const n = linkRelated('book', bookId, vec)
  console.info(`[agent:embed] 书籍 #${bookId} 索引完成，相关推荐 ${n} 条`)
}

registerTask({ type: 'embed_index', priority: 20, singleton: true, maxRetries: 1 }, (ctx) =>
  embedIndexRunner(ctx.refId ?? 0, ctx)
)
registerTask({ type: 'embed_science', priority: 20, singleton: true, maxRetries: 1 }, (ctx) =>
  embedScienceRunner(ctx.refId ?? 0, ctx)
)
registerTask({ type: 'embed_book', priority: 20, singleton: true, maxRetries: 1 }, (ctx) =>
  embedBookRunner(ctx.refId ?? 0, ctx)
)
