// 全书导读（超级工作台 2.0 批次E spec §2）：book_digest 任务——全文抽取 → 中文导读五节骨架
// （这本书讲什么/全书结构/各部分要点/适合谁/怎么读，与论文线导读卡同风格）；书超长时注入
// 章节清单 + 首尾节选保结构感知。状态以 interpretations 库行为准（running 行重跑自愈，
// 规避 queue.runningRuns 不带 refId 的盲区）；产物 md/interpretations/book-{id}-digest.md。
import { getDb, nowIso } from '../../db/db'
import { chatCompletion } from '../../ai/llm'
import { isLlmConfigured } from '../../ai/services'
import { registerTask, enqueue } from './queue'
import type { TaskContext } from './queue'
import { tokensSince } from './budget'
import { wrapMaterial } from './guardrails'
import { upsertInterpretation, writeInterpretationMd } from './papers'
import { ensureBookFulltext, extractOutline, getBookRow } from './booktext'

const INPUT_MAX = 60000

function ensureAlive(ctx: TaskContext): void {
  if (ctx.signal.aborted) throw new Error('已取消')
}

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

export type BookDigestStatus = 'none' | 'running' | 'done' | 'failed'

export function bookDigestStatus(bookId: number): { status: BookDigestStatus; md_path: string | null } {
  const row = getDb()
    .prepare(
      "SELECT status, md_path FROM interpretations WHERE owner_type = 'book' AND owner_id = ? AND kind = 'book_digest'"
    )
    .get(bookId) as { status: string; md_path: string | null } | undefined
  if (!row) return { status: 'none', md_path: null }
  if (row.status === 'running' || row.status === 'done' || row.status === 'failed') {
    return { status: row.status, md_path: row.md_path }
  }
  return { status: 'none', md_path: null }
}

/** 按需触发；running 抛「进行中」；done 且未 force 抛 INTERPRET_EXISTS（渲染层转确认） */
export function runBookDigest(bookId: number, force = false): number {
  const st = bookDigestStatus(bookId)
  if (st.status === 'running') throw new Error('导读任务正在进行中')
  if (st.status === 'done' && !force) throw new Error('INTERPRET_EXISTS')
  return enqueue('book_digest', { refId: bookId, trigger: 'manual' })
}

function setRowStatus(bookId: number, status: 'running' | 'failed', mdPath?: string): void {
  const d = getDb()
  const now = nowIso()
  const existing = d
    .prepare(
      "SELECT id FROM interpretations WHERE owner_type = 'book' AND owner_id = ? AND kind = 'book_digest'"
    )
    .get(bookId) as { id: number } | undefined
  if (existing) {
    d.prepare('UPDATE interpretations SET status = ?, md_path = COALESCE(?, md_path), updated_at = ? WHERE id = ?').run(
      status,
      mdPath ?? null,
      now,
      existing.id
    )
    return
  }
  d.prepare(
    "INSERT INTO interpretations (owner_type, owner_id, kind, status, md_path, tokens_used, created_at, updated_at) VALUES ('book', ?, 'book_digest', ?, ?, 0, ?, ?)"
  ).run(bookId, status, mdPath ?? null, now, now)
}

async function bookDigestRunner(ctx: TaskContext): Promise<void> {
  const bookId = ctx.refId ?? 0
  const book = getBookRow(bookId)
  if (!book) throw new Error('NOT_FOUND')
  if (!isLlmConfigured()) throw new Error('LLM 未配置')
  // 自愈残留 running 行（App 重启中断）→ failed，再置本轮 running
  setRowStatus(bookId, 'running')
  const delta = tokenTracker('agent:book-digest', ctx)
  try {
    const text = await ensureBookFulltext(book)
    let input = text
    if (text.length > INPUT_MAX) {
      const outline = extractOutline(text)
      input =
        (outline.length ? `【全书章节标题清单】\n${outline.join('\n')}\n\n` : '') +
        `【正文开头】\n${text.slice(0, 50000)}\n\n【正文结尾】\n${text.slice(-10000)}`
    }
    ensureAlive(ctx)
    const res = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: `你是书籍导读助手。请通读以下这本书的材料，用中文生成全书导读，严格按以下骨架输出 Markdown（五个二级标题缺一不可，总长 600-1200 字）：

## 这本书讲什么
## 全书结构
## 各部分要点
## 适合谁
## 怎么读

要求：忠于材料本身，不编造未读到的内容；「全书结构」尽量覆盖全书骨架（材料含章节清单时以清单为准）；「怎么读」给可操作的阅读建议。只输出 Markdown 正文，不要开场白。

书名：${book.title}${book.author ? `　作者：${book.author}` : ''}

${wrapMaterial('书籍材料', input)}`
        }
      ],
      temperature: 0.3,
      scene: 'agent:book-digest',
      signal: ctx.signal
    })
    delta()
    ensureAlive(ctx)
    let md = res.content.replace(/```(?:markdown|md)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
    if (!md) throw new Error('LLM 未返回内容')
    md = md.replace(/^#\s+导读.*\n/gm, '').trim()
    const head = `# 导读：${book.title}\n\n> ${book.author || '佚名'} ｜ 来源：本地书籍\n\n`
    const rel = writeInterpretationMd(`book-${book.id}-digest.md`, head + md + '\n')
    upsertInterpretation('book', book.id, 'book_digest', rel, 0)
    // 完成尾挂语义索引 + 相关推荐（批次F：embed_book；未启用/不可达时 runner 内静默跳过）
    enqueue('embed_book', { refId: book.id, trigger: 'auto' })
  } catch (e) {
    setRowStatus(bookId, 'failed')
    throw e
  }
}

// 任务注册（模块顶层；ipc.ts import 即完成注册，先于任何 enqueue）
registerTask({ type: 'book_digest', priority: 15, singleton: true, maxRetries: 1 }, bookDigestRunner)
