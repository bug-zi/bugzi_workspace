// 学习库每日要求与备学池服务（2026-09-15-每日要求-design.md §三/§四，仿 wikiStock.ts 静默惯例）：
// ①每日定档：当天首次触发写 learn_daily 行——goal = 8-10 随机（当日定档不重抽）+ 到期复习 ≤10 张，
//   纯 SQL 不依赖 LLM；②备学池泵：保证 todo 且 content_ready=1 存量 ≥10 张（领域轮转均摊补生成），
//   用户树上点开/随机来一条/手动添加全部秒开；③连胜推导与本地时间戳工具。
// 全部调用点 fire-and-forget（void 调用），永不抛错、永不弹窗；LLM 未配置静默跳过（定档照常）。
// 泵三触发：main.ts 启动延迟 10s / 进学习库模块（learn:stockCheck）/ mark learn 消耗后；
// 另 scheduler.ts 午夜零点触发（跨天常驻时定档新日 goal）。
import { BrowserWindow } from 'electron'
import { getDb } from '../db/db'
import { generateLearnCard, isLlmConfigured, localDateStr } from '../ai/services'
import { runPumpJob } from '../ai/jobs'

/** 复习每日上限（原设计 §四沿用：防假期后复习雪崩，超出部分次日查询自然再含——零成本顺延） */
const REVIEW_DAILY_CAP = 10

/** 备学池目标存量（每日要求设计 §四：todo 且已生成卡保底张数） */
const POOL_TARGET = 10

/** 单飞标志：防并发重入 */
let pumping = false

/** 每张卡片生成完推送（照 wiki:stockChanged 模式，渲染层列表/树进度渐进刷新） */
function notifyStockChanged(): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send('learn:stockChanged')
}

/** 本地日期 + n 天（YYYY-MM-DD）：mark 复习间隔与连胜日期算术共用 */
export function addDaysLocal(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return localDateStr(d)
}

/** 本地时间 ISO（learned_at 用；nowIso() 是 UTC，跨午夜会错日，故不用——与 localDateStr 同口径） */
export function localNowIso(): string {
  const n = new Date()
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}T${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`
}

/** 每日定档（同步、幂等、纯 SQL）：learn_daily 已有今日行即跳过。
 *  goal = 8 + random(0..2)；复习 = 到期未毕业卡按到期日升序取前 10。不依赖 LLM。 */
export function ensureDailyQueue(): void {
  const d = getDb()
  const today = localDateStr()
  const has = d.prepare('SELECT date FROM learn_daily WHERE date = ?').get(today)
  if (has) return
  const reviewIds = (
    d
      .prepare(
        `SELECT id FROM learn_nodes WHERE state = 'learned' AND deleted_at IS NULL
         AND review_stage BETWEEN 1 AND 4 AND next_review_at IS NOT NULL AND next_review_at <= ?
         ORDER BY next_review_at LIMIT ${REVIEW_DAILY_CAP}`
      )
      .all(today) as { id: number }[]
  ).map((r) => r.id)
  const goal = 8 + Math.floor(Math.random() * 3) // 8..10（每日要求：当日随机定档不重抽）
  d.prepare('INSERT OR IGNORE INTO learn_daily (date, goal, review_ids) VALUES (?, ?, ?)').run(
    today,
    goal,
    JSON.stringify(reviewIds)
  )
}

/** 连胜（每日要求设计 §三）：从今日（done=1 则含今日，否则从昨日起算）往回数 learn_daily.done=1
 *  连续天数；缺行或 0 即断。同思维墙 wallStreak 推导口径；done 显式落库，删卡不影响历史。 */
export function learnStreak(): number {
  const d = getDb()
  const today = localDateStr()
  const todayRow = d.prepare('SELECT done FROM learn_daily WHERE date = ?').get(today) as
    | { done: number }
    | undefined
  const startOffset = todayRow?.done ? 0 : -1
  let streak = 0
  for (let i = 0; i < 3650; i++) {
    const row = d.prepare('SELECT done FROM learn_daily WHERE date = ?').get(addDaysLocal(startOffset - i)) as
      | { done: number }
      | undefined
    if (row?.done) streak++
    else break
  }
  return streak
}

/** 备学池泵（唯一入口）：先确保今日已定档，再保证 todo 且 content_ready=1 存量 ≥ POOL_TARGET；
 *  不足则从 todo 未生成卡中领域洗牌轮转均摊补生成；单张失败 warn 后继续，残留下次触发补齐。 */
export async function ensureLearnStock(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    ensureDailyQueue() // 定档纯 SQL，先于 LLM 检查执行
    if (!isLlmConfigured()) {
      console.warn('[learnStock] LLM 未配置，备学池泵跳过（定档已就绪，配置后下次触发补齐）')
      return
    }
    const d = getDb()
    const ready = d
      .prepare(
        "SELECT COUNT(*) AS c FROM learn_nodes WHERE deleted_at IS NULL AND state = 'todo' AND content_ready = 1"
      )
      .get() as { c: number }
    if (ready.c >= POOL_TARGET) return
    const need = POOL_TARGET - ready.c
    const domains = d.prepare('SELECT id FROM learn_domains WHERE tree_ready = 1').all() as { id: number }[]
    const pools = domains
      .map((dom) => ({
        nodes: d
          .prepare(
            "SELECT id, title FROM learn_nodes WHERE domain_id = ? AND level = 2 AND state = 'todo' AND content_ready = 0 AND deleted_at IS NULL"
          )
          .all(dom.id) as { id: number; title: string }[]
      }))
      .filter((p) => p.nodes.length > 0)
    const picked: { id: number; title: string }[] = []
    const shuffled = pools.slice().sort(() => Math.random() - 0.5)
    for (let i = 0; picked.length < need && shuffled.some((p) => p.nodes.length > 0); i++) {
      const p = shuffled[i % shuffled.length]
      if (p.nodes.length === 0) continue
      picked.push(p.nodes.splice(Math.floor(Math.random() * p.nodes.length), 1)[0])
    }
    if (picked.length === 0) return
    console.info(`[learnStock] 备学池补充开始：${picked.length} 张（现存量 ${ready.c}）`)
    for (const n of picked) {
      try {
        await runPumpJob('learn', (sig) => generateLearnCard(n.id, sig))
        notifyStockChanged()
        console.info(`[learnStock] 备学池卡片就绪「${n.title}」`)
      } catch (e) {
        console.warn(`[learnStock] 卡片「${n.title}」生成失败，下次触发补齐：`, (e as Error).message)
      }
    }
    console.info('[learnStock] 备学池补充结束')
  } finally {
    pumping = false
  }
}
