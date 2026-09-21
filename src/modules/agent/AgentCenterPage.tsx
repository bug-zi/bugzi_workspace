// 任务中心（超级工作台 2.0 批次C spec §2）：引擎相位/负载/预算 + 待终选直达 + 任务台账。
// 临时主栏视图（照 NoisePage 先例，不 keep-alive 不占模块列表），呼吸灯点击进入。
import { useCallback, useEffect, useState } from 'react'
import { MODULE_NAVIGATE_EVENT } from '../../App'
import { useToast } from '../../components/Toast'
import { SettingsKeys } from '../../shared/types'
import type { AgentDayStats, AgentStatusSnapshot, TaskRunRow } from '../../renderer/api'

const TYPE_LABEL: Record<string, string> = {
  collect_deep: '深读海选',
  collect_science: '科普海选',
  make_digest: '导读卡',
  lecture: '精讲',
  translate: '精译',
  embed_index: '向量索引',
  book_digest: '书籍解读',
  load_pause: '负载暂停',
  load_resume: '负载恢复'
}

const TRIGGER_LABEL: Record<TaskRunRow['trigger'], string> = {
  scheduled: '定时',
  manual: '手动',
  auto: '链式'
}

const STATUS_LABEL: Record<TaskRunRow['status'], string> = {
  running: '进行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过'
}

function fmtDur(startedAt: string, finishedAt: string | null): string {
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  const sec = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000))
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m${sec % 60}s`
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export default function AgentCenterPage() {
  const { toast } = useToast()
  const [stats, setStats] = useState<AgentDayStats | null>(null)
  const [status, setStatus] = useState<AgentStatusSnapshot | null>(null)
  const [runs, setRuns] = useState<TaskRunRow[]>([])
  const [enabled, setEnabled] = useState(false)

  const load = useCallback((): void => {
    void window.api.agent.dayStats().then((s) => {
      setStats(s)
      setEnabled(s.enabled)
    })
    void window.api.agent.runsList(100).then(setRuns)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const off = window.api.agent.onAgentStatus((s) => {
      setStatus(s)
      // 任务终态时刷新台账与统计
      if (s.lastEvent && s.lastEvent.status !== 'enqueued') load()
    })
    return off
  }, [load])

  const toggleEngine = (on: boolean): void => {
    setEnabled(on)
    void window.api.agent.configSet(SettingsKeys.AgentEnabled, on ? '1' : '0')
    toast(on ? '超级工作台引擎已开启' : '引擎已关闭')
  }

  const goToDiscover = (): void => {
    window.dispatchEvent(new CustomEvent(MODULE_NAVIGATE_EVENT, { detail: { module: 'feed', target: 'literature' } }))
  }

  const phase = status?.phase ?? stats?.phase ?? 'idle'
  const cpu = status?.cpu ?? 0
  const memFree = status?.memFreeBytes ?? 0
  const memTotal = status?.memTotalBytes ?? 0
  const memPct = memTotal > 0 ? Math.round(((memTotal - memFree) / memTotal) * 100) : 0
  const budget = status?.budgetUsedToday ?? stats?.budgetToday ?? 0

  return (
    <div className="module-page" style={{ maxWidth: 1100 }}>
      <div className="module-header">
        <span className="material-symbols-outlined">smart_toy</span>
        <span className="module-title">任务中心</span>
        <span className="module-sub">超级工作台 · 后台任务台账与状态</span>
      </div>

      {/* 状态条 */}
      <div className="card zl-row" style={{ flexWrap: 'wrap', cursor: 'default' }}>
        <span
          className={`badge ${(phase === 'working' && 'primary') || ''}`}
          title={status?.pauseReason ?? undefined}
        >
          {phase === 'working' ? '工作中' : phase === 'paused' ? `已暂停${status?.pauseReason ? `（${status.pauseReason}）` : ''}` : '空闲'}
        </span>
        <span className="module-sub">
          CPU {Math.round(cpu)}% · 内存 {memPct}%
        </span>
        <span className="module-sub">今日额度 {budget.toLocaleString()} token</span>
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.85em' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => toggleEngine(e.target.checked)}
            style={{ accentColor: 'var(--color-primary)' }}
          />
          引擎
        </label>
      </div>

      {/* 待办行 */}
      <button className="card zl-row" onClick={goToDiscover} title="去信息源·文献页签终选">
        <span className="material-symbols-outlined">inbox</span>
        <span className="zl-row-title">发现箱待终选</span>
        <span className="module-sub">
          {stats == null ? '加载失败' : stats.pendingDiscover > 0 ? `${stats.pendingDiscover} 条候选等待你的决定` : '暂无待终选'}
        </span>
      </button>

      {/* 台账表 */}
      <div className="card" style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          <span className="setting-label">任务台账（最近 100 条）</span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={load}>
            <span className="material-symbols-outlined">refresh</span>
            刷新
          </button>
        </div>
        {runs.length === 0 ? (
          <div className="empty-state">
            <span className="material-symbols-outlined">history</span>
            还没有任务记录——跑一轮海选或接受一篇文献后这里会出现台账
          </div>
        ) : (
          <div className="lit-list" style={{ maxHeight: '52vh' }}>
            {runs.map((r) => (
              <div className="lit-item" key={r.id} style={{ padding: '7px 10px' }}>
                <div className="row-main">
                  <div className="row-title" style={{ fontSize: '0.92em' }}>
                    {TYPE_LABEL[r.task_type] ?? r.task_type}
                    <span className="badge" style={{ marginLeft: 8 }}>
                      {TRIGGER_LABEL[r.trigger]}
                    </span>
                    <span
                      className={`badge ${r.status === 'failed' ? '' : r.status === 'done' ? 'primary' : ''}`}
                      style={{ marginLeft: 6 }}
                    >
                      {STATUS_LABEL[r.status]}
                    </span>
                  </div>
                  <div className="row-sub">
                    {fmtTime(r.started_at)}
                    {r.finished_at ? ` · 耗时 ${fmtDur(r.started_at, r.finished_at)}` : ' · 进行中'}
                    {r.tokens_used > 0 ? ` · ${r.tokens_used.toLocaleString()} token` : ''}
                    {r.error ? ` · ${r.error}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
