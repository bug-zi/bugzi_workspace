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

/** 阶段间取消检查：已取消即抛「已取消」（渲染层据此走轻提示，不弹错误框） */
export function ensureNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已取消')
}
