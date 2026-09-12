// 学习库每日队列与预生成服务（2026-09-11-学习库-design.md §四/§五，仿 wikiStock.ts 静默惯例）：
// 两件事——①每日队列：当天首次触发时定档（新卡 3-5 张领域轮转均摊 + 到期复习 ≤10 张），
// 纯 SQL 不依赖 LLM（骨架即队列，内容由泵后台补齐）；②预生成泵：为今日队列中 content_ready=0
// 的新卡逐张生成完整卡片 md（复习卡已有内容天然秒开）。
// 全部调用点 fire-and-forget（void 调用），永不抛错、永不弹窗；LLM 未配置静默跳过（队列照常定档）。
// 泵三触发：main.ts 启动延迟 10s / 每日队列生成后（内部衔接）/ 进入学习库模块（learn:stockCheck）；
// 另 scheduler.ts 午夜零点触发（跨天常驻时定档新日队列）。
import { BrowserWindow } from 'electron'
import { getDb } from '../db/db'
import { generateLearnCard, isLlmConfigured, localDateStr } from '../ai/services'
import { runPumpJob } from '../ai/jobs'

/** 复习每日上限（设计 §四：防假期后复习雪崩，超出部分次日查询自然再含——零成本顺延） */
const REVIEW_DAILY_CAP = 10

/** 单飞标志：防并发重入 */
let pumping = false

/** 每张卡片生成完推送（照 wiki:stockChanged 模式，渲染层今日列表/树进度渐进刷新） */
function notifyStockChanged(): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send('learn:stockChanged')
}

/** 本地日期 + n 天（YYYY-MM-DD）：mark 复习间隔与队列日期算术共用 */
export function addDaysLocal(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return localDateStr(d)
}

/** 每日队列定档（同步、幂等、纯 SQL）：learn_daily 已有今日行即跳过。
 *  新卡 = 3-5 张（当日随机数），从全部 tree_ready 领域的 todo 知识点中领域洗牌轮转均摊
 *  （同 wikiStock 每日批次口径）；复习 = 到期未毕业卡按到期日升序取前 10。
 *  不依赖 LLM：队列先行，内容由 ensureLearnStock 后台补。 */
export function ensureDailyQueue(): void {
  const d = getDb()
  const today = localDateStr()
  const has = d.prepare('SELECT date FROM learn_daily WHERE date = ?').get(today)
  if (has) return
  const domains = d.prepare('SELECT id FROM learn_domains WHERE tree_ready = 1').all() as {
    id: number
  }[]
  const pools = domains
    .map((dom) => ({
      nodes: d
        .prepare(
          "SELECT id FROM learn_nodes WHERE domain_id = ? AND level = 2 AND state = 'todo' AND deleted_at IS NULL"
        )
        .all(dom.id) as { id: number }[]
    }))
    .filter((p) => p.nodes.length > 0)
  const newIds: number[] = []
  if (pools.length > 0) {
    const count = 3 + Math.floor(Math.random() * 3) // 3..5（每天随机）
    const shuffled = pools.slice().sort(() => Math.random() - 0.5)
    for (let i = 0; newIds.length < count && shuffled.some((p) => p.nodes.length > 0); i++) {
      const p = shuffled[i % shuffled.length]
      if (p.nodes.length === 0) continue
      newIds.push(p.nodes.splice(Math.floor(Math.random() * p.nodes.length), 1)[0].id)
    }
  }
  const reviewIds = (
    d
      .prepare(
        `SELECT id FROM learn_nodes WHERE state = 'learned' AND deleted_at IS NULL
         AND review_stage BETWEEN 1 AND 4 AND next_review_at IS NOT NULL AND next_review_at <= ?
         ORDER BY next_review_at LIMIT ${REVIEW_DAILY_CAP}`
      )
      .all(today) as { id: number }[]
  ).map((r) => r.id)
  d.prepare('INSERT OR IGNORE INTO learn_daily (date, new_ids, review_ids) VALUES (?, ?, ?)').run(
    today,
    JSON.stringify(newIds),
    JSON.stringify(reviewIds)
  )
}

/** 预生成泵（唯一入口）：先确保今日队列已定档，再为队列中 content_ready=0 的新卡逐张串行生成；
 *  单张失败 warn 后继续下一张，残留给下次触发补齐（不做退避重试，YAGNI 同 wikiStock）。 */
export async function ensureLearnStock(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    ensureDailyQueue() // 队列定档纯 SQL，先于 LLM 检查执行（设计 §四：定档不依赖 LLM）
    if (!isLlmConfigured()) {
      console.warn('[learnStock] LLM 未配置，预生成泵跳过（今日队列已定档，配置后下次触发补齐）')
      return
    }
    const d = getDb()
    const row = d
      .prepare('SELECT new_ids FROM learn_daily WHERE date = ?')
      .get(localDateStr()) as { new_ids: string } | undefined
    if (!row) return
    const ids = JSON.parse(row.new_ids) as number[]
    if (ids.length === 0) return
    const needy = d
      .prepare(
        `SELECT id, title FROM learn_nodes WHERE deleted_at IS NULL AND state = 'todo'
         AND content_ready = 0 AND id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids) as { id: number; title: string }[]
    if (needy.length === 0) return
    console.info(`[learnStock] 今日新卡预生成开始：${needy.length} 张`)
    for (const n of needy) {
      try {
        await runPumpJob('learn', (sig) => generateLearnCard(n.id, sig))
        notifyStockChanged()
        console.info(`[learnStock] 卡片就绪「${n.title}」`)
      } catch (e) {
        console.warn(`[learnStock] 卡片「${n.title}」生成失败，下次触发补齐：`, (e as Error).message)
      }
    }
    console.info('[learnStock] 今日新卡预生成结束')
  } finally {
    pumping = false
  }
}
