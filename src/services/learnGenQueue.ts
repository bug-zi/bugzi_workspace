// 学习库生成队列全局 store（260912 AI 活动面板设计）：队列状态自 LearnModule 提取为渲染层单例——
// LearnModule 负责入队与行内就绪回写，LlmActivity 全局面板同源读取排队项并可直接取消。
// 泵逻辑随迁：按入队顺序起 GEN_LANES 线并行调 learn:getCard；单张失败经 onFail 上抛（UI 层定提示口径）。
import { useSyncExternalStore } from 'react'

export interface LearnQueueItem {
  id: number
  title: string
  phase: 'queued' | 'loading'
}

export interface LearnQueueSnapshot {
  /** 递增版本号（订阅比对用） */
  version: number
  /** 排队 + 生成中全部项（入队序） */
  items: LearnQueueItem[]
  /** 查单卡相位；null = 不在队列 */
  phaseOf: (id: number) => 'queued' | 'loading' | null
}

type Listener = () => void

/** 并行生成线数（优化区2 定稿值随迁） */
const GEN_LANES = 3

let version = 0
const items: LearnQueueItem[] = []
const waiting: { id: number; title: string }[] = []
const jobIds = new Map<number, string>()
let active = 0
const listeners = new Set<Listener>()

let snap: LearnQueueSnapshot = { version: 0, items: [], phaseOf: () => null }

function rebuild(): void {
  version++
  const map = new Map(items.map((i) => [i.id, i.phase] as const))
  snap = { version, items: [...items], phaseOf: (id) => map.get(id) ?? null }
  for (const l of listeners) l()
}

export function subscribeLearnQueue(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function getLearnQueueSnapshot(): LearnQueueSnapshot {
  return snap
}

/** React 消费口（LearnModule 行相位/面板计数同源） */
export function useLearnQueue(): LearnQueueSnapshot {
  return useSyncExternalStore(subscribeLearnQueue, getLearnQueueSnapshot)
}

/** 就绪/失败回调（LearnModule 注册：就绪回写行 content_ready，失败定 toast/去配置口径） */
let handlers: {
  onReady: (id: number) => void
  onFail: (id: number, title: string, msg: string) => void
} = {
  onReady: () => {},
  onFail: () => {}
}

export function setLearnQueueHandlers(h: Partial<typeof handlers>): void {
  handlers = { ...handlers, ...h }
}

function pump(): void {
  while (active < GEN_LANES && waiting.length > 0) {
    const job = waiting.shift() as { id: number; title: string }
    active += 1
    const jobId = crypto.randomUUID()
    jobIds.set(job.id, jobId)
    const it = items.find((i) => i.id === job.id)
    if (it) it.phase = 'loading'
    rebuild()
    window.api.learn
      .getCard(jobId, job.id)
      .then(() => handlers.onReady(job.id))
      .catch((e: unknown) => handlers.onFail(job.id, job.title, String((e as Error).message)))
      .finally(() => {
        jobIds.delete(job.id)
        const idx = items.findIndex((i) => i.id === job.id)
        if (idx >= 0) items.splice(idx, 1)
        active -= 1
        rebuild()
        pump()
      })
  }
}

/** 入队（已在队列中则忽略）；入队即起泵 */
export function enqueueLearnGen(item: { id: number; title: string }): void {
  if (items.some((i) => i.id === item.id)) return
  items.push({ ...item, phase: 'queued' })
  waiting.push({ id: item.id, title: item.title })
  rebuild()
  pump()
}

/** 取消单项：排队中直接移出；生成中经 ai:cancel 中止（Promise 拒绝后泵 finally 统一清理） */
export function cancelLearnGen(id: number): void {
  const jobId = jobIds.get(id)
  if (jobId != null) {
    void window.api.ai.cancel(jobId)
    return
  }
  const wi = waiting.findIndex((w) => w.id === id)
  if (wi >= 0) waiting.splice(wi, 1)
  const idx = items.findIndex((i) => i.id === id)
  if (idx >= 0) items.splice(idx, 1)
  rebuild()
}

/** 全部取消（AI 面板「全部取消」用）：生成中的逐个中止、排队中的逐个移出 */
export function cancelAllLearnGen(): void {
  for (const it of [...items]) cancelLearnGen(it.id)
}
