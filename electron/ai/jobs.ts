// AI 任务注册表（主进程）：渲染层 jobId → AbortController；统一取消通道 ai:cancel 的后端
// （260908 全局取消，docs/project/全局/2026-09-08-AI生成全局取消-design.md）
const jobs = new Map<string, AbortController>()

export function beginJob(jobId: string): AbortController {
  const ac = new AbortController()
  jobs.set(jobId, ac)
  return ac
}

export function endJob(jobId: string): void {
  jobs.delete(jobId)
}

/** 取消任务；false = 任务已结束/不存在（重复点无害静默） */
export function cancelJob(jobId: string): boolean {
  const ac = jobs.get(jobId)
  if (!ac) return false
  ac.abort()
  jobs.delete(jobId)
  return true
}

/** 由 signal 反查 jobId（AI 活动面板取消钮用，260912 面板设计）：任务表量级小，遍历比对开销可忽略 */
export function findJobIdBySignal(signal: AbortSignal): string | null {
  for (const [jobId, ac] of jobs) if (ac.signal === signal) return jobId
  return null
}

let pumpJobSeq = 0

/** 泵任务包装（AI 活动面板可取消后台预生成，260912 面板设计）：登记 jobId（随 llm:activity 广播
 *  供面板反查取消）+ AbortController 贯穿 LLM 调用；fn 抛错（含取消）原样上抛由泵侧 catch。
 *  取消语义 = 跳过当前这张/批，泵循环继续下一项。 */
export async function runPumpJob<T>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const jobId = `pump-${label}-${++pumpJobSeq}`
  const ac = beginJob(jobId)
  try {
    return await fn(ac.signal)
  } finally {
    endJob(jobId)
  }
}

/** 阶段间取消检查：已取消即抛「已取消」（渲染层据此走轻提示，不弹错误框） */
export function ensureNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已取消')
}
