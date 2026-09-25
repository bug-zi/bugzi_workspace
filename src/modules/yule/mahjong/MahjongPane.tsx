// 麻将房面板（娱乐城 specs §12）：大厅态 + 牌桌态；四家座位、我方手牌点选出牌、响应条、局终结算卡
import { useCallback, useEffect, useState } from 'react'
import * as engine from './engine'
import MahjongTile from './MahjongTile'
import HelpDialog from '../HelpDialog'
import { MAHJONG_HELP_MD } from '../help'
import { tileText, type TileId } from './tiles'
import './mahjong.css'

/** face-index → 牌面（与 engine.faceIndex 互逆） */
function indexFace(i: number): TileId {
  if (i < 27) return `${'WTS'[Math.floor(i / 9)]}${(i % 9) + 1}`
  return (['EF', 'SF', 'WF', 'NF', 'RZ', 'FC', 'BB'] as const)[i - 27]
}

function meldTiles(m: engine.MjMeld): TileId[] {
  if (m.kind === 'chi') {
    const low = m.a as number
    return [indexFace(low), indexFace(low + 1), indexFace(low + 2)]
  }
  return [indexFace(m.a as number)]
}

/** 手牌展示排序：万筒索 → 风字 → 财神垫底（纯显示，不改引擎手牌序） */
const CAT_ORDER = (t: TileId): number => {
  const c = t[0]
  if (c === 'W') return 0
  if (c === 'T') return 1
  if (c === 'S') return 2
  if (t === 'EF' || t === 'SF' || t === 'WF' || t === 'NF') return 3
  return 4
}
function sortHand(st: engine.MjState, hand: TileId[]): TileId[] {
  return [...hand].sort((a, b) => {
    const ja = st.jokerFaces.includes(a) ? 1 : 0
    const jb = st.jokerFaces.includes(b) ? 1 : 0
    if (ja !== jb) return ja - jb
    return CAT_ORDER(a) - CAT_ORDER(b) || a.localeCompare(b)
  })
}

export default function MahjongPane() {
  const [st, setSt] = useState<engine.MjState | null>(null)
  const [selected, setSelected] = useState<TileId | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  // AI 节奏：awaiting==='ai' 时 800ms 一步
  useEffect(() => {
    if (!st || st.phase !== 'playing' || st.awaiting !== 'ai') return
    const t = window.setTimeout(() => setSt((s) => (s ? engine.advance(s) : s)), engine.AI_THINK_MS)
    return () => window.clearTimeout(t)
  }, [st])

  useEffect(() => {
    if (st?.awaiting !== 'human') setSelected(null)
  }, [st?.awaiting, st?.turn, st?.roundNo])

  const start = useCallback(() => setSt(engine.createGame()), [])
  const acting = st?.phase === 'playing' && st.awaiting === 'human'
  const oa = st ? engine.ownActions(st) : null
  const claimEntry = st?.awaiting === 'humanClaim' && st.claims ? st.claims[st.claimIdx] : null
  const me = st?.players[0]

  const onHandClick = (t: TileId): void => {
    if (!st || !acting || st.last4Mode) return
    if (st.jokerFaces.includes(t)) return
    if (selected === t) {
      setSt(engine.discardTile(st, t))
      setSelected(null)
    } else setSelected(t)
  }

  if (!st) {
    return (
      <div className="mj-lobby">
        <div className="yule-lobby-card">
          <div className="yule-lobby-head">
            <span className="yule-section-title">麻将房 · 灵溪麻将</span>
            <button className="yule-mini-btn" onClick={() => setHelpOpen(true)}>
              玩法说明
            </button>
          </div>
          <ul className="yule-lobby-info">
            <li>规则蓝本：灵溪麻将（144 张，含春夏秋冬梅兰菊竹 8 花牌与白板补花）。</li>
            <li>掷骰定庄、翻两张财神（同面 4 张皆为百搭，不可吃碰杠打出）。</li>
            <li>我 + 三位本地 AI（桥头王 · 激进 / 阿灵 · 均衡 / 老算盘 · 稳健），断网可玩。</li>
            <li>一圈每人坐庄两次，胡牌方为庄则连庄；牌池剩 10 墩流局、每杠加一墩。</li>
            <li>1 台 = 10 筹码，局终按台数进出共用钱包（胡家收三家、未胡算台差、庄家收付翻倍）。</li>
          </ul>
          <div className="yule-action-row">
            <button className="yule-btn primary big" onClick={start}>
              开局
            </button>
          </div>
        </div>
        <HelpDialog open={helpOpen} md={MAHJONG_HELP_MD} onClose={() => setHelpOpen(false)} />
      </div>
    )
  }

  const dealerName = st.players[st.dealerSeat].name
  const remaining = st.replIdx - st.drawIdx + 1
  const flowers = (seat: number) => st.players[seat].flowers
  const melds = (seat: number) => st.players[seat].melds
  const handBacks = (seat: number) => st.players[seat].hand.length

  const seatCard = (seat: 1 | 2 | 3) => (
    <div className={`mj-seat${st.turn === seat && st.phase === 'playing' ? ' acting' : ''}`}>
      <div className="mj-seat-head">
        <span>{st.players[seat].name}</span>
        <span className="mj-seat-persona">{engine.PERSONA_LABEL[st.players[seat].persona!]}</span>
        {st.dealerSeat === seat && <span className="mj-dealer-tag">庄</span>}
      </div>
      <div className="mj-seat-row">
        <span className="mj-seat-row-label">牌</span>
        {Array.from({ length: Math.min(handBacks(seat), 17) }, (_, i) => (
          <MahjongTile key={i} back small />
        ))}
        <span className="mj-seat-persona">×{handBacks(seat)}</span>
      </div>
      {melds(seat).length > 0 && (
        <div className="mj-seat-row">
          <span className="mj-seat-row-label">副露</span>
          {melds(seat).flatMap((m, i) =>
            meldTiles(m).map((f, j) => <MahjongTile key={`${i}-${j}`} face={f} small joker={st.jokerFaces.includes(f)} />)
          )}
        </div>
      )}
      {flowers(seat).length > 0 && (
        <div className="mj-seat-row">
          <span className="mj-seat-row-label">补花</span>
          {flowers(seat).map((f, i) => (
            <MahjongTile key={i} face={f} small />
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div className="mj-table">
      <div className="mj-infobar">
        <span>
          第 {st.roundNo} 局 · 庄 {dealerName}
        </span>
        <span className="mj-joker-show">
          财神
          {st.jokerFaces.map((f, i) => (
            <MahjongTile key={i} face={f} small joker />
          ))}
        </span>
        <span>牌墙剩 {Math.floor(remaining / 2)} 墩</span>
        {st.last4Mode && st.phase === 'playing' && <span className="mj-claim-mark">末 4 张</span>}
        <button className="yule-mini-btn" onClick={() => setHelpOpen(true)}>
          玩法说明
        </button>
      </div>

      {seatCard(2)}

      <div className="mj-mid-row">
        {seatCard(3)}
        <div className="mj-river">
          <span className="mj-river-title">牌河（各家最近打出的牌）</span>
          <div className="mj-river-line">
            {[3, 2, 1].map((seat) => {
              const last = st.players[seat].discards[st.players[seat].discards.length - 1]
              return last ? <MahjongTile key={seat} face={last} small /> : null
            })}
            {st.claimTile && st.phase === 'playing' && (
              <span className="mj-claim-mark">待响应 {tileText(st.claimTile)}</span>
            )}
          </div>
        </div>
        {seatCard(1)}
      </div>

      <div className={`mj-hero${acting ? ' acting' : ''}`}>
        <div className="mj-seat-head">
          <span>我</span>
          {st.dealerSeat === 0 && <span className="mj-dealer-tag">庄</span>}
          <span className="mj-seat-persona">
            {st.players[0].flowers.length > 0 && `补花 ${st.players[0].flowers.length} 张`}
          </span>
        </div>
        {me && me.melds.length > 0 && (
          <div className="mj-seat-row">
            <span className="mj-seat-row-label">副露</span>
            {me.melds.flatMap((m, i) =>
              meldTiles(m).map((f, j) => <MahjongTile key={`${i}-${j}`} face={f} small joker={st.jokerFaces.includes(f)} />)
            )}
          </div>
        )}
        {me && me.flowers.length > 0 && (
          <div className="mj-seat-row">
            <span className="mj-seat-row-label">补花</span>
            {me.flowers.map((f, i) => (
              <MahjongTile key={i} face={f} small />
            ))}
          </div>
        )}
        <div className="mj-hero-hand">
          {me && sortHand(st, me.hand).map((t, i) => (
            <MahjongTile
              key={`${t}-${i}`}
              face={t}
              selected={selected === t}
              joker={st.jokerFaces.includes(t)}
              onClick={acting && !st.jokerFaces.includes(t) && !st.last4Mode ? () => onHandClick(t) : undefined}
            />
          ))}
        </div>
        <div className="mj-actions">
          {acting && oa && (
            <>
              {oa.canHu && (
                <button className="yule-btn primary" onClick={() => setSt(engine.humanHuSelf(st))}>
                  自摸胡
                </button>
              )}
              {oa.canZhusha && (
                <button className="yule-btn primary" onClick={() => setSt(engine.humanZhusha(st))}>
                  杀猪
                </button>
              )}
              {oa.angangFaces.map((f) => (
                <button key={f} className="yule-btn" onClick={() => setSt(engine.humanAngang(st, f))}>
                  暗杠 {tileText(f)}
                </button>
              ))}
              {oa.bugangFaces.map((f) => (
                <button key={f} className="yule-btn" onClick={() => setSt(engine.humanBugang(st, f))}>
                  补杠 {tileText(f)}
                </button>
              ))}
              {oa.mustKeep && (
                <button className="yule-btn" onClick={() => setSt(engine.passTurn(st))}>
                  留牌（末 4 张）
                </button>
              )}
              {!oa.mustKeep && <p className="mj-waiting turn">轮到你出牌——点选一张牌，再点一次打出</p>}
            </>
          )}
          {claimEntry && (
            <>
              {claimEntry.canHu && (
                <button className="yule-btn primary" onClick={() => setSt(engine.humanClaim(st, { type: 'hu' }))}>
                  胡
                </button>
              )}
              {claimEntry.canGang && (
                <button className="yule-btn" onClick={() => setSt(engine.humanClaim(st, { type: 'gang' }))}>
                  杠
                </button>
              )}
              {claimEntry.canPeng && (
                <button className="yule-btn" onClick={() => setSt(engine.humanClaim(st, { type: 'peng' }))}>
                  碰
                </button>
              )}
              {claimEntry.chiOptions.map((o) => (
                <span key={o.low} className="mj-chi-opts">
                  <button
                    className="yule-btn"
                    onClick={() => setSt(engine.humanClaim(st, { type: 'chi', chiLow: o.low }))}
                  >
                    吃 {tileText(o.use[0])} {tileText(o.use[1])}
                  </button>
                </span>
              ))}
              <button className="yule-btn" onClick={() => setSt(engine.humanClaim(st, { type: 'pass' }))}>
                过
              </button>
            </>
          )}
          {!acting && !claimEntry && st.phase === 'playing' && st.awaiting === 'ai' && (
            <p className="mj-waiting">等待 {st.players[st.turn].name} 行动…</p>
          )}
        </div>
      </div>

      {st.phase === 'roundOver' && st.result && (
        <div className="mj-result">
          <p className="mj-result-text">{st.result.text}</p>
          <button className="yule-btn primary" onClick={() => setSt(engine.nextRound(st))}>
            {st.players.every((p) => p.dealerCount >= 2) ? '看一圈战绩' : '下一局'}
          </button>
        </div>
      )}
      {st.phase === 'circleOver' && (
        <div className="mj-result">
          <p className="mj-result-text">一圈打完，共 {st.roundNo} 局</p>
          <button className="yule-btn primary" onClick={start}>
            再来一圈
          </button>
        </div>
      )}

      <div className="mj-feed">
        {[...st.feed]
          .reverse()
          .slice(0, 60)
          .map((line, i) => (
            <p key={`${i}-${line}`} className={`mj-feed-line${line.startsWith('——') ? ' mark' : ''}`}>
              {line}
            </p>
          ))}
      </div>
      <HelpDialog open={helpOpen} md={MAHJONG_HELP_MD} onClose={() => setHelpOpen(false)} />
    </div>
  )
}
