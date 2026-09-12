// 万象库待学习区预生成服务（2026-09-10-待学习区与预生成-design.md §三/§四，仿 reasoningStock.ts 静默惯例）：
// 两件事——①后库泵：每板块预生成 POOL_TARGET 张池卡（state='pool'，用户不可见），
// 「随机来一条」抽池秒开、池空才兜底现场生成；②每日批次：每天随机 5-10 张知识卡片
// 尽量平均摊到各板块，直入待学习区（state='learn'）。
// 全部调用点 fire-and-forget（void 调用），永不抛错、永不弹窗；LLM 未配置静默跳过。
// 泵三触发：main.ts 启动延迟 10s / 抽卡消耗后（ipc.ts）/ 进入万象库模块（wiki:stockCheck）。
// 每日批次两触发：main.ts 启动延迟 10s + scheduler.ts 午夜排程（App 跨天常驻不断供）。
// 不做瞬态退避重试/自愈重排（推理角那套保留在推理角；wiki 触发点更密，YAGNI）。
import { BrowserWindow } from 'electron'
import { getDb, nowIso } from '../db/db'
import { getSetting, setSetting } from '../db/settings'
import { SettingsKeys } from '../../src/shared/types'
import { generateWikiCard, isLlmConfigured } from '../ai/services'
import { runPumpJob } from '../ai/jobs'

/** 每板块后库存量目标（需求定稿：每板块 3 张，存量 < 3 立刻补到 3） */
export const WIKI_POOL_TARGET = 3

/** 单飞标志：防并发重入（启动/消耗后/进模块三触发点叠投时只跑一趟） */
let pumping = false
let dailyRunning = false

/** 每张入库后推送（照 reasoning:stockChanged 模式，渲染层待学习列表/计数渐进刷新） */
function notifyWikiStockChanged(): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send('wiki:stockChanged')
}

/** 板块池存量 */
export function poolCountOf(sectionId: number): number {
  return (
    getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM wiki_entries WHERE section_id = ? AND state = 'pool' AND deleted_at IS NULL"
      )
      .get(sectionId) as { n: number }
  ).n
}

/** 本地日期 YYYY-MM-DD（每日批次幂等标记用） */
function todayLocal(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

/** 抽一张后库池卡（wiki:generate 池优先路径）：指定板块抽该板块最旧池卡，未指定全体池卡
 *  均匀随机；抽中原地转 learn 态（id/md 不变，池行即未来词条行本身）。
 *  UPDATE 带 state='pool' 守卫防并发重抽，落空则回 undefined 走现场生成兜底（安全降级）。 */
export function drawPoolCard(
  sectionId: number | null
): { id: number; term: string; summary: string } | undefined {
  const d = getDb()
  const rows = (
    sectionId != null
      ? d
          .prepare(
            "SELECT id, term, summary FROM wiki_entries WHERE state = 'pool' AND section_id = ? AND deleted_at IS NULL ORDER BY id"
          )
          .all(sectionId)
      : d
          .prepare(
            "SELECT id, term, summary FROM wiki_entries WHERE state = 'pool' AND deleted_at IS NULL ORDER BY id"
          )
          .all()
  ) as { id: number; term: string; summary: string }[]
  if (rows.length === 0) return undefined
  const picked = sectionId != null ? rows[0] : rows[Math.floor(Math.random() * rows.length)]
  const r = d
    .prepare("UPDATE wiki_entries SET state = 'learn', updated_at = ? WHERE id = ? AND state = 'pool'")
    .run(nowIso(), picked.id)
  return r.changes === 0 ? undefined : picked
}

/** 补单个板块：板块内逐张串行补到目标；单张失败（含撞词 CONFLICT）warn 后终止该板块本轮 */
async function pumpSection(sectionId: number, sectionName: string): Promise<void> {
  try {
    while (poolCountOf(sectionId) < WIKI_POOL_TARGET) {
      // 板块可能在补充进行中被删：逐张重查，防孤儿池卡
      const exists = getDb().prepare('SELECT id FROM wiki_sections WHERE id = ?').get(sectionId)
      if (!exists) {
        console.warn(`[wikiStock] 板块「${sectionName}」已删除，中止其补充`)
        return
      }
      const r = await runPumpJob('wiki', (sig) => generateWikiCard(null, sectionId, sig, 'pool'))
      notifyWikiStockChanged()
      console.info(
        `[wikiStock] 后库 +1「${r.term}」（${sectionName}，现 ${poolCountOf(sectionId)}）`
      )
    }
  } catch (e) {
    console.warn(`[wikiStock] 板块「${sectionName}」补充中断：`, (e as Error).message)
  }
}

/** 确保后库存量（唯一入口）：任一板块 < 目标即补；板块间并行（Promise.all 各自容错互不阻断）。 */
export async function ensureWikiStock(): Promise<void> {
  if (pumping) return
  const sections = getDb()
    .prepare('SELECT id, name FROM wiki_sections ORDER BY sort')
    .all() as { id: number; name: string }[]
  const needy = sections.filter((s) => poolCountOf(s.id) < WIKI_POOL_TARGET)
  if (needy.length === 0) return
  pumping = true
  try {
    if (!isLlmConfigured()) {
      console.warn('[wikiStock] LLM 未配置，后库补充泵跳过')
      return
    }
    console.info(
      `[wikiStock] 后库补充开始：${needy.map((s) => `${s.name} ${poolCountOf(s.id)}/${WIKI_POOL_TARGET}`).join(' · ')}`
    )
    await Promise.all(needy.map((s) => pumpSection(s.id, s.name)))
    console.info('[wikiStock] 后库补充结束')
  } finally {
    pumping = false
  }
}

/** 每日待学习批次：当天已生成（settings 幂等标记）跳过；数量 5-10 随机、板块洗牌轮转均摊；
 *  LLM 未配置静默跳过且不记日期（当天配置好后下次触发仍可生成）；
 *  ≥1 张成功即记日期（部分成功算当天完成，防重试撞词重复）；零成功不记，下次触发重试整批。 */
export async function ensureDailyLearn(): Promise<void> {
  if (dailyRunning) return
  const today = todayLocal()
  if (getSetting(SettingsKeys.WikiDailyLearnDate) === today) return
  dailyRunning = true
  try {
    if (!isLlmConfigured()) {
      console.warn('[wikiStock] LLM 未配置，每日待学习批次跳过（不记日期，配置后下次触发再生成）')
      return
    }
    const sections = getDb()
      .prepare('SELECT id, name FROM wiki_sections ORDER BY sort')
      .all() as { id: number; name: string }[]
    if (sections.length === 0) return
    const count = 5 + Math.floor(Math.random() * 6) // 5..10（每天随机）
    // 洗牌 + 轮转：配额尽可能平均地摊到各板块（7 张 5 板块 → 2,2,1,1,1）；
    // 轮转交错出卡而非按板块连出，批次中途失败时各板块到手更均匀
    const shuffled = sections.slice().sort(() => Math.random() - 0.5)
    const order = Array.from({ length: count }, (_, i) => shuffled[i % shuffled.length])
    console.info(`[wikiStock] 每日待学习批次开始：今日 ${count} 张（板块均摊）`)
    let inserted = 0
    for (const s of order) {
      try {
        const r = await runPumpJob('wiki', (sig) => generateWikiCard(null, s.id, sig, 'learn'))
        inserted++
        notifyWikiStockChanged()
        console.info(`[wikiStock] 待学习 +1「${r.term}」（${s.name}）`)
      } catch (e) {
        console.warn(`[wikiStock] 板块「${s.name}」本张生成失败，跳过：`, (e as Error).message)
      }
    }
    if (inserted > 0) setSetting(SettingsKeys.WikiDailyLearnDate, today)
    console.info(`[wikiStock] 每日批次结束：成功 ${inserted}/${count}`)
  } finally {
    dailyRunning = false
  }
}
