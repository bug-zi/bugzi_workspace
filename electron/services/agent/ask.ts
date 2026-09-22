// 文献·追问上下文注入（超级工作台 2.0 批次C + 批次D/E）：定位/新建 literature 场景会话，
// 注入文献/科普/书籍上下文（导读/解读产物 || 摘要 + 全文截 40k，全文走 wrapMaterial 包裹），
// 同会话同文献幂等；注入后经 'ai:message' 推送（AiSidebar followSession 推送必达自动跟随）。
// 标记口径：paper=<<<LIT:{id}>>>、science=<<<LIT:SA:{id}>>>、book=<<<LIT:B:{id}>>>
// （aiChat 的 LIKE '%<<<LIT:%' 匹配零改动）。
import { BrowserWindow } from 'electron'
import { getDb } from '../../db/db'
import {
  getActiveSessionId,
  createAiSession,
  setActiveSessionId,
  appendAiMessage
} from '../../ai/services'
import { mdRead } from '../files'
import { wrapMaterial } from './guardrails'
import { getPaper, readFulltext } from './papers'
import { getScienceArticle, readScienceFulltext } from './science'
import { readBookFulltext } from './booktext'

const LIT_INPUT_MAX = 40000

export type LiteratureOwner =
  | { type: 'paper'; id: number }
  | { type: 'science'; id: number }
  | { type: 'book'; id: number }

interface LitContext {
  mark: string
  title: string
  authors: string[]
  when: string
  url: string
  digest: string
  summary: string
  full: string
}

function paperContext(id: number): LitContext | null {
  const paper = getPaper(id)
  if (!paper) return null
  const digest = paper.digest_md
    ? (() => {
        try {
          return mdRead(paper.digest_md!)
        } catch {
          return ''
        }
      })()
    : ''
  return {
    mark: `<<<LIT:${paper.id}>>>`,
    title: paper.title,
    authors: paper.authors,
    when: paper.date ?? (paper.year != null ? String(paper.year) : ''),
    url: paper.url,
    digest,
    summary: paper.summary,
    full: readFulltext(paper.id) ?? ''
  }
}

function scienceContext(id: number): LitContext | null {
  const article = getScienceArticle(id)
  if (!article) return null
  // 解读产物优先（translation || light），其次摘要，全文节选兜底
  const rows = getDb()
    .prepare(
      "SELECT md_path FROM interpretations WHERE owner_type = 'science_article' AND owner_id = ? AND kind IN ('translation','light') AND status = 'done' ORDER BY CASE kind WHEN 'translation' THEN 0 ELSE 1 END LIMIT 1"
    )
    .all(id) as { md_path: string | null }[]
  const product = rows[0]?.md_path
    ? (() => {
        try {
          return mdRead(rows[0].md_path!)
        } catch {
          return ''
        }
      })()
    : ''
  return {
    mark: `<<<LIT:SA:${article.id}>>>`,
    title: article.title,
    authors: article.authors,
    when: article.date ?? (article.year != null ? String(article.year) : ''),
    url: article.url,
    digest: product,
    summary: product ? '' : article.summary,
    full: product ? '' : readScienceFulltext(article.id) ?? ''
  }
}

function bookContext(id: number): LitContext | null {
  const book = getDb().prepare('SELECT id, title, author FROM books WHERE id = ?').get(id) as
    | { id: number; title: string; author: string }
    | undefined
  if (!book) return null
  const rows = getDb()
    .prepare(
      "SELECT md_path FROM interpretations WHERE owner_type = 'book' AND owner_id = ? AND kind = 'book_digest' AND status = 'done' ORDER BY id DESC LIMIT 1"
    )
    .all(id) as { md_path: string | null }[]
  const digest = rows[0]?.md_path
    ? (() => {
        try {
          return mdRead(rows[0].md_path!)
        } catch {
          return ''
        }
      })()
    : ''
  return {
    mark: `<<<LIT:B:${book.id}>>>`,
    title: book.title,
    authors: book.author ? [book.author] : [],
    when: '',
    url: '',
    digest,
    summary: '',
    full: digest ? '' : readBookFulltext(book.id) ?? ''
  }
}

export function startLiteratureAsk(owner: LiteratureOwner): { sessionId: number } {
  const ctx =
    owner.type === 'paper'
      ? paperContext(owner.id)
      : owner.type === 'science'
        ? scienceContext(owner.id)
        : bookContext(owner.id)
  if (!ctx) throw new Error('NOT_FOUND')
  let sid = getActiveSessionId('literature')
  if (sid == null) {
    const s = createAiSession(`文献追问：${ctx.title.slice(0, 20)}`, 'literature')
    setActiveSessionId(s.id, 'literature')
    sid = s.id
  }
  // 同会话同文献只注一次（换文献再追问会注入新上下文，LLM 取最新一条）
  const dup = getDb()
    .prepare(
      "SELECT id FROM ai_messages WHERE session_id = ? AND role = 'system' AND content LIKE ?"
    )
    .get(sid, `%${ctx.mark}%`)
  if (!dup) {
    const parts: string[] = [
      `【文献上下文】${ctx.mark}《${ctx.title}》`,
      ctx.authors.length ? `作者：${ctx.authors.slice(0, 8).join(', ')}` : '',
      ctx.when ? `时间：${ctx.when}` : '',
      ctx.url ? `链接：${ctx.url}` : '',
      '',
      ctx.digest
        ? `—— 解读产物 ——\n${ctx.digest}`
        : ctx.summary
          ? `—— 摘要 ——\n${ctx.summary}`
          : '',
      ctx.full ? `—— 全文（节选） ——\n${wrapMaterial('文章全文', ctx.full.slice(0, LIT_INPUT_MAX))}` : ''
    ]
    const msg = appendAiMessage('system', parts.filter(Boolean).join('\n\n'), null, sid)
    BrowserWindow.getAllWindows()[0]?.webContents.send('ai:message', msg)
  }
  return { sessionId: sid }
}
