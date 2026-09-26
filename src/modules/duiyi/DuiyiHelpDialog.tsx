// 对弈社帮助弹窗：各棋规则简述 + 操作说明（本地静态文案，零 LLM）
import { useMemo } from 'react'
import type { DuiyiGameKey } from '../../renderer/api'

const HELP: Record<DuiyiGameKey, { title: string; rules: string[]; ops: string[] }> = {
  xiangqi: {
    title: '中国象棋',
    rules: [
      '你执红先行，AI 执黑。车马炮走法与常规一致：马走日（蹩马腿）、象走田（塞象眼、不过河）、仕困九宫、帅将不出宫。',
      '兵卒过河前只能前行，过河后可横走、不可后退；两将同列无隔子（照面）为非法局面。',
      '被将死或困毙（无子可动）判负；本模块不设长将禁着与自然和局判定。'
    ],
    ops: ['点击己方棋子选中（高亮可落点），再点落点走子；悔棋一次退回你上一手之前（AI 的应手一并撤销）。']
  },
  chess: {
    title: '国际象棋',
    rules: [
      '你执白先行，AI 执黑。规则完整：王车易位（王车未动、路径无子且不被将军）、吃过路兵、兵升变、逼和判和。',
      '被将死判负；仅剩双王或王对王+单轻子自动判和；三次重复与五十回合规则未实现。'
    ],
    ops: ['点击己方棋子选中（高亮可落点），再点落点走子；兵到底线弹窗选择升变子（后/车/象/马）。']
  },
  shogi: {
    title: '日本将棋',
    rules: [
      '你执先手（下方、向上行进），AI 执后手。吃掉的子成为你的持驹，可在己方回合打入任意空点。',
      '进入对方三段内可升变（步香桂銀有升变走法；步香抵底线、桂抵底两行强制升变）。',
      '打入禁手：步不可打在与己方步同列（二步）、步香不可打到底线、桂不可打到底两行、打步直接将死（打步诘）为禁手。',
      '王被诘み判负；千日手与持将棋未实现。'
    ],
    ops: [
      '点击己方棋子选中走子；进/出升变区且可选时弹「成 / 不成」选择。',
      '点击右侧持驹区的棋子后，点棋盘空点即可打入（高亮为可打点）。'
    ]
  },
  gomoku: {
    title: '五子棋',
    rules: ['15×15 无禁手自由规则：任意方向连成五子（含长连）即胜，棋盘下满判和。', '你执黑先行，AI 执白。'],
    ops: ['点击交叉点直接落子；悔棋一次退回你上一手之前。']
  },
  go: {
    title: '围棋',
    rules: [
      '中国规则：禁自杀点；单子提劫后对方不能立即回提（简单劫）；双方连续虚着（pass）进入终局。',
      '终局后进入死子标记：点击棋子整组标记/取消死子（死子灰显），确认后按区域法数子，白贴 7.5 目。',
      '内置 AI 为启发式弱手：9 路尚可一战，13 路偏弱，19 路仅作陪玩（娱乐级）。'
    ],
    ops: ['点击交叉点落子（非法点不响应）；轮到你时可点「虚着」跳过一手。']
  }
}

export default function DuiyiHelpDialog(props: { open: boolean; onClose: () => void; game: DuiyiGameKey }) {
  const { open, onClose, game } = props
  const help = useMemo(() => HELP[game], [game])
  if (!open) return null
  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 520 }}>
        <div className="dialog-header">对弈社 · {help.title}</div>
        <div className="dialog-body" style={{ lineHeight: 1.8 }}>
          <div className="dy-help-sec">规则</div>
          {help.rules.map((t, i) => (
            <p key={i} className="dy-help-p">
              {t}
            </p>
          ))}
          <div className="dy-help-sec">操作</div>
          {help.ops.map((t, i) => (
            <p key={i} className="dy-help-p">
              {t}
            </p>
          ))}
        </div>
        <div className="dialog-footer">
          <button className="btn btn-primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}
