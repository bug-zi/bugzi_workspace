// 面经题库服务（2026-09-24-面经题库化-design.md §三/§五）：learn_daily 定档所有权随刷题化
// 自 learnStock 迁入——goal/review_ids 语义改为「每日刷题数 8-10 / 到期题目 ≤10」；定档纯 SQL
// 零 LLM；连胜复用 learnStock.learnStreak（同表推导）。触发：main.ts 启动延迟 / scheduler
// 午夜零点 / interview:daily 与 interview:stockCheck 处理器内幂等调用。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, userDataDir } from '../db/db'
import { localDateStr } from '../ai/services'
import { localNowIso } from './learnStock'

/** 复习每日上限（防雪崩顺延机制，同 learnStock.REVIEW_DAILY_CAP 口径） */
const REVIEW_DAILY_CAP = 10

/** 每日定档（同步、幂等、纯 SQL）：learn_daily 已有今日行即跳过。goal = 8 + random(0..2)；
 *  到期复习 = 题目到期未毕业按到期日升序取前 10。不依赖 LLM。 */
export function ensureInterviewDaily(): void {
  const d = getDb()
  const today = localDateStr()
  const has = d.prepare('SELECT date FROM learn_daily WHERE date = ?').get(today)
  if (has) return
  const reviewIds = (
    d
      .prepare(
        `SELECT id FROM interview_questions WHERE state = 'learned' AND deleted_at IS NULL
         AND review_stage BETWEEN 1 AND 4 AND next_review_at IS NOT NULL AND next_review_at <= ?
         ORDER BY next_review_at LIMIT ${REVIEW_DAILY_CAP}`
      )
      .all(today) as { id: number }[]
  ).map((r) => r.id)
  const goal = 8 + Math.floor(Math.random() * 3)
  d.prepare('INSERT OR IGNORE INTO learn_daily (date, goal, review_ids) VALUES (?, ?, ?)').run(
    today,
    goal,
    JSON.stringify(reviewIds)
  )
}

/** 题干规范化（查重键）：去首尾空白 + 小写 + 去全部空白与中英文常用标点 */
export function questionNorm(s: string): string {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。？！、：；「」『』“”‘’（）()《》【】\[\]{},.?!:;'"`~\-_—…·<>\\|/]/g, '')
}

/** 全部分类名（搜集拆题 prompt 注入与分类解析用，sort 升序） */
export function listCategoryNames(): string[] {
  return (
    getDb()
      .prepare('SELECT name FROM interview_categories ORDER BY sort, id')
      .all() as { name: string }[]
  ).map((r) => r.name)
}

/** 写待审核暂存答案 md（md/learn/intake/<intakeId>.md，相对路径与 learn/wiki md 同口径），返回相对路径 */
export function writeIntakeMd(intakeId: number, question: string, answerMd: string): string {
  const absDir = join(userDataDir(), 'md', 'learn', 'intake')
  mkdirSync(absDir, { recursive: true })
  const rel = `md/learn/intake/${intakeId}.md`
  writeFileSync(join(userDataDir(), rel), `# ${question}\n\n${answerMd.trim()}\n`, 'utf-8')
  return rel
}

/** 插入待审核行（md 需 intakeId 命名文件，两步：插行取 id → 写 md → 回填路径） */
export function insertIntake(input: {
  categoryId: number | null
  question: string
  norm: string
  answerMd: string
  source: string
  batchId: number
}): number {
  const d = getDb()
  const r = d
    .prepare(
      "INSERT INTO interview_intake (category_id, question, question_norm, answer_path, source, batch_id, status, created_at) VALUES (?, ?, ?, '', ?, ?, 'pending', ?)"
    )
    .run(input.categoryId, input.question, input.norm, input.source, input.batchId, localNowIso())
  const id = Number(r.lastInsertRowid)
  const path = writeIntakeMd(id, input.question, input.answerMd)
  d.prepare('UPDATE interview_intake SET answer_path = ? WHERE id = ?').run(path, id)
  return id
}

/** 今日刷题数（interview:mark 的 done 联动判定用；本地日期口径与 learnStock 同） */
export function interviewLearnedToday(): number {
  const d = getDb()
  const today = localDateStr()
  return (
    d
      .prepare(
        'SELECT COUNT(*) AS c FROM interview_questions WHERE deleted_at IS NULL AND learned_at IS NOT NULL AND substr(learned_at, 1, 10) = ?'
      )
      .get(today) as { c: number }
  ).c
}
