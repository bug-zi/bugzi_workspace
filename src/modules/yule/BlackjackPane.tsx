// 21 点板块（娱乐城 specs §2）：4 副牌靴、庄软 17 停、BJ 3:2、要牌/停牌/加倍；钱包即时结算
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BlackjackStatsView } from '../../renderer/api'
import type { Card } from './poker/engine'
import { cardText } from './poker/engine'
import { BLACKJACK_HELP_MD } from './help'
import HelpDialog from './HelpDialog'
import { useToast } from '../../components/Toast'

type Phase = 'bet' | 'player' | 'dealer' | 'done'

interface BjResult {
  result: 'win' | 'lose' | 'push' | 'blackjack'
  net: number
  text: string
}

const DECKS = 4
const SHOE_SIZE = DECKS * 52

function freshShoe(): Card[] {
  const d: Card[] = []
  for (let k = 0; k < DECKS; k++) for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ r, s })
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[d[i], d[j]] = [d[j], d[i]]
  }
  return d
}

/** 21 点点数：A 按 11 计，超 21 逐张降为 1 */
function handValue(cards: Card[]): { total: number; soft: boolean } {
  let total = 0
  let aces = 0
  for (const c of cards) {
    if (c.r === 14) {
      aces += 1
      total += 11
    } else total += Math.min(c.r, 10)
  }
  let soft = aces > 0
  while (total > 21 && aces > 0) {
    total -= 10
    aces -= 1
    soft = aces > 0
  }
  return { total, soft }
}

export default function BlackjackPane({ onWalletChanged }: { onWalletChanged: () => void }) {
  const { toast } = useToast()
  const shoeRef = useRef<Card[]>([])
  const [balance, setBalance] = useState<number | null>(null)
  const [stats, setStats] = useState<BlackjackStatsView | null>(null)
  const [bet, setBet] = useState(0)
  const [player, setPlayer] = useState<Card[]>([])
  const [dealer, setDealer] = useState<Card[]>([])
  const [holeRevealed, setHoleRevealed] = useState(false)
  const [phase, setPhase] = useState<Phase>('bet')
  const [result, setResult] = useState<BjResult | null>(null)
  const [doubled, setDoubled] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const [w, s] = await Promise.all([window.api.yule.getWallet(), window.api.yule.blackjackStats()])
      setBalance(w.balance)
      setStats(s)
    } catch (e) {
      toast(`加载失败：${(e as Error).message}`)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const draw = (): Card => {
    if (shoeRef.current.length < SHOE_SIZE * 0.25) shoeRef.current = freshShoe() // 剩约 25% 重洗（specs §0）
    return shoeRef.current.pop()!
  }

  const settle = useCallback(
    async (r: BjResult, finalBet: number): Promise<void> => {
      try {
        const { balance: bal, stats: st } = await window.api.yule.blackjackSettle(finalBet, r.result, r.net)
        setBalance(bal)
        setStats(st)
        setResult(r)
        setPhase('done')
        onWalletChanged()
      } catch (e) {
        toast(`结算失败：${(e as Error).message}`)
        setPhase('bet')
      }
    },
    [onWalletChanged, toast]
  )

  const dealerPlay = useCallback(
    (pCards: Card[], dCards: Card[], finalBet: number, playerBj: boolean): void => {
      const d = [...dCards]
      setHoleRevealed(true)
      while (handValue(d).total < 17) d.push(draw()) // 庄家 17 停（软 17 亦停）
      setDealer(d)
      const pv = handValue(pCards).total
      const dv = handValue(d).total
      const dealerBj = d.length === 2 && dv === 21
      window.setTimeout(() => {
        if (playerBj && !dealerBj) void settle({ result: 'blackjack', net: Math.round(finalBet * 1.5), text: 'Blackjack！3:2 赔付' }, finalBet)
        else if (pv > 21) void settle({ result: 'lose', net: -finalBet, text: '爆牌，庄家胜' }, finalBet)
        else if (dv > 21) void settle({ result: 'win', net: finalBet, text: '庄家爆牌，你胜' }, finalBet)
        else if (pv > dv) void settle({ result: 'win', net: finalBet, text: `${pv} 比 ${dv}，你胜` }, finalBet)
        else if (pv < dv) void settle({ result: 'lose', net: -finalBet, text: `${pv} 比 ${dv}，庄家胜` }, finalBet)
        else void settle({ result: 'push', net: 0, text: '平局，退回注额' }, finalBet)
      }, 600)
    },
    [settle]
  )

  const deal = (): void => {
    if (bet <= 0 || balance == null || bet > balance) {
      toast('注额超出余额')
      return
    }
    if (shoeRef.current.length < 20) shoeRef.current = freshShoe()
    const p = [draw(), draw()]
    const d = [draw(), draw()]
    setResult(null)
    setDoubled(false)
    setHoleRevealed(false)
    setPlayer(p)
    setDealer(d)
    setPhase('player')
    // 天牌直判：任一方起手 21（Blackjack）
    const playerBj = handValue(p).total === 21 && p.length === 2
    const dealerBj = handValue(d).total === 21 && d.length === 2
    if (playerBj || dealerBj) {
      setHoleRevealed(true)
      window.setTimeout(() => {
        if (playerBj && dealerBj) void settle({ result: 'push', net: 0, text: '双方 Blackjack，平局' }, bet)
        else if (playerBj) void settle({ result: 'blackjack', net: Math.round(bet * 1.5), text: 'Blackjack！3:2 赔付' }, bet)
        else void settle({ result: 'lose', net: -bet, text: '庄家 Blackjack' }, bet)
      }, 700)
    }
  }

  const hit = (): void => {
    const p = [...player, draw()]
    setPlayer(p)
    if (handValue(p).total > 21) dealerPlay(p, dealer, doubled ? bet * 2 : bet, false)
  }

  const stand = (): void => {
    dealerPlay(player, dealer, doubled ? bet * 2 : bet, false)
  }

  const double = (): void => {
    if (player.length !== 2 || balance == null || bet * 2 > balance) {
      toast('余额不足，无法加倍')
      return
    }
    setDoubled(true)
    const p = [...player, draw()]
    setPlayer(p)
    if (handValue(p).total > 21) dealerPlay(p, dealer, bet * 2, false)
    else dealerPlay(p, dealer, bet * 2, false)
  }

  const nextHand = (): void => {
    setPlayer([])
    setDealer([])
    setHoleRevealed(false)
    setBet(0)
    setDoubled(false)
    setResult(null)
    setPhase('bet')
  }

  const pv = handValue(player)
  const dv = handValue(holeRevealed ? dealer : dealer.slice(0, 1))
  const canAct = phase === 'player' && result == null

  return (
    <div className="yule-pane">
      <div className="yule-bj-stats">
        <span>总手数 {stats?.hands ?? 0}</span>
        <span>
          胜率 {stats && stats.hands > 0 ? Math.round((stats.wins / stats.hands) * 100) : 0}%
        </span>
        <span className={stats && stats.net >= 0 ? 'up' : 'down'}>净收益 {stats?.net ?? 0}</span>
        <span className="yule-action-spacer" />
        <button className="yule-mini-btn" onClick={() => setHelpOpen(true)}>
          玩法
        </button>
      </div>

      <div className="yule-bj-table">
        <div className="yule-bj-row">
          <span className="yule-bj-label">庄家 {dealer.length > 0 && `· ${dv.total}${dv.soft && holeRevealed ? '（软）' : ''}`}</span>
          <div className="yule-bj-cards">
            {dealer.map((c, i) => (
              <span key={i} className={`yule-pcard big red-${c.s === 1 || c.s === 2}${i === 1 && !holeRevealed ? ' hidden' : ''}`}>
                {i === 1 && !holeRevealed ? '?' : cardText(c)}
              </span>
            ))}
          </div>
        </div>
        <div className="yule-bj-divider">
          {phase !== 'bet' && <span>底池注 {doubled ? bet * 2 : bet}</span>}
        </div>
        <div className="yule-bj-row">
          <span className="yule-bj-label">
            我 {player.length > 0 && `· ${pv.total}${pv.soft ? '（软）' : ''}`}
          </span>
          <div className="yule-bj-cards">
            {player.map((c, i) => (
              <span key={i} className={`yule-pcard big red-${c.s === 1 || c.s === 2}`}>
                {cardText(c)}
              </span>
            ))}
          </div>
        </div>

        {result && (
          <div className="yule-bj-result">
            <p>{result.text}</p>
            <p className="yule-bj-net">{result.net > 0 ? `+${result.net}` : result.net < 0 ? `${result.net}` : '±0'}</p>
            <button className="yule-btn primary" onClick={nextHand}>
              下一手
            </button>
          </div>
        )}
      </div>

      {phase === 'bet' && (
        <div className="yule-bj-bet">
          <span>余额 {balance ?? '…'}</span>
          {[10, 50, 100, 500].map((n) => (
            <button key={n} className="yule-chip" onClick={() => setBet((b) => Math.min(b + n, balance ?? 0))}>
              +{n}
            </button>
          ))}
          <button className="yule-chip ghost" onClick={() => setBet(0)}>
            清空
          </button>
          <button className="yule-btn primary" disabled={bet <= 0} onClick={deal}>
            发牌
          </button>
        </div>
      )}
      {canAct && (
        <div className="yule-bj-actions">
          <button className="yule-btn" onClick={hit}>
            要牌
          </button>
          <button className="yule-btn" onClick={stand}>
            停牌
          </button>
          <button className="yule-btn" disabled={player.length !== 2} onClick={double}>
            加倍
          </button>
        </div>
      )}
      <HelpDialog open={helpOpen} md={BLACKJACK_HELP_MD} onClose={() => setHelpOpen(false)} />
    </div>
  )
}
