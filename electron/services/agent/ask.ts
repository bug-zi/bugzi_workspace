// 文献·追问上下文注入（超级工作台 2.0 批次C spec §1）：定位/新建 literature 场景会话，
// 注入文献上下文（导读卡 || 摘要 + 全文截 40k，全文走 wrapMaterial 包裹），同会话同文献幂等；
// 注入后经 'ai:message' 推送（AiSidebar followSession 推送必达自动跟随）。
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

const LIT_INPUT_MAX = 40000

function litMark(paperId: number): string {
  return `<<<LIT:${paperId}>>>`
}

export function startLiteratureAsk(paperId: number): { sessionId: number } {
  const paper = getPaper(paperId)
  if (!paper) throw new Error('NOT_FOUND')
  let sid = getActiveSessionId('literature')
  if (sid == null) {
    const s = createAiSession(`文献追问：${paper.title.slice(0, 20)}`, 'literature')
    setActiveSessionId(s.id, 'literature')
    sid = s.id
  }
  // 同会话同文献只注一次（换文献再追问会注入新上下文，LLM 取最新一条）
  const dup = getDb()
    .prepare(
      "SELECT id FROM ai_messages WHERE session_id = ? AND role = 'system' AND content LIKE ?"
    )
    .get(sid, `%${litMark(paperId)}%`)
  if (!dup) {
    const digest = paper.digest_md
      ? (() => {
          try {
            return mdRead(paper.digest_md!)
          } catch {
            return ''
          }
        })()
      : ''
    const full = readFulltext(paper.id)
    const parts: string[] = [
      `【文献上下文】${litMark(paperId)}《${paper.title}》`,
      paper.authors.length ? `作者：${paper.authors.slice(0, 8).join(', ')}` : '',
      paper.year || paper.date ? `时间：${paper.date ?? paper.year}` : '',
      `链接：${paper.url}`,
      '',
      digest ? `—— 导读卡 ——\n${digest}` : paper.summary ? `—— 摘要 ——\n${paper.summary}` : '',
      full ? `—— 全文（节选） ——\n${wrapMaterial('论文全文', full.slice(0, LIT_INPUT_MAX))}` : ''
    ]
    const msg = appendAiMessage('system', parts.filter(Boolean).join('\n\n'), null, sid)
    BrowserWindow.getAllWindows()[0]?.webContents.send('ai:message', msg)
  }
  return { sessionId: sid }
}
