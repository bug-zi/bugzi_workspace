// 推理角题库预生成补充泵（v1.3 设计 260907，仿 scheduler.ts 静默惯例）：
// 汤库 fresh 存量与 wall_pool 题池低于低水位时，后台补到目标值——消除三处取题「现场等 AI」。
// 全部调用点 fire-and-forget（void 调用），永不抛错、永不弹窗；单批瞬态失败（中转 5xx/网络抖动）
// 自动重试至多 3 次（间隔 25s），仍败或质量类失败才 console.warn 跳出、待下次触发再补。
// 三触发点：main.ts 启动延迟 10s / 每次消耗后（ipc.ts）/ 进入推理角模块（reasoning:stockCheck）。
// 与手动「来 3 碗汤」并发无碍：手动入口不经泵，各自独立插库，最坏多 3 碗
// （但两路并发挤同一中转通道易诱发 429/502，首填时段尽量避免手动出汤）。
import { BrowserWindow } from 'electron'
import { getDb, nowIso } from '../db/db'
import {
  generateSoups,
  generateWallPuzzle,
  isLlmConfigured,
  WALL_TYPE_LIST
} from '../ai/services'
import type { WallPuzzleType } from '../ai/services'

/** 汤库 fresh 存量目标/低水位（设计定稿：常量写死不进 settings，YAGNI） */
export const SOUP_TARGET = 10
export const SOUP_LOW = 5
/** wall_pool 题池目标/低水位 */
export const PUZZLE_TARGET = 10
export const PUZZLE_LOW = 5

/** 瞬态失败重试（中转通道 502/503 上游瞬断、网络抖动属常态）：逐次退避，用尽仍败才上抛 */
const RETRY_DELAYS_MS = [20_000, 40_000, 80_000]

/**
 * 通道持续不可用时的自愈重排：整轮瞬态中断后每 5 分钟自动重跑泵，最多连续推迟 6 次
 * （约 30 分钟窗口，覆盖晚间高峰过载），期间任一单位补充成功即清零重启计数；
 * 用尽则静默放弃，待用户侧触发（消耗/进模块/重启）再试。避免无界后台重试打扰。
 */
const POSTPONE_DELAY_MS = 5 * 60_000
const POSTPONE_MAX = 6
let postponeCount = 0
let postponeTimer: NodeJS.Timeout | null = null

function schedulePostponeReRun(): void {
  if (postponeTimer) return // 已有重排在途（汤/题两路同轮失败只排一次）
  if (postponeCount >= POSTPONE_MAX) {
    console.warn(
      `[reasoningStock] 通道持续不可用，已连续推迟 ${POSTPONE_MAX} 次，本轮放弃——待下次消耗/进模块/重启再试`
    )
    return
  }
  postponeCount++
  console.info(
    `[reasoningStock] 通道暂不可用，${POSTPONE_DELAY_MS / 60_000} 分钟后自动再试（${postponeCount}/${POSTPONE_MAX}）`
  )
  postponeTimer = setTimeout(() => {
    postponeTimer = null
    void ensureReasoningStock()
  }, POSTPONE_DELAY_MS)
  postponeTimer.unref?.()
}

/** 单例标志：防并发重入（启动/消耗后/进模块三触发点叠投时只跑一趟） */
let pumping = false

/** 瞬态 LLM 错误判定——只重试通道类错误；质量类失败（审题不过/字段缺失）重试无意义，原样上抛 */
function isTransientLlmError(e: unknown): boolean {
  return /LLM 服务返回 (5\d\d|429)|网络请求失败/.test(String((e as Error)?.message ?? ''))
}

/**
 * 单批瞬态失败重试：逐次退避（20s/40s/80s），非瞬态错误或次数用尽原样上抛。
 * 任一次成功即清零自愈重排计数（通道已恢复）。
 * （chatCompletion 只内重试 429；502/503 等上游瞬断若不在泵这层兜，一次抖动即废整轮补充——
 * 而泵的「下次触发」要等用户再消耗/再进模块，首填时段太稀疏。）
 */
async function retryTransient<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fn()
      postponeCount = 0
      return r
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientLlmError(e)) throw e
      const wait = RETRY_DELAYS_MS[attempt] / 1000
      console.warn(
        `[reasoningStock] ${label}遇瞬态错误，${wait}s 后重试（${attempt + 1}/${RETRY_DELAYS_MS.length}）：`,
        (e as Error).message
      )
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
    }
  }
}

/** 每补完一批推送（照 recycle:changed 模式，渲染层汤库列表渐进刷新） */
function notifyStockChanged(): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send('reasoning:stockChanged')
}

/** 汤库存量：fresh 且未软删（回收站软删的不算；恢复回收站 fresh 汤使存量回升，无碍） */
function freshSoupCount(): number {
  return (
    getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM turtle_soups WHERE status = 'fresh' AND deleted_at IS NULL"
      )
      .get() as { n: number }
  ).n
}

/** 题池存量 */
function poolCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM wall_pool').get() as { n: number }).n
}

/** 题面摘要入避免清单（照 ensureToday 口径压平 60 字） */
function summarize(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 60)
}

/** 补汤：fresh 存量 < SOUP_LOW 时整批循环补到目标（每批 3 碗、难度错开；近 200 碗避免清单天然覆盖 fresh 存货） */
async function pumpSoups(): Promise<void> {
  while (freshSoupCount() < SOUP_TARGET) {
    const r = await retryTransient('补汤', () => generateSoups('random'))
    notifyStockChanged()
    console.info(`[reasoningStock] 补汤一批 +${r.inserted}（fresh 现 ${freshSoupCount()}）`)
    if (r.inserted === 0) {
      // 整批审题全灭——质量类失败，重试无意义，跳出待下次触发（避免死循环空转）
      console.warn('[reasoningStock] 补汤一批零入库，跳出待下次触发')
      break
    }
  }
}

/** 三档难度/四题型里随机挑一个（并列稀缺时等概率） */
function randomOf<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

/** 补题：池数 < PUZZLE_LOW 时逐道补到目标。难度 = 池内最稀缺档（保证连胜升到任何档位都有货，
 * 并列随机）；题型 = 池内 + 近 2 日历史合计最少见（保持池内题型多样）；避免清单 = 近 20 题
 * wall_puzzles 题面摘要 + 池内全部题面摘要（池 ≤10 道 ×60 字，prompt 长度无虞，防池内互相同构）。 */
async function pumpPuzzles(): Promise<void> {
  while (poolCount() < PUZZLE_TARGET) {
    const d = getDb()
    const diffCount: Record<string, number> = { easy: 0, medium: 0, hard: 0 }
    for (const r of d
      .prepare('SELECT difficulty, COUNT(*) AS n FROM wall_pool GROUP BY difficulty')
      .all() as { difficulty: string; n: number }[]) {
      diffCount[r.difficulty] = r.n
    }
    const minDiff = Math.min(...Object.values(diffCount))
    const difficulty = randomOf(
      (['easy', 'medium', 'hard'] as const).filter((x) => diffCount[x] === minDiff)
    )

    const typeCount = new Map<string, number>(WALL_TYPE_LIST.map((t) => [t, 0]))
    for (const r of d
      .prepare('SELECT puzzle_type, COUNT(*) AS n FROM wall_pool GROUP BY puzzle_type')
      .all() as { puzzle_type: string; n: number }[]) {
      typeCount.set(r.puzzle_type, (typeCount.get(r.puzzle_type) ?? 0) + r.n)
    }
    // 近 2 日已出题型计入（与 ensureToday 题型轮换同口径：转正时也优先避开）
    for (const r of d
      .prepare('SELECT puzzle_type FROM wall_puzzles ORDER BY date DESC LIMIT 2')
      .all() as { puzzle_type: string }[]) {
      typeCount.set(r.puzzle_type, (typeCount.get(r.puzzle_type) ?? 0) + 1)
    }
    const minType = Math.min(...typeCount.values())
    const type = randomOf(WALL_TYPE_LIST.filter((t) => (typeCount.get(t) ?? 0) === minType))

    const avoid = (
      d
        .prepare('SELECT puzzle_text FROM wall_puzzles ORDER BY date DESC LIMIT 20')
        .all() as { puzzle_text: string }[]
    ).map((r) => summarize(r.puzzle_text))
    avoid.push(
      ...(d.prepare('SELECT puzzle_text FROM wall_pool').all() as { puzzle_text: string }[]).map(
        (r) => summarize(r.puzzle_text)
      )
    )

    const draft = await retryTransient('题池生成', () =>
      generateWallPuzzle(difficulty, { type, avoid })
    )
    d.prepare(
      'INSERT INTO wall_pool (title, puzzle_text, answer_standard, standard_reasoning, hints, puzzle_type, difficulty, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      draft.title ?? '',
      draft.puzzle,
      draft.answer,
      draft.reasoning,
      JSON.stringify(draft.hints),
      draft.type,
      draft.difficulty,
      nowIso()
    )
    notifyStockChanged()
    console.info(
      `[reasoningStock] 题池 +1（${draft.difficulty}/${draft.type}，现 ${poolCount()}）`
    )
  }
}

/**
 * 确保推理角题库存量（唯一入口）：存量达标即秒回不置位。LLM 未配置 → 静默跳过
 * （console.warn，手动按钮/开局入口照全局规则 8 弹「去配置」不受影响）；单批失败
 * warn 跳出，下次触发再补——泵永不抛错、永不弹窗。
 *
 * 补充顺序：**题池先、汤库后**——每日一题/练习场是最高频的「等出题」痛点（设计定稿依据），
 * 且首填时段最长（约 20 趟 LLM 调用）；汤侧点击 fresh 汤开局本就秒开、另有手动按钮兜底，
 * 排在后不伤体验。两路各自容错互不阻断：一路失败另一路照补。
 */
export async function ensureReasoningStock(): Promise<void> {
  if (pumping) return
  const soups = freshSoupCount()
  const puzzles = poolCount()
  if (soups >= SOUP_LOW && puzzles >= PUZZLE_LOW) return
  pumping = true
  try {
    if (!isLlmConfigured()) {
      console.warn('[reasoningStock] LLM 未配置，题库补充泵跳过')
      return
    }
    console.info(`[reasoningStock] 补充开始：汤库 fresh ${soups}/${SOUP_LOW} · 题池 ${puzzles}/${PUZZLE_LOW}（目标各 ${SOUP_TARGET}/${PUZZLE_TARGET}）`)
    try {
      await pumpPuzzles()
    } catch (e) {
      console.warn('[reasoningStock] 题池补充中断：', e)
      // 通道类错误（过载/瞬断）→ 自愈重排，几分钟后自动再试；质量类失败等下次用户侧触发
      if (isTransientLlmError(e)) schedulePostponeReRun()
    }
    try {
      await pumpSoups()
    } catch (e) {
      console.warn('[reasoningStock] 汤库补充中断：', e)
      if (isTransientLlmError(e)) schedulePostponeReRun()
    }
    console.info(`[reasoningStock] 补充结束：汤库 fresh ${freshSoupCount()} · 题池 ${poolCount()}`)
  } finally {
    pumping = false
  }
}
