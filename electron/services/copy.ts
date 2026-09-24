// 副本库业务层（docs/project/左侧边栏/生活模块/副本库/designs-specs.md §4）：
// 每日三选一 / 阅读进度 / 收藏库 / DIY 编排；补库泵见 copyStock.ts
import { getDb, nowIso } from '../db/db'
import { mdRead, mdWrite } from './files'
import { discardToRecycle } from './recycle'
import { ensureCopyStock } from './copyStock'
import {
  localDateStr,
  generateDiyQuestions,
  generateCopyOutline,
  generateCopySection,
  type CopyOutline
} from '../ai/services'
import type { CopyCard, CopyDetail, CopyDailyView, CopyProgress, CopySource, CopyState } from '../../src/shared/types'

interface CopyRow {
  id: number
  title: string
  subtitle: string
  category: string
  mood: string
  era: string
  source: string
  word_count: number
  stage_count: number
  state: string
  progress: string
  md_path: string
  finished_at: string | null
  created_at: string
  updated_at: string
}

const ROW_COLS = 'id, title, subtitle, category, mood, era, source, word_count, stage_count, state, progress, md_path, finished_at, created_at, updated_at'

function parseProgress(raw: string): CopyProgress | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Partial<CopyProgress>
    if (typeof o.stage === 'number' && typeof o.ratio === 'number') return { stage: o.stage, ratio: o.ratio }
  } catch {
    /* 坏数据回落 */
  }
  return null
}

function rowToCard(r: CopyRow): CopyCard {
  return {
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    category: r.category,
    mood: r.mood,
    era: r.era,
    source: r.source as CopySource,
    wordCount: r.word_count,
    stageCount: r.stage_count,
    state: r.state as CopyState,
    progress: parseProgress(r.progress),
    finishedAt: r.finished_at
  }
}

function getRow(id: number): CopyRow | null {
  return (
    (getDb()
      .prepare(`SELECT ${ROW_COLS} FROM copies WHERE id = ? AND deleted_at IS NULL`)
      .get(id) as CopyRow | undefined) ?? null
  )
}

function requireVisibleRow(id: number): CopyRow {
  const r = getRow(id)
  if (!r) throw new Error('COPY_NOT_FOUND')
  return r
}

function detailOf(r: CopyRow): CopyDetail {
  return { ...rowToCard(r), mdPath: r.md_path }
}

function todayStr(): string {
  return localDateStr()
}

function getDailyRow(date: string): { date: string; candidate_ids: string; chosen_id: number | null; finished_at: string | null } | null {
  return (
    (getDb().prepare('SELECT date, candidate_ids, chosen_id, finished_at FROM copy_daily WHERE date = ?').get(date) as
      | { date: string; candidate_ids: string; chosen_id: number | null; finished_at: string | null }
      | undefined) ?? null
  )
}

function candidateIdsOf(row: { candidate_ids: string }): number[] {
  try {
    const arr = JSON.parse(row.candidate_ids) as unknown
    return Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number') : []
  } catch {
    return []
  }
}

/** 抽候选（v2 待读区制，specs §4）：仅从待读区（state='pool'）随机抽 n 条；exclude 优先排除，不足放宽为全区 */
function pickCandidates(exclude: number[], n = 3): CopyRow[] {
  const base = `WHERE deleted_at IS NULL AND state = 'pool'`
  const pick = (ex: number[]): CopyRow[] => {
    const sql = ex.length ? `${base} AND id NOT IN (${ex.map(() => '?').join(',')})` : base
    return getDb()
      .prepare(`SELECT ${ROW_COLS} FROM copies ${sql} ORDER BY RANDOM() LIMIT ?`)
      .all(...ex, n) as unknown as CopyRow[]
  }
  const rows = pick(exclude)
  return rows.length >= n ? rows : pick([])
}

/** copy:daily：当日无行先建（抽 3 写 candidate_ids），三态返回 */
export function daily(): CopyDailyView {
  const date = todayStr()
  let row = getDailyRow(date)
  if (!row) {
    const ids = pickCandidates([]).map((r) => r.id)
    getDb()
      .prepare('INSERT INTO copy_daily (date, candidate_ids) VALUES (?, ?)')
      .run(date, JSON.stringify(ids))
    row = getDailyRow(date)!
  }
  if (row.finished_at) {
    const finished = row.chosen_id != null ? getRow(row.chosen_id) : null
    return {
      phase: 'finished',
      finishedCopy: finished ? rowToCard(finished) : undefined
    }
  }
  if (row.chosen_id != null) {
    const chosen = getRow(row.chosen_id)
    if (!chosen) throw new Error('COPY_NOT_FOUND')
    return { phase: 'reading', chosen: detailOf(chosen) }
  }
  const candidates = candidateIdsOf(row)
    .map((id) => getRow(id))
    .filter((r): r is CopyRow => r !== null)
  return { phase: 'unpicked', candidates: candidates.map(rowToCard) }
}

/** 换一批：仅未选定时可用；重抽排除当前 3 个，不足放宽 */
export function reshuffleDaily(): CopyCard[] {
  const date = todayStr()
  const row = getDailyRow(date)
  if (!row) throw new Error('COPY_NOT_FOUND')
  if (row.chosen_id != null) throw new Error('ALREADY_CHOSEN')
  const fresh = pickCandidates(candidateIdsOf(row))
  const ids = fresh.map((r) => r.id)
  getDb().prepare('UPDATE copy_daily SET candidate_ids = ? WHERE date = ?').run(JSON.stringify(ids), date)
  return fresh.map(rowToCard)
}

/** 选定当日副本：校验候选内；事务转正 + 写 chosen；触发补库泵（消耗后） */
export function chooseDaily(id: number): CopyDetail {
  const date = todayStr()
  const row = getDailyRow(date)
  if (!row) throw new Error('COPY_NOT_FOUND')
  if (row.chosen_id != null) throw new Error('ALREADY_CHOSEN')
  if (!candidateIdsOf(row).includes(id)) throw new Error('NOT_A_CANDIDATE')
  const target = getRow(id)
  if (!target) throw new Error('COPY_NOT_FOUND')
  const db = getDb()
  db.exec('BEGIN')
  try {
    db.prepare("UPDATE copies SET state = 'in_progress', updated_at = ? WHERE id = ? AND state IN ('pool', 'unread')").run(nowIso(), id)
    db.prepare('UPDATE copy_daily SET chosen_id = ? WHERE date = ?').run(id, date)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  void ensureCopyStock()
  const after = getRow(id)
  if (!after) throw new Error('COPY_NOT_FOUND')
  return detailOf(after)
}

/** 打开阅读：pool/unread → in_progress（pool 即离开待读区）；返回详情与正文全文 */
export function readCopy(id: number): { detail: CopyDetail; md: string } {
  const r = requireVisibleRow(id)
  if (r.state === 'unread' || r.state === 'pool') {
    getDb().prepare("UPDATE copies SET state = 'in_progress', updated_at = ? WHERE id = ?").run(nowIso(), id)
    r.state = 'in_progress'
  }
  let md = ''
  try {
    md = mdRead(r.md_path)
  } catch {
    md = `# ${r.title}\n\n（正文文件缺失）`
  }
  return { detail: detailOf(r), md }
}

/** 进度落库（渲染层 3 秒节流调用） */
export function saveProgress(id: number, progress: CopyProgress): void {
  getDb()
    .prepare('UPDATE copies SET progress = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(JSON.stringify(progress), nowIso(), id)
}

/**
 * 读毕（v2 二选处置，specs §4 copy:finish）：state→finished + finished_at（幂等不覆盖）；
 * 当日选定副本首次读毕即打卡（无论存档还是丢弃）。keep=false（丢弃）→ 软删入回收站
 * 「副本库」块（3 天内可反悔，恢复回收藏库已读区）；keep=true → 留收藏库。
 */
export function finishCopy(id: number, keep: boolean): { finishedAt: string } {
  const r = requireVisibleRow(id)
  const now = nowIso()
  const finishedAt = r.finished_at ?? now
  const db = getDb()
  db.exec('BEGIN')
  try {
    db.prepare("UPDATE copies SET state = 'finished', finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE id = ?").run(now, now, id)
    db.prepare('UPDATE copy_daily SET finished_at = ? WHERE date = ? AND chosen_id = ? AND finished_at IS NULL').run(now, todayStr(), id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  if (!keep) discardToRecycle('fuben', id)
  return { finishedAt }
}

/** 收藏库列表（specs §4 copy:list）：非 pool 未软删，updated_at 倒序 */
export function listCopies(filter?: { source?: string; state?: string; tag?: string }): CopyCard[] {
  const conds = ["state != 'pool'", 'deleted_at IS NULL']
  const args: string[] = []
  if (filter?.source) {
    conds.push('source = ?')
    args.push(filter.source)
  }
  if (filter?.state) {
    conds.push('state = ?')
    args.push(filter.state)
  }
  if (filter?.tag) {
    conds.push('(category = ? OR mood = ? OR era = ?)')
    args.push(filter.tag, filter.tag, filter.tag)
  }
  const rows = getDb()
    .prepare(`SELECT ${ROW_COLS} FROM copies WHERE ${conds.join(' AND ')} ORDER BY updated_at DESC`)
    .all(...args) as unknown as CopyRow[]
  return rows.map(rowToCard)
}

/** 删除（软删入回收站「副本库」块；v2 待读区库存同样可删）：当日未读毕的选定副本清 chosen_id 可重选；删后触发泵补货 */
export function discardCopy(id: number): void {
  requireVisibleRow(id)
  discardToRecycle('fuben', id)
  getDb()
    .prepare('UPDATE copy_daily SET chosen_id = NULL WHERE date = ? AND chosen_id = ? AND finished_at IS NULL')
    .run(todayStr(), id)
  void ensureCopyStock()
}

/** 待读区列表（v2，specs §2 PoolPanel）：state='pool' 未软删，created_at 倒序（先到的先看） */
export function poolList(): CopyCard[] {
  const rows = getDb()
    .prepare(`SELECT ${ROW_COLS} FROM copies WHERE state = 'pool' AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`)
    .all() as unknown as CopyRow[]
  return rows.map(rowToCard)
}

/** 近 N 条标题（撞题避免清单，含软删——回收站里的人生也算写过） */
function recentTitles(n: number): string[] {
  return (
    getDb()
      .prepare('SELECT title FROM copies WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ?')
      .all(n) as { title: string }[]
  ).map((r) => r.title)
}

const normTitle = (t: string): string => t.replace(/\s+/g, '')

// ---------- DIY 与泵共用的完整生成管线 ----------

/** 批大小：8-12 阶段 → 3 批左右 */
function chunkStages(stages: string[]): number[] {
  const batches = Math.max(2, Math.min(4, Math.ceil(stages.length / 4)))
  const size = Math.ceil(stages.length / batches)
  const bounds: number[] = []
  for (let i = 0; i < stages.length; i += size) bounds.push(Math.min(i + size, stages.length))
  return bounds
}

export interface ComposeProgress {
  step: 'outline' | 'section'
  current: number
  total: number
}

/**
 * 生成一段完整副本入库（DIY 与补库泵共用）：
 * outline（撞题重拟一次）→ 分批 section → 拼 md → INSERT（source/state 由调用方定）。
 * signal 取消即中止，不落库不写文件。
 */
export async function composeCopyIntoDb(
  opts: { direction?: string; answers?: string[]; tags?: { category: string; mood: string; era: string } },
  source: CopySource,
  state: CopyState,
  onProgress?: (p: ComposeProgress) => void,
  signal?: AbortSignal
): Promise<CopyDetail> {
  const avoid = [...new Set([...recentTitles(30), ...(getDb().prepare("SELECT title FROM copies WHERE state = 'pool' AND deleted_at IS NULL").all() as { title: string }[]).map((r) => r.title)])]
  const avoidNorms = new Set(avoid.map(normTitle))
  let outline = await generateCopyOutline({ ...opts, avoidTitles: avoid }, signal)
  if (avoidNorms.has(normTitle(outline.title))) {
    outline = await generateCopyOutline({ ...opts, avoidTitles: [...avoid, `刚拟过《${outline.title}》请换一个完全不同的标题与思路`] }, signal)
    if (avoidNorms.has(normTitle(outline.title))) throw new Error('COPY_TITLE_DUP')
  }
  onProgress?.({ step: 'section', current: 0, total: chunkStages(outline.stages).length })
  const bounds = chunkStages(outline.stages)
  const parts: string[] = []
  const memo: string[] = []
  for (let i = 0; i < bounds.length; i++) {
    const from = i === 0 ? 0 : bounds[i - 1]
    const to = bounds[i]
    const text = await generateCopySection(outline, from, to, memo.join('\n'), i === bounds.length - 1, signal)
    parts.push(text)
    outline.stages.slice(from, to).forEach((stage, k) => {
      const seg = text.split(/^##\s+/m).slice(1)
      memo.push(`${stage}：${(seg[k]?.replace(/\s+/g, ' ') ?? '').slice(0, 60)}`)
    })
    onProgress?.({ step: 'section', current: i + 1, total: bounds.length })
  }
  const body = parts.join('\n\n')
  const now = nowIso()
  const db = getDb()
  const info = db
    .prepare(
      `INSERT INTO copies (title, subtitle, category, mood, era, source, word_count, stage_count, state, progress, md_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)`
    )
    .run(outline.title, outline.subtitle, outline.category, outline.mood, outline.era, source, body.replace(/^##\s*/gm, '').replace(/\s/g, '').length, outline.stages.length, state, now, now)
  const id = Number(info.lastInsertRowid)
  const mdPath = `md/copies/${id}.md`
  mdWrite(mdPath, `# ${outline.title}\n\n> ${outline.subtitle}\n\n${body}\n`)
  db.prepare('UPDATE copies SET md_path = ? WHERE id = ?').run(mdPath, id)
  const row = getRow(id)
  if (!row) throw new Error('COPY_NOT_FOUND')
  return detailOf(row)
}

// ---------- DIY（specs §4 copy:diyQuestions / copy:diyGenerate） ----------

/** DIY 单飞标志：进行中再入抛 COPY_DIY_BUSY */
let diyRunning = false

export function diyQuestions(direction: string, signal?: AbortSignal): Promise<string[]> {
  return generateDiyQuestions(direction, signal)
}

export async function diyGenerate(
  direction: string,
  answers: string[],
  onProgress: (p: ComposeProgress) => void,
  signal?: AbortSignal
): Promise<CopyDetail> {
  if (diyRunning) throw new Error('COPY_DIY_BUSY')
  diyRunning = true
  try {
    // v2.1：DIY 生成物也入待读区（state=pool，开发者指令 260925），读毕处置与库存一致
    const detail = await composeCopyIntoDb({ direction, answers }, 'diy', 'pool', onProgress, signal)
    return detail
  } finally {
    diyRunning = false
  }
}

/** 泵单条生成入口（copyStock 调用；source=daily、state=pool） */
export function composePoolCopy(
  tags: { category: string; mood: string; era: string },
  signal?: AbortSignal
): Promise<CopyDetail> {
  return composeCopyIntoDb({ tags }, 'daily', 'pool', undefined, signal)
}

/** outline 类型再导出（泵拼 prompt 用） */
export type { CopyOutline }
