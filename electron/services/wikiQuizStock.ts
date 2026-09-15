// 万象库测一测题库泵（2026-09-16-测一测题库制-design.md §三/§四，仿 wikiStock.ts 静默惯例）：
// 每个 learned 词条常备 QUIZ_PER_ENTRY(2) 题在库，毕业（答对 2 次）即删题 + 词条熟练度 +1。
// 三触发：main.ts 启动延迟 10s / wiki:quizDraw 抽题消耗后 / 进万象库模块（wiki:stockCheck 挂靠）。
// fire-and-forget、永不抛错、永不弹窗；LLM 未配置静默跳过。
import { BrowserWindow } from 'electron'
import { getDb, nowIso } from '../db/db'
import { isLlmConfigured, generateEntryQuiz, type WikiQuizQuestion } from '../ai/services'
import { runPumpJob } from '../ai/jobs'
import { mdRead } from './files'

/** 每 learned 词条在库题数目标（设计定稿：2 题，同词条新题换角度防背答案） */
export const QUIZ_PER_ENTRY = 2
/** 毕业线：答对净次数达此值即删题 + 词条熟练度 +1 */
export const QUIZ_GRADUATE_AT = 2
/** 每次触发最多补几个词条（防启动风暴） */
const QUIZ_BATCH_ENTRIES = 5

/** 单飞标志：防并发重入（三触发点叠投时只跑一趟） */
let pumping = false

/** 每批入库后推送（复用 wiki:stockChanged，渲染层渐进刷新） */
function notifyStockChanged(): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send('wiki:stockChanged')
}

/** 词条在库题数 */
export function bankCountOf(entryId: number): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM wiki_quiz_bank WHERE entry_id = ?')
      .get(entryId) as { n: number }
  ).n
}

/** 抽题（wiki:quizDraw 用）：低熟练度词条优先（graduated 升序）、同级词条间随机、
 *  同词条一轮最多 1 题（组内随机取 1）；排除软删在站词条的题。 */
export function drawWikiQuiz(limit = 5): {
  bankId: number
  entryId: number
  term: string
  question: string
  options: string[]
  answer: number
  explanation: string
  graduated: number
}[] {
  const d = getDb()
  const rows = d
    .prepare(
      `SELECT b.id AS bank_id, b.entry_id, b.question, b.options, b.answer, b.explanation,
              e.term AS term, e.quiz_graduated AS graduated
       FROM wiki_quiz_bank b JOIN wiki_entries e ON e.id = b.entry_id
       WHERE e.deleted_at IS NULL AND e.state = 'learned'
       ORDER BY e.quiz_graduated ASC`
    )
    .all() as {
    bank_id: number
    entry_id: number
    question: string
    options: string
    answer: number
    explanation: string
    term: string
    graduated: number
  }[]
  // 同词条最多 1 题：按词条分组、组内随机取 1
  const byEntry = new Map<number, typeof rows>()
  for (const r of rows) {
    const g = byEntry.get(r.entry_id)
    if (g) g.push(r)
    else byEntry.set(r.entry_id, [r])
  }
  const picked = [...byEntry.values()].map((g) => g[Math.floor(Math.random() * g.length)])
  // 同熟练度档内洗牌（同级随机），档间保持低熟练度优先
  const byGrad = new Map<number, typeof picked>()
  for (const p of picked) {
    const g = byGrad.get(p.graduated)
    if (g) g.push(p)
    else byGrad.set(p.graduated, [p])
  }
  const ordered = [...byGrad.keys()]
    .sort((a, b) => a - b)
    .flatMap((k) => byGrad.get(k)!.sort(() => Math.random() - 0.5))
  return ordered.slice(0, limit).map((r) => ({
    bankId: r.bank_id,
    entryId: r.entry_id,
    term: r.term,
    question: r.question,
    options: JSON.parse(r.options) as string[],
    answer: r.answer,
    explanation: r.explanation,
    graduated: r.graduated
  }))
}

/** 题面入库（兜底生成与泵共用；兜底题入库使记账全链路单一口径——设计 §四） */
export function insertQuizBankRows(qs: WikiQuizQuestion[]): void {
  const d = getDb()
  const ins = d.prepare(
    'INSERT INTO wiki_quiz_bank (entry_id, question, options, answer, explanation, correct_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
  )
  for (const q of qs) {
    ins.run(q.entryId, q.question, JSON.stringify(q.options), q.answer, q.explanation, nowIso())
  }
}

/** 作答记账（wiki:quizRecord，每题提交即调）：答对 +1 达毕业线删题 + 词条熟练度 +1（同事务）；
 *  答错 −1 地板 0。 */
export function recordQuizAnswer(bankId: number, isCorrect: boolean): void {
  const d = getDb()
  if (!isCorrect) {
    d.prepare('UPDATE wiki_quiz_bank SET correct_count = MAX(0, correct_count - 1) WHERE id = ?').run(bankId)
    return
  }
  d.exec('BEGIN')
  try {
    const row = d.prepare('SELECT entry_id, correct_count FROM wiki_quiz_bank WHERE id = ?').get(bankId) as
      | { entry_id: number; correct_count: number }
      | undefined
    if (!row) {
      d.exec('ROLLBACK')
      return
    }
    if (row.correct_count + 1 >= QUIZ_GRADUATE_AT) {
      d.prepare('DELETE FROM wiki_quiz_bank WHERE id = ?').run(bankId)
      d.prepare('UPDATE wiki_entries SET quiz_graduated = quiz_graduated + 1 WHERE id = ?').run(row.entry_id)
    } else {
      d.prepare('UPDATE wiki_quiz_bank SET correct_count = ? WHERE id = ?').run(row.correct_count + 1, bankId)
    }
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
}

/** 题库补充泵（唯一入口）：挑在库题数 < 目标的 learned 词条（按 id 序，每批最多 5 个），
 *  逐词条读卡文调 LLM 各出 2 题入库；单词条失败跳过不废批。 */
export async function ensureWikiQuizStock(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    if (!isLlmConfigured()) {
      console.warn('[wikiQuizStock] LLM 未配置，测一测题库泵跳过')
      return
    }
    const needy = getDb()
      .prepare(
        `SELECT e.id, e.term, e.md_path FROM wiki_entries e
         WHERE e.deleted_at IS NULL AND e.state = 'learned'
           AND (SELECT COUNT(*) FROM wiki_quiz_bank b WHERE b.entry_id = e.id) < ${QUIZ_PER_ENTRY}
         ORDER BY e.id LIMIT ${QUIZ_BATCH_ENTRIES}`
      )
      .all() as { id: number; term: string; md_path: string }[]
    if (needy.length === 0) return
    console.info(`[wikiQuizStock] 题库补充开始：${needy.map((e) => e.term).join(' · ')}`)
    for (const entry of needy) {
      try {
        // 并发触发下该词条可能已被上一轮补齐
        if (bankCountOf(entry.id) >= QUIZ_PER_ENTRY) continue
        let md = ''
        try {
          md = await mdRead(entry.md_path)
        } catch {
          /* md 缺失的词条跳过 */
        }
        if (!md) continue
        const existing = (
          getDb().prepare('SELECT question FROM wiki_quiz_bank WHERE entry_id = ?').all(entry.id) as {
            question: string
          }[]
        ).map((r) => r.question)
        const qs = await runPumpJob('wikiQuiz', (sig) =>
          generateEntryQuiz(entry.term, entry.id, md, existing, sig)
        )
        insertQuizBankRows(qs)
        notifyStockChanged()
        console.info(`[wikiQuizStock]「${entry.term}」题库 +${qs.length}（现 ${bankCountOf(entry.id)}）`)
      } catch (e) {
        console.warn(`[wikiQuizStock]「${entry.term}」出题失败，跳过：`, (e as Error).message)
      }
    }
    console.info('[wikiQuizStock] 题库补充结束')
  } finally {
    pumping = false
  }
}
