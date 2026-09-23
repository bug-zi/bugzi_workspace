// 学习库备学池服务（2026-09-15-每日要求-design.md §四，仿 wikiStock.ts 静默惯例）：
// 备学池泵：保证 todo 且 content_ready=1 存量 ≥10 张（领域轮转均摊补生成），
// 用户树上点开/随机来一条/手动添加全部秒开；连胜推导与本地时间戳工具供面经题库共用。
// 每日定档已迁 interviewBank.ts（260924 面经题库化：learn_daily 所有权随刷题化迁移）。
// 泵三触发：main.ts 启动延迟 10s / 进学习库模块（learn:stockCheck）/ mark learn 消耗后；
// 另 scheduler.ts 午夜零点触发。
import { BrowserWindow } from 'electron'
import { getDb } from '../db/db'
import { generateLearnCard, isLlmConfigured, localDateStr } from '../ai/services'
import { runPumpJob } from '../ai/jobs'

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

/** 备学池泵（唯一入口）：保证 todo 且 content_ready=1 存量 ≥ POOL_TARGET；
 *  不足则从 todo 未生成卡中领域洗牌轮转均摊补生成；单张失败 warn 后继续，残留下次触发补齐。 */
export async function ensureLearnStock(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    if (!isLlmConfigured()) {
      console.warn('[learnStock] LLM 未配置，备学池泵跳过（配置后下次触发补齐）')
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
