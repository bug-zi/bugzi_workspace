// 对弈社模块（2026-09-26 对弈社 design §2）：五页签 中国象棋｜国际象棋｜日本将棋｜五子棋｜围棋
// （板块 keep-alive，切页签不打断对局与 AI 思考），头部战绩角标五棋合计。
import { useCallback, useEffect, useState } from 'react'
import type { DuiyiStats } from '../../renderer/api'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { useToast } from '../../components/Toast'
import XiangqiPane from './xiangqi/XiangqiPane'
import ChessPane from './chess/ChessPane'
import ShogiPane from './shogi/ShogiPane'
import GomokuPane from './gomoku/GomokuPane'
import GoPane from './go/GoPane'
import './duiyi.css'

type Tab = 'xiangqi' | 'chess' | 'shogi' | 'gomoku' | 'go'

export default function DuiyiModule() {
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('xiangqi')
  const [total, setTotal] = useState<DuiyiStats | null>(null)

  const loadTotal = useCallback(async () => {
    try {
      const s = await window.api.duiyi.stats()
      setTotal(s.total)
    } catch (e) {
      toast(`战绩加载失败：${(e as Error).message}`)
    }
  }, [toast])

  useModuleActivated('duiyi', () => void loadTotal())

  // 各 Pane 终局后战绩会变；本模块常驻挂载，靠轻轮询兜底（10s 级，仅一条聚合查询）
  useEffect(() => {
    const t = window.setInterval(() => void loadTotal(), 12000)
    return () => window.clearInterval(t)
  }, [loadTotal])

  return (
    <div className="module-page">
      <div className="module-header">
        <span className="material-symbols-outlined">chess</span>
        <span className="module-title">对弈社</span>
        <span className="module-sub">五棋人机对弈 · 棋谱留档</span>
        <span className="dy-total-badge" title="五棋合计战绩（finished 局）">
          <span className="material-symbols-outlined">military_tech</span>
          <span>
            {total ? `${total.win} 胜 ${total.loss} 负${total.draw > 0 ? ` ${total.draw} 和` : ''}` : '…'}
          </span>
        </span>
      </div>

      <div className="recycle-tabs">
        {(
          [
            ['xiangqi', '中国象棋'],
            ['chess', '国际象棋'],
            ['shogi', '日本将棋'],
            ['gomoku', '五子棋'],
            ['go', '围棋']
          ] as const
        ).map(([key, label]) => (
          <button key={key} className={`recycle-tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {/* 五页签 keep-alive（照娱乐城容器模式）：常驻挂载 + display 隐藏，切页签不打断 AI 思考 */}
      {(
        [
          ['xiangqi', <XiangqiPane key="xq" />],
          ['chess', <ChessPane key="cs" />],
          ['shogi', <ShogiPane key="sg" />],
          ['gomoku', <GomokuPane key="gm" />],
          ['go', <GoPane key="go" />]
        ] as const
      ).map(([key, node]) => (
        <div key={key} className={tab === key ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== key}>
          {node}
        </div>
      ))}
    </div>
  )
}
