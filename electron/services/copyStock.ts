// 副本库补库泵（specs §4）：待读区 < COPY_LOW 自动补到 COPY_TARGET（照 wikiStock 简洁风格）
// 260925 v2「泵可视化」：库存即待读区页签（用户可浏览/删除），维持 10-12 篇
// 触发点：main.ts 启动延迟 10s / copy:chooseDaily 或删除/丢弃消耗后 / 进模块（copy:stockCheck）
import { BrowserWindow } from 'electron'
import { getDb } from '../db/db'
import { runPumpJob } from '../ai/jobs'
import { isLlmConfigured } from '../ai/services'
import { COPY_CATEGORIES, COPY_MOODS, COPY_ERAS } from '../../src/shared/types'
import { composePoolCopy } from './copy'

export const COPY_TARGET = 12
export const COPY_LOW = 10

/** 单飞标志：防并发重入（三触发点叠投时只跑一趟） */
let pumping = false

/** 每补完一条推送（照 wiki:stockChanged 模式，渲染层每日候选渐进刷新） */
function notifyStockChanged(): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send('copies:stockChanged')
}

/** 待选池存量 */
export function poolCount(): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM copies WHERE state = 'pool' AND deleted_at IS NULL")
      .get() as { n: number }
  ).n
}

const rnd = <T,>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]

/** 随机三维标签：避开近 20 条完全相同组合（10 次尝试不中则任意） */
function pickTags(): { category: string; mood: string; era: string } {
  const rows = getDb()
    .prepare('SELECT category, mood, era FROM copies WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 20')
    .all() as { category: string; mood: string; era: string }[]
  const used = new Set(rows.map((r) => `${r.category}|${r.mood}|${r.era}`))
  for (let i = 0; i < 10; i++) {
    const t = { category: rnd(COPY_CATEGORIES), mood: rnd(COPY_MOODS), era: rnd(COPY_ERAS) }
    if (!used.has(`${t.category}|${t.mood}|${t.era}`)) return t
  }
  return { category: rnd(COPY_CATEGORIES), mood: rnd(COPY_MOODS), era: rnd(COPY_ERAS) }
}

/** 逐条串行补到目标；单条失败（含用户从活动面板取消泵任务）warn 后终止本轮，待下次触发 */
async function pumpPool(): Promise<void> {
  while (poolCount() < COPY_TARGET) {
    try {
      const tags = pickTags()
      const r = await runPumpJob('copy', (sig) => composePoolCopy(tags, sig))
      notifyStockChanged()
      console.info(`[copyStock] 补池 +1《${r.title}》（现 ${poolCount()}）`)
    } catch (e) {
      console.warn('[copyStock] 单条生成失败，终止本轮：', (e as Error).message)
      return
    }
  }
}

/** 确保待选库存量（唯一入口）：永不抛错、永不弹窗 */
export async function ensureCopyStock(): Promise<void> {
  if (pumping) return
  if (poolCount() >= COPY_LOW) return
  pumping = true
  try {
    if (!isLlmConfigured()) {
      console.warn('[copyStock] LLM 未配置，副本补库泵跳过')
      return
    }
    console.info(`[copyStock] 补充开始：池 ${poolCount()}/${COPY_LOW}（目标 ${COPY_TARGET}）`)
    await pumpPool()
    console.info(`[copyStock] 补充结束：池 ${poolCount()}`)
  } finally {
    pumping = false
  }
}
