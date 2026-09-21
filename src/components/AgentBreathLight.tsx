// 左栏底部呼吸灯（超级工作台 2.0 批次C spec §2）：引擎状态一眼可见——
// working=主题色缓脉动 / paused=灰色常驻（悬停原因）/ idle=主题色静默；点击进任务中心。
import { useEffect, useState } from 'react'
import type { AgentStatusSnapshot } from '../renderer/api'

export default function AgentBreathLight(props: { active: boolean; onOpen: () => void }) {
  const [s, setS] = useState<AgentStatusSnapshot | null>(null)

  useEffect(() => {
    return window.api.agent.onAgentStatus(setS)
  }, [])

  const phase = s?.phase ?? 'idle'
  const title =
    phase === 'paused'
      ? `后台已暂停（${s?.pauseReason ?? '负载过高'}）· 点击打开任务中心`
      : phase === 'working'
        ? `后台工作中（${(s?.runningTypes ?? []).length} 个任务）· 点击打开任务中心`
        : '超级工作台待命 · 点击打开任务中心'

  return (
    <button
      className={`nav-item agent-breath agent-breath-${phase}${props.active ? ' active' : ''}`}
      onClick={props.onOpen}
      title={title}
    >
      <span className="material-symbols-outlined">smart_toy</span>
      <span className="nav-label">工作台</span>
    </button>
  )
}
