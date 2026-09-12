// AI 实时活动指示 + 全局调用面板（260912 AI 面板：原纯指示器升级为收起/展开双态）——
// 收起态：竖排图标（同右缘细条范式），运行中 > 0 或学习队列排队 > 0 时渲染；「AI ×N」只数运行中，
// 纯排队无运行时显示「队列 N」。点击展开右下角浮层面板：运行中（场景/配置/时长/取消）+
// 排队中（学习库队列等待项，生成中的已在运行中列表体现不重复展示）+ 全部取消 + 收起钮。
// 数据双源：主进程 llm:activity 广播（运行中）+ learnGenQueue store（学习库排队项）。
import { useEffect, useState } from 'react'
import { LLM_SCENE_LABELS } from '../shared/types'
import type { LlmActivityItem } from '../shared/types'
import { cancelAllLearnGen, cancelLearnGen, useLearnQueue } from '../services/learnGenQueue'
import { useToast } from './Toast'

export default function LlmActivity() {
  const [items, setItems] = useState<LlmActivityItem[]>([])
  const [open, setOpen] = useState(false)
  const [, setTick] = useState(0)
  const queue = useLearnQueue()
  const { toast } = useToast()

  useEffect(() => {
    return window.api.llmUsage.onActivity((payload) => setItems(payload.items))
  }, [])

  // 面板展开时每秒刷新运行时长
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setTick((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [open])

  // 排队口径 = 学习库队列的等待项（生成中的已在运行中列表体现，不重复计）
  const waitingItems = queue.items.filter((q) => q.phase === 'queued')
  const runningCount = items.length
  const waitingCount = waitingItems.length
  if (runningCount === 0 && waitingCount === 0) return null

  const durationOf = (startedAt: number): string => {
    const sec = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
    return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
  }

  const cancelAll = (): void => {
    for (const it of items) if (it.jobId != null) void window.api.ai.cancel(it.jobId)
    cancelAllLearnGen()
    toast('已全部取消')
  }

  return (
    <>
      <button
        className={`llm-activity${runningCount === 0 ? ' idle' : ''}`}
        title={open ? '收起 AI 调用面板' : '查看 AI 调用'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="material-symbols-outlined llm-activity-icon">progress_activity</span>
        <span className="llm-activity-label">
          {runningCount > 0 ? `AI${runningCount > 1 ? ` ×${runningCount}` : ''}` : `队列 ${waitingCount}`}
        </span>
      </button>

      {open && (
        <>
          <div className="dialog-overlay" style={{ background: 'transparent' }} onMouseDown={() => setOpen(false)} />
          <div className="llm-panel">
            <div className="llm-panel-header">
              <strong>AI 调用</strong>
              <div className="row-actions">
                <button className="btn" onClick={cancelAll} title="取消全部可取消的调用与排队">
                  <span className="material-symbols-outlined">stop_circle</span>
                  全部取消
                </button>
                <button className="icon-btn" title="收起" onClick={() => setOpen(false)}>
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            </div>
            <div className="llm-panel-body">
              <div className="module-sub llm-panel-sec">运行中 {runningCount}</div>
              {runningCount === 0 && <div className="llm-panel-empty">暂无运行中的调用</div>}
              {items.map((it) => (
                <div className="llm-panel-row" key={it.seq}>
                  <span className="material-symbols-outlined spin llm-panel-icon">progress_activity</span>
                  <div className="llm-panel-main">
                    <div className="llm-panel-title">{LLM_SCENE_LABELS[it.scene] ?? it.scene}</div>
                    <div className="module-sub">
                      {it.configName} · 已运行 {durationOf(it.startedAt)}
                    </div>
                  </div>
                  {it.jobId != null ? (
                    <button
                      className="icon-btn"
                      title="取消此调用"
                      onClick={() => {
                        void window.api.ai.cancel(it.jobId as string)
                        toast('已取消')
                      }}
                    >
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  ) : (
                    <span className="module-sub llm-panel-nocancel" title="后台任务，不可取消">
                      —
                    </span>
                  )}
                </div>
              ))}
              <div className="module-sub llm-panel-sec">排队中 {waitingCount}</div>
              {waitingCount === 0 && <div className="llm-panel-empty">暂无排队任务</div>}
              {waitingItems.map((q) => (
                <div className="llm-panel-row" key={q.id}>
                  <span className="material-symbols-outlined llm-panel-icon">hourglass_top</span>
                  <div className="llm-panel-main">
                    <div className="llm-panel-title">{q.title}</div>
                    <div className="module-sub">学习库 · 排队中</div>
                  </div>
                  <button
                    className="icon-btn"
                    title="移出队列"
                    onClick={() => {
                      cancelLearnGen(q.id)
                      toast('已取消')
                    }}
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )
}
