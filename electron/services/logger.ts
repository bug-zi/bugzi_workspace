// 日志库服务（主进程，260927 新功能开发区）：统一 logger——console 镜像 + 落库 + 实时广播。
// 全部主进程关键日志经 logInfo/logWarn/logError 入 app_logs（DB v64）；
// 7 天留存清理 cleanupOldLogs 由 scheduler.ts 启动 + 零点两处调用。
// 自举防护：落库失败静默置降级标记（本进程不再尝试落库，只保留 console），
// 防「记录日志的日志」递归；initDb 之前的调用同样走降级（DB_NOT_INITIALIZED 被吞）。
import { BrowserWindow } from 'electron'
import { getDb, nowIso } from '../db/db'
import type { AppLogRow, LogListQuery, LogLevel, LogScope } from '../../src/shared/types'

/** 单日入库上限：超出删当日最旧（防异常刷屏撑库） */
const DAILY_CAP = 2000
/** 广播合批窗口（ms）：500ms 内多条一包推渲染层 */
const FLUSH_MS = 500
/** 留存天数 */
const RETAIN_DAYS = 7

let degraded = false
let pending: AppLogRow[] = []
let flushTimer: NodeJS.Timeout | null = null

function win(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

function queueBroadcast(row: AppLogRow): void {
  pending.push(row)
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const rows = pending
    pending = []
    try {
      win()?.webContents.send('log:appended', rows)
    } catch {
      /* 窗口未就绪/已销毁：静默（行已落库，面板打开时拉得到） */
    }
  }, FLUSH_MS)
  flushTimer.unref?.()
}

/** 入库 + 单日上限裁剪；任何失败置降级标记只走 console */
function insert(row: AppLogRow): void {
  if (degraded) return
  try {
    const d = getDb()
    d.prepare('INSERT INTO app_logs (ts, level, scope, message) VALUES (?, ?, ?, ?)').run(
      row.ts,
      row.level,
      row.scope,
      row.message
    )
    const today = row.ts.slice(0, 10)
    const cnt = d
      .prepare('SELECT COUNT(*) AS n FROM app_logs WHERE ts LIKE ?')
      .get(`${today}%`) as { n: number }
    const n = Number(cnt?.n ?? 0)
    if (n > DAILY_CAP) {
      d.prepare(
        'DELETE FROM app_logs WHERE id IN (SELECT id FROM app_logs WHERE ts LIKE ? ORDER BY id ASC LIMIT ?)'
      ).run(`${today}%`, n - DAILY_CAP)
    }
  } catch {
    degraded = true
  }
}

function emit(level: LogLevel, scope: LogScope, message: string, err?: unknown): void {
  let msg = message
  if (err != null) {
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err)
    if (stack) msg += `\n${stack}`
  }
  if (level === 'error') console.error(msg)
  else if (level === 'warn') console.warn(msg)
  else console.log(msg)
  const row: AppLogRow = { id: 0, ts: nowIso(), level, scope, message: msg }
  insert(row)
  queueBroadcast(row)
}

export function logInfo(scope: LogScope, message: string): void {
  emit('info', scope, message)
}

export function logWarn(scope: LogScope, message: string, err?: unknown): void {
  emit('warn', scope, message, err)
}

export function logError(scope: LogScope, message: string, err?: unknown): void {
  emit('error', scope, message, err)
}

/** 7 天留存清理（scheduler 启动 + 零点调用，静默）。返回清理条数。 */
export function cleanupOldLogs(): number {
  try {
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 24 * 3600 * 1000).toISOString()
    const r = getDb().prepare('DELETE FROM app_logs WHERE ts < ?').run(cutoff)
    return Number(r.changes)
  } catch {
    return 0
  }
}

/** 游标分页查询：beforeId 不传 = 首页；可选 scope / keyword 过滤；返回新→旧。 */
export function listLogs(q: LogListQuery): AppLogRow[] {
  const where: string[] = []
  const args: (string | number)[] = []
  if (q.beforeId != null) {
    where.push('id < ?')
    args.push(q.beforeId)
  }
  if (q.scope) {
    where.push('scope = ?')
    args.push(q.scope)
  }
  if (q.keyword && q.keyword.trim()) {
    // LIKE 通配符转义（用户输入 % _ \ 按字面匹配）
    const kw = q.keyword.trim().replace(/[\\%_]/g, '\\$&')
    where.push(`message LIKE ? ESCAPE '\\'`)
    args.push(`%${kw}%`)
  }
  const sql = `SELECT id, ts, level, scope, message FROM app_logs${
    where.length ? ' WHERE ' + where.join(' AND ') : ''
  } ORDER BY id DESC LIMIT ?`
  args.push(q.limit ?? 200)
  return getDb().prepare(sql).all(...args) as unknown as AppLogRow[]
}

/** 7 天窗口内各 scope 计数（筛选下拉用）；无日志的 scope 返回 0。 */
export function scopeCounts(): Record<LogScope, number> {
  const out: Record<LogScope, number> = {
    system: 0,
    agent: 0,
    scheduler: 0,
    stock: 0,
    llm: 0,
    podcast: 0,
    library: 0,
    whoami: 0
  }
  try {
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 24 * 3600 * 1000).toISOString()
    const rows = getDb()
      .prepare('SELECT scope, COUNT(*) AS n FROM app_logs WHERE ts >= ? GROUP BY scope')
      .all(cutoff) as unknown as { scope: LogScope; n: number }[]
    for (const r of rows) if (r.scope in out) out[r.scope] = Number(r.n)
  } catch {
    /* 降级：全 0 */
  }
  return out
}

/** 清空全部日志（渲染层二次确认后调用）。返回清除条数。 */
export function clearLogs(): number {
  const r = getDb().prepare('DELETE FROM app_logs').run()
  return Number(r.changes)
}
