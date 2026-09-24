// 赋诗苑服务（2026-09-25-赋诗苑 design.md，designs-specs §1）：每日一令零 LLM 幂等定档
// （关键字池按日轮转，同 ensureInterviewDaily 模式）+ 连胜推导（learnStreak 同构口径）
// + 对局终局落库（两步 INSERT → 写 md → 回填 md_path，insertIntake 同款）。
import { getDb } from '../db/db'
import { localDateStr } from '../ai/services'
import { localNowIso } from './learnStock'
import { mdWrite } from './files'
import { fushiNorm, FEIHUA_KEYWORDS } from '../../src/shared/types'
import type { FeihuaLine, FushiDailyView, FushiGenre, FushiResult } from '../../src/shared/types'

/** 轮转锚点：specs 定稿当日（稳定可复现） */
const KEYWORD_ANCHOR = '2026-09-25'

/** 距锚点日天数（本地日期算术，负数也可） */
function daysSinceAnchor(today: string): number {
  const a = new Date(`${KEYWORD_ANCHOR}T00:00:00`).getTime()
  const t = new Date(`${today}T00:00:00`).getTime()
  return Math.round((t - a) / 86_400_000)
}

/** 每日一令定档（同步幂等零 LLM）：fushi_daily 已有今日行即跳过 */
export function ensureFushiDaily(): void {
  const d = getDb()
  const today = localDateStr()
  const has = d.prepare('SELECT date FROM fushi_daily WHERE date = ?').get(today)
  if (has) return
  const keyword = FEIHUA_KEYWORDS[Math.abs(daysSinceAnchor(today)) % FEIHUA_KEYWORDS.length]
  d.prepare('INSERT OR IGNORE INTO fushi_daily (date, keyword, done) VALUES (?, ?, 0)').run(today, keyword)
}

/** 连胜（learnStreak 同构口径）：自今日（done=1 含今日，否则从昨日）回溯连续 done=1 天数 */
export function fushiStreak(): number {
  const d = getDb()
  const today = localDateStr()
  const todayRow = d.prepare('SELECT done FROM fushi_daily WHERE date = ?').get(today) as
    | { done: number }
    | undefined
  const startOffset = todayRow?.done ? 0 : -1
  let streak = 0
  // 逐日回溯（本地时区口径与 localDateStr 一致，不走 toISOString 防时区错日）
  for (let i = 0; i < 3650; i++) {
    const dt = new Date()
    dt.setDate(dt.getDate() + startOffset - i)
    const p = (x: number): string => String(x).padStart(2, '0')
    const key = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
    const row = d.prepare('SELECT done FROM fushi_daily WHERE date = ?').get(key) as
      | { done: number }
      | undefined
    if (row?.done) streak++
    else break
  }
  return streak
}

/** 每日一令视图（fushi:daily）：定档后读当日行 + 连胜 + 当日每日局 id */
export function fushiDailyView(): FushiDailyView {
  ensureFushiDaily()
  const d = getDb()
  const today = localDateStr()
  const row = d.prepare('SELECT date, keyword, done FROM fushi_daily WHERE date = ?').get(today) as
    | { date: string; keyword: string; done: number }
  const game = d
    .prepare(
      "SELECT id FROM fushi_games WHERE daily = 1 AND substr(created_at, 1, 10) = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1"
    )
    .get(today) as { id: number } | undefined
  return { date: row.date, keyword: row.keyword, done: !!row.done, streak: fushiStreak(), todayGameId: game?.id ?? null }
}

/** 飞花令终局落库：INSERT → 写留档 md → 回填 md_path；daily 局回写当日 done=1 */
export function saveFeihuaGame(input: {
  keyword: string
  daily: boolean
  result: FushiResult
  lines: FeihuaLine[]
}): number {
  const d = getDb()
  const r = d
    .prepare(
      "INSERT INTO fushi_games (type, topic, genre, result, rounds, daily, md_path, created_at) VALUES ('feihua', ?, NULL, ?, ?, ?, '', ?)"
    )
    .run(input.keyword, input.result, input.lines.length, input.daily ? 1 : 0, localNowIso())
  const id = Number(r.lastInsertRowid)
  const md = [
    `# 飞花令 ·「${input.keyword}」`,
    '',
    `- 结果：**${input.result === 'win' ? '我胜' : '我负'}**（共 ${input.lines.length} 句）`,
    `- 类型：${input.daily ? '每日一令' : '自由练'}`,
    `- 时间：${localNowIso().slice(0, 16).replace('T', ' ')}`,
    '',
    '## 对局实录',
    '',
    ...input.lines.map((l, i) =>
      l.side === 'me'
        ? `${i + 1}. **我**：${l.line}`
        : `${i + 1}. **AI**：${l.line}${l.note ? `\n   > ${l.note}` : ''}`
    ),
    ''
  ].join('\n')
  const path = `md/fushi/games/${id}.md`
  mdWrite(path, md)
  d.prepare('UPDATE fushi_games SET md_path = ? WHERE id = ?').run(path, id)
  if (input.daily) {
    d.prepare('UPDATE fushi_daily SET done = 1 WHERE date = ?').run(localDateStr())
  }
  return id
}

/** 斗诗终局落库：INSERT → 写留档 md（题面 + 双方诗 + 四维评分 + 总评）→ 回填 md_path */
export function saveDoushiGame(input: {
  topic: string
  genre: FushiGenre
  result: FushiResult
  myPoem: string
  aiPoem: string
  scores: { cut: number; meter: number; imagery: number; mood: number }
  totalComment: string
}): number {
  const d = getDb()
  const r = d
    .prepare(
      "INSERT INTO fushi_games (type, topic, genre, result, rounds, daily, md_path, created_at) VALUES ('doushi', ?, ?, ?, 1, 0, '', ?)"
    )
    .run(input.topic, input.genre, input.result, localNowIso())
  const id = Number(r.lastInsertRowid)
  const s = input.scores
  const md = [
    `# 斗诗 · ${input.topic}（${input.genre}）`,
    '',
    `- 结果：**${input.result === 'win' ? '我胜' : input.result === 'lose' ? 'AI 胜' : '平局'}**`,
    `- 四维：切题 ${s.cut}/10 · 格律 ${s.meter}/10 · 意象 ${s.imagery}/10 · 意境 ${s.mood}/10`,
    `- 时间：${localNowIso().slice(0, 16).replace('T', ' ')}`,
    '',
    '## 我的诗',
    '',
    input.myPoem,
    '',
    '## AI 的诗',
    '',
    input.aiPoem,
    '',
    '## 总评',
    '',
    input.totalComment,
    ''
  ].join('\n')
  const path = `md/fushi/games/${id}.md`
  mdWrite(path, md)
  d.prepare('UPDATE fushi_games SET md_path = ? WHERE id = ?').run(path, id)
  return id
}

/** 关键字有效性（feihuaTurn 校验用）：非空且归一化后包含关键字 */
export function lineMatchesKeyword(line: string, keyword: string): boolean {
  const norm = fushiNorm(line)
  return norm.length > 0 && norm.includes(fushiNorm(keyword))
}
