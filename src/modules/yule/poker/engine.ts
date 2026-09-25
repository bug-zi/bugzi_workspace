// 德扑 SNG 引擎（娱乐城 specs §3）：纯函数核心——不碰 DB/IPC/React，状态快照可整体 JSON 序列化。
// 简化口径：4 人单桌 SNG；全下低于最小加注增量时仍视为有效加注重开行动（单桌休闲场景的简化）。
// 推进模型：UI 定时调 advance()——awaiting='ai' 执行一手 AI 行动；'settle' 收尾轮次/发牌/摊牌；
// 'handover' 为手间暂停（UI 展示结果后调 continueHand）；'human' 等玩家操作；'gameover' 终局。
import {
  YULE_BB,
  YULE_BUY_IN,
  YULE_HANDS_PER_LEVEL,
  YULE_PRIZES,
  YULE_SB,
  YULE_START_STACK
} from '../../../shared/types'

export const BUY_IN = YULE_BUY_IN
export const START_STACK = YULE_START_STACK
export const HANDS_PER_LEVEL = YULE_HANDS_PER_LEVEL
export const PRIZES = YULE_PRIZES
export const AI_THINK_MS = 800

export type Street = 'preflop' | 'flop' | 'turn' | 'river'
export type PersonaKey = 'tag' | 'lag' | 'station'

export interface Card {
  r: number // 2..14（14=A）
  s: number // 0..3：♠♥♦♣
}

export interface Persona {
  name: string
  openChen: number // 翻前开局门槛（Chen 分）
  callChen: number // 翻前跟注门槛（Chen 分）
  aggr: number // 激进度 0..1
  bluff: number // 诈唬频率 0..1
  station: number // 跟注站倾向 0..1
}

export const PERSONAS: Record<PersonaKey, Persona> = {
  tag: { name: '老K', openChen: 9, callChen: 7, aggr: 0.75, bluff: 0.08, station: 0.12 },
  lag: { name: '半仙', openChen: 6, callChen: 5, aggr: 0.65, bluff: 0.28, station: 0.08 },
  station: { name: '铁跟', openChen: 7, callChen: 3, aggr: 0.15, bluff: 0.04, station: 0.85 }
}

export interface PokerPlayer {
  id: number
  name: string
  isHuman: boolean
  persona?: PersonaKey
  stack: number
  bet: number // 本街已投入
  totalBet: number // 本手累计（边池结算依据）
  cards: Card[]
  folded: boolean
  allin: boolean
  acted: boolean
  out: boolean
  lastAction: string | null // 最近一次动作标签（过牌/跟注 X/下注 X/加注到 X/全下 X/弃牌），跨街保留
}

export interface HandLogEntry {
  handNo: number
  sb: number
  bb: number
  hero: string // 我的底牌，如 "A♠ K♥"
  net: number // 我本手净变动
  note: string // 结果摘要
}

export interface ShowdownRow {
  id: number
  name: string
  desc: string
  win: number
}

export type Awaiting = 'human' | 'ai' | 'settle' | 'handover' | 'gameover'

export interface PokerState {
  players: PokerPlayer[]
  deck: Card[]
  board: Card[]
  street: Street
  currentBet: number // 本街最高注
  minRaise: number // 本手最小加注增量
  toAct: number // -1 = 无人待行动
  awaiting: Awaiting
  dealerId: number // 庄家玩家 id（随出局在存活玩家里轮转）
  handNo: number // 从 1 起
  sb: number
  bb: number
  handOver: {
    text: string
    rows: ShowdownRow[] // 摊牌明细（弃牌局为空）
    log: HandLogEntry
  } | null
  bustOrder: number[] // 出局顺序（玩家 id，先出局在前）
  gameRank: number | null // 我的名次（gameover 时 1..4）
  handsLog: HandLogEntry[]
  startedAtMs: number
  actionLog: string[] // 本手行动流水（新→旧展示用，每街带分隔标记），开手重置
  notice: string | null // 规则提示（全下跑马等），开手重置
}

// ---------- 基础工具 ----------

export const SUITS = ['♠', '♥', '♦', '♣']

export const STREET_ZH: Record<Street, string> = { preflop: '翻前', flop: '翻牌', turn: '转牌', river: '河牌' }

export function cardText(c: Card): string {
  const r = c.r === 14 ? 'A' : c.r === 13 ? 'K' : c.r === 12 ? 'Q' : c.r === 11 ? 'J' : String(c.r)
  return `${r}${SUITS[c.s]}`
}

function freshDeck(): Card[] {
  const d: Card[] = []
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ r, s })
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[d[i], d[j]] = [d[j], d[i]]
  }
  return d
}

const clone = (st: PokerState): PokerState => JSON.parse(JSON.stringify(st))

const alivePlayers = (st: PokerState): PokerPlayer[] => st.players.filter((p) => !p.out)

function nextSeat(st: PokerState, from: number, pred: (p: PokerPlayer) => boolean): number {
  for (let i = 1; i <= st.players.length; i++) {
    const idx = (from + i) % st.players.length
    if (pred(st.players[idx])) return idx
  }
  return -1
}

// ---------- 手牌评估（7 选 5） ----------

export interface HandRank {
  cat: number // 0 高牌 .. 8 同花顺
  ranks: number[] // 同类比较键（降序）
  desc: string
}

function evalFive(cs: Card[]): HandRank {
  const rs = cs.map((c) => c.r).sort((a, b) => b - a)
  const flush = cs.every((c) => c.s === cs[0].s)
  const uniq = [...new Set(rs)]
  let straightHigh = 0
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0]
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5 // A2345
  }
  const cnt = new Map<number, number>()
  for (const r of rs) cnt.set(r, (cnt.get(r) ?? 0) + 1)
  const groups = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const kick = (n: number) => rs.filter((r) => r !== n).slice(0, 5 - cnt.get(n)!)
  if (flush && straightHigh) return { cat: 8, ranks: [straightHigh], desc: '同花顺' }
  if (groups[0][1] === 4) return { cat: 7, ranks: [groups[0][0], kick(groups[0][0])[0] ?? 0], desc: '四条' }
  if (groups[0][1] === 3 && groups[1]?.[1] >= 2) return { cat: 6, ranks: [groups[0][0], groups[1][0]], desc: '葫芦' }
  if (flush) return { cat: 5, ranks: rs, desc: '同花' }
  if (straightHigh) return { cat: 4, ranks: [straightHigh], desc: '顺子' }
  if (groups[0][1] === 3) return { cat: 3, ranks: [groups[0][0], ...kick(groups[0][0])].slice(0, 3), desc: '三条' }
  if (groups[0][1] === 2 && groups[1]?.[1] === 2)
    return { cat: 2, ranks: [groups[0][0], groups[1][0], rs.find((r) => r !== groups[0][0] && r !== groups[1][0]) ?? 0], desc: '两对' }
  if (groups[0][1] === 2) return { cat: 1, ranks: [groups[0][0], ...kick(groups[0][0])].slice(0, 4), desc: '一对' }
  return { cat: 0, ranks: rs, desc: '高牌' }
}

export function evalSeven(cards: Card[]): HandRank {
  let best: HandRank | null = null
  const n = cards.length
  const idx: number[] = []
  const cmp = (a: HandRank, b: HandRank): number => {
    if (a.cat !== b.cat) return a.cat - b.cat
    for (let i = 0; i < Math.max(a.ranks.length, b.ranks.length); i++) {
      const x = a.ranks[i] ?? 0
      const y = b.ranks[i] ?? 0
      if (x !== y) return x - y
    }
    return 0
  }
  const rec = (start: number, depth: number): void => {
    if (depth === 5) {
      const h = evalFive(idx.map((i) => cards[i]))
      if (!best || cmp(h, best) > 0) best = h
      return
    }
    for (let i = start; i < n; i++) {
      idx[depth] = i
      rec(i + 1, depth + 1)
    }
  }
  rec(0, 0)
  return best!
}

/** 翻前手牌强度：Chen 公式（0..20 分） */
export function chenScore(c1: Card, c2: Card): number {
  const pts = (r: number): number => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2)
  const hi = Math.max(c1.r, c2.r)
  let score = pts(hi)
  if (c1.r === c2.r) return Math.max(5, score * 2)
  if (c1.s === c2.s) score += 2
  const gap = hi - Math.min(c1.r, c2.r) - 1
  if (gap === 1) score -= 1
  else if (gap === 2) score -= 2
  else if (gap === 3) score -= 4
  else if (gap > 3) score -= 5
  if (gap <= 1 && hi < 12) score += 1
  return Math.max(0, score)
}

/** 当前街成牌强度（0..1；翻前按 Chen 折算） */
function madeStrength(p: PokerPlayer, st: PokerState): number {
  if (st.board.length === 0) return Math.min(0.95, Math.max(0.15, chenScore(p.cards[0], p.cards[1]) / 16))
  const h = evalSeven([...p.cards, ...st.board])
  const base = [0.15, 0.38, 0.58, 0.68, 0.78, 0.84, 0.92, 0.97, 0.99][h.cat]
  return Math.min(0.99, base + Math.random() * 0.08)
}

// ---------- 开局 / 发牌 ----------

export function createInitialState(): PokerState {
  const personas: PersonaKey[] = ['tag', 'lag', 'station']
  const st: PokerState = {
    players: [
      { id: 0, name: '我', isHuman: true, stack: START_STACK, bet: 0, totalBet: 0, cards: [], folded: false, allin: false, acted: false, out: false, lastAction: null },
      ...personas.map((k, i) => ({
        id: i + 1,
        name: PERSONAS[k].name,
        isHuman: false,
        persona: k,
        stack: START_STACK,
        bet: 0,
        totalBet: 0,
        cards: [],
        folded: false,
        allin: false,
        acted: false,
        out: false,
        lastAction: null
      }))
    ],
    deck: [],
    board: [],
    street: 'preflop',
    currentBet: 0,
    minRaise: 20,
    toAct: -1,
    awaiting: 'handover',
    dealerId: 3, // 首手庄：AI 座位（下家即人机轮转，我首手非庄）
    handNo: 0,
    sb: 10,
    bb: 20,
    handOver: null,
    bustOrder: [],
    gameRank: null,
    handsLog: [],
    startedAtMs: Date.now(),
    actionLog: [],
    notice: null
  }
  return startHand(st)
}

/** 开下一手：盲注升级、庄钮轮转、收盲、发牌、定先手 */
export function startHand(prev: PokerState): PokerState {
  const st = clone(prev)
  st.handNo += 1
  const level = Math.floor((st.handNo - 1) / YULE_HANDS_PER_LEVEL)
  st.sb = YULE_SB * 2 ** level
  st.bb = YULE_BB * 2 ** level
  st.minRaise = st.bb
  st.deck = freshDeck()
  st.board = []
  st.street = 'preflop'
  st.currentBet = 0
  st.handOver = null
  st.actionLog = [`—— 翻前（第 ${st.handNo} 手 · 盲注 ${st.sb}/${st.bb}）——`]
  st.notice = null
  for (const p of st.players) {
    if (p.out) continue
    p.bet = 0
    p.totalBet = 0
    p.cards = []
    p.folded = false
    p.allin = false
    p.acted = false
    p.lastAction = null
  }
  // 庄钮在存活玩家里轮转
  const dealerIdx = nextSeat(st, st.players.findIndex((p) => p.id === st.dealerId), (p) => !p.out)
  st.dealerId = st.players[dealerIdx].id
  const alive = alivePlayers(st)
  const aliveDealer = alive.findIndex((p) => p.id === st.dealerId)
  const headsUp = alive.length === 2
  const post = (p: PokerPlayer, amount: number, label: string): void => {
    const real = Math.min(amount, p.stack)
    p.stack -= real
    p.bet += real
    p.totalBet += real
    if (p.stack === 0) p.allin = true
    p.lastAction = p.allin ? `全下盲注 ${real}` : label
    st.actionLog.push(`${p.name} ${p.lastAction}`)
  }
  const sbP = alive[headsUp ? aliveDealer : (aliveDealer + 1) % alive.length]
  const bbP = alive[headsUp ? (aliveDealer + 1) % alive.length : (aliveDealer + 2) % alive.length]
  post(sbP, st.sb, `小盲 ${st.sb}`)
  post(bbP, st.bb, `大盲 ${st.bb}`)
  st.currentBet = st.bb
  for (const p of alive) p.cards = [st.deck.pop()!, st.deck.pop()!]
  // 翻前首行动 = BB 座位的下一位可行动者；HU 时 BB = 庄家唯一对手，绕回即庄家/SB 本人先动（单挑规则）
  const bbIdx = st.players.findIndex((p) => p.id === bbP.id)
  st.toAct = nextSeat(st, bbIdx, (p) => !p.out && !p.allin && !p.folded)
  syncAwaiting(st)
  return st
}

function syncAwaiting(st: PokerState): void {
  const pending = alivePlayers(st).filter((p) => !p.folded && !p.allin && !p.acted)
  if (st.toAct < 0 || !pending.some((p) => p.id === st.players[st.toAct].id)) st.toAct = -1
  if (st.toAct >= 0) {
    st.awaiting = st.players[st.toAct].isHuman ? 'human' : 'ai'
  } else {
    st.awaiting = 'settle' // 本街行动完毕，待 advance 收尾
  }
}

/** 行动后推进：把行动权交给下一位待行动者；无人待行动 → 本街结束（settle 收尾） */
function advanceTurn(st: PokerState): void {
  const pending = alivePlayers(st).filter((p) => !p.folded && !p.allin && !p.acted)
  if (!pending.length) {
    st.toAct = -1
    st.awaiting = 'settle'
    return
  }
  const from = st.toAct >= 0 ? st.toAct : st.players.findIndex((p) => p.id === st.dealerId)
  st.toAct = nextSeat(st, from, (p) => pending.some((q) => q.id === p.id))
  st.awaiting = st.players[st.toAct].isHuman ? 'human' : 'ai'
}

// ---------- 行动 ----------

export interface PokerAction {
  type: 'fold' | 'check' | 'call' | 'raise'
  /** raise 为「加注到」的本街总额 */
  amount?: number
}

export function legalActions(st: PokerState): {
  callAmount: number
  canCheck: boolean
  minRaiseTo: number
  maxRaiseTo: number
} {
  const p = st.players[st.toAct]
  return {
    callAmount: Math.min(st.currentBet - p.bet, p.stack),
    canCheck: st.currentBet - p.bet <= 0,
    minRaiseTo: st.currentBet + Math.max(st.minRaise, st.bb),
    maxRaiseTo: p.bet + p.stack
  }
}

function commit(st: PokerState, p: PokerPlayer, amount: number): void {
  const real = Math.min(amount, p.stack)
  p.stack -= real
  p.bet += real
  p.totalBet += real
  if (p.stack === 0) p.allin = true
}

/** 记录当前行动者的动作标签 + 写入本手流水 */
function record(st: PokerState, label: string): void {
  const p = st.players[st.toAct]
  p.lastAction = label
  st.actionLog.push(`${p.name} ${label}`)
}

function applyFold(st: PokerState): void {
  st.players[st.toAct].folded = true
  st.players[st.toAct].acted = true
  record(st, '弃牌')
}

function applyCall(st: PokerState): void {
  const p = st.players[st.toAct]
  const real = Math.min(st.currentBet - p.bet, p.stack)
  commit(st, p, real)
  p.acted = true
  record(st, p.allin ? `全下跟注 ${real}` : `跟注 ${real}`)
}

function applyRaise(st: PokerState, raiseTo: number): void {
  const p = st.players[st.toAct]
  const first = st.currentBet <= 0 // 本街首笔下注
  const target = Math.max(raiseTo, st.currentBet + 1)
  st.minRaise = Math.max(st.minRaise, target - st.currentBet)
  st.currentBet = Math.max(st.currentBet, target)
  commit(st, p, st.currentBet - p.bet)
  for (const q of alivePlayers(st)) if (q.id !== p.id && !q.folded && !q.allin) q.acted = false
  p.acted = true
  record(st, p.allin ? `全下 ${st.currentBet}` : first ? `下注 ${st.currentBet}` : `加注到 ${st.currentBet}`)
}

// ---------- AI 决策 ----------

function aiDecide(st: PokerState): PokerAction {
  const p = st.players[st.toAct]
  const persona = PERSONAS[p.persona!]
  const toCall = st.currentBet - p.bet
  const pot = st.players.reduce((n, q) => n + q.bet, 0)
  const strength = madeStrength(p, st)
  const roll = Math.random()
  const headsUp = alivePlayers(st).filter((q) => !q.folded).length <= 2
  if (toCall <= 0) {
    // 无注可跟：价值下注或诈唬
    const wantBet = strength > 0.55 - persona.aggr * 0.15 || roll < persona.bluff * (st.street === 'preflop' ? 0.4 : 1)
    if (wantBet) {
      const size = Math.max(st.bb, Math.round((pot * (0.5 + persona.aggr * 0.3)) / 10) * 10)
      return { type: 'raise', amount: size }
    }
    return { type: 'check' }
  }
  const potOdds = toCall / (pot + toCall)
  if (persona.station > 0.5) {
    // 跟注站：几乎不弃牌、摊牌强才偶发加注
    if (strength > 0.85 && roll < 0.25) return { type: 'raise', amount: st.currentBet * 2 + st.bb }
    return { type: 'call' }
  }
  if (strength > 0.75 || roll < persona.bluff * 0.5) {
    const raiseTo = st.currentBet + Math.max(st.bb, Math.round((pot * (0.6 + persona.aggr * 0.4)) / 10) * 10)
    return { type: 'raise', amount: raiseTo }
  }
  const sticky = persona.station * 0.3
  if (strength > potOdds * (1.15 - persona.aggr * 0.25) - sticky) return { type: 'call' }
  if (toCall <= st.bb && (strength > 0.3 || headsUp) && roll < 0.35 + persona.station * 0.4) return { type: 'call' }
  return { type: 'fold' }
}

// ---------- 推进 ----------

function performAction(st: PokerState, act: PokerAction): void {
  if (act.type === 'fold') applyFold(st)
  else if (act.type === 'call') applyCall(st)
  else if (act.type === 'check') {
    st.players[st.toAct].acted = true
    record(st, '过牌')
  } else applyRaise(st, act.amount ?? legalActions(st).minRaiseTo)
}

/** 玩家行动入口（awaiting==='human' 时合法） */
export function humanAct(prev: PokerState, act: PokerAction): PokerState {
  const st = clone(prev)
  if (st.awaiting !== 'human') return st
  performAction(st, act)
  // 弃牌只剩一人 → 直接结手
  const live = alivePlayers(st).filter((p) => !p.folded)
  if (live.length === 1) {
    endByFold(st, live[0])
    return st
  }
  advanceTurn(st)
  return st
}

/** 只剩一名未弃牌玩家 → 不摊牌结手 */
function endByFold(st: PokerState, winner: PokerPlayer): void {
  const pot = st.players.reduce((n, q) => n + q.totalBet, 0)
  winner.stack += pot
  const hero = st.players[0]
  const net = winner.id === 0 ? pot - hero.totalBet : -hero.totalBet
  st.handOver = {
    text: `${winner.name} 收下底池 ${pot}（其余玩家弃牌）`,
    rows: [],
    log: buildLog(st, net, winner.id === 0 ? `不摊牌胜 +${pot - hero.totalBet}` : '弃牌局')
  }
  finishHand(st)
}

function buildLog(st: PokerState, net: number, note: string): HandLogEntry {
  const hero = st.players[0]
  return {
    handNo: st.handNo,
    sb: st.sb,
    bb: st.bb,
    hero: hero.cards.length ? `${cardText(hero.cards[0])} ${cardText(hero.cards[1])}` : '',
    net,
    note
  }
}

/**
 * 推进一步。awaiting：'ai' 执行 AI 一手行动；'settle' 收轮次/发下一街/摊牌；
 * 'human' | 'handover' | 'gameover' 原样返回（UI 决定下一步）。
 */
export function advance(prev: PokerState): PokerState {
  const st = clone(prev)
  if (st.awaiting === 'human' || st.awaiting === 'handover' || st.awaiting === 'gameover') return st
  if (st.awaiting === 'ai') {
    performAction(st, aiDecide(st))
    const live = alivePlayers(st).filter((p) => !p.folded)
    if (live.length === 1) {
      endByFold(st, live[0])
      return st
    }
    advanceTurn(st)
    return st
  }
  return settleRound(st)
}

/** 下注轮收尾：清注 → 发下一街；有人全下（跑马）时逐街发完直接摊牌 */
function settleRound(prev: PokerState): PokerState {
  const st = clone(prev)
  for (const p of alivePlayers(st)) {
    p.bet = 0
    p.acted = false
  }
  st.currentBet = 0
  st.minRaise = st.bb
  const live = alivePlayers(st).filter((p) => !p.folded)
  const canAct = live.filter((p) => !p.allin)
  // 全员 all-in（或只剩一名可行动者、无人能再跟注）→ 标准规则：无更多下注环节，逐街发完公共牌直接摊牌
  if (st.street === 'river' || canAct.length <= 1) {
    if (st.board.length < 5) {
      st.notice = '已有玩家全下、无人可再投注——剩余公共牌逐街发完后直接摊牌，本手不再有下注环节'
      st.toAct = -1
      st.deck.pop() // burn
      const deal = st.board.length === 0 ? 3 : 1
      for (let i = 0; i < deal; i++) st.board.push(st.deck.pop()!)
      st.street = st.street === 'preflop' ? 'flop' : st.street === 'flop' ? 'turn' : 'river'
      st.actionLog.push(`—— ${STREET_ZH[st.street]} ——`)
      st.awaiting = 'settle'
      return st
    }
    return showdown(st)
  }
  st.deck.pop() // burn
  const deal = st.street === 'preflop' ? 3 : 1
  for (let i = 0; i < deal; i++) st.board.push(st.deck.pop()!)
  st.street = st.street === 'preflop' ? 'flop' : st.street === 'flop' ? 'turn' : 'river'
  st.actionLog.push(`—— ${STREET_ZH[st.street]} ——`)
  const dealerIdx = st.players.findIndex((p) => p.id === st.dealerId)
  st.toAct = nextSeat(st, dealerIdx, (p) => !p.out && !p.folded && !p.allin)
  syncAwaiting(st)
  return st
}

/** 摊牌：边池分层结算 + 出局判定 + 结手 */
function showdown(prev: PokerState): PokerState {
  const st = clone(prev)
  st.street = 'river'
  const contenders = alivePlayers(st).filter((p) => !p.folded)
  const ranks = new Map<number, HandRank>()
  for (const p of contenders) ranks.set(p.id, evalSeven([...p.cards, ...st.board]))
  const levels = [...new Set(st.players.filter((p) => p.totalBet > 0).map((p) => p.totalBet))].sort((a, b) => a - b)
  const rows: ShowdownRow[] = []
  let prevLevel = 0
  for (const lv of levels) {
    const potAmount = st.players.reduce((n, p) => n + Math.min(Math.max(p.totalBet - prevLevel, 0), lv - prevLevel), 0)
    prevLevel = lv
    if (potAmount <= 0) continue
    const inLayer = contenders.filter((p) => p.totalBet >= lv)
    if (!inLayer.length) continue // 该层权益全属弃牌者（不应出现），保守跳过
    const best = inLayer.map((p) => ranks.get(p.id)!).reduce((a, b) => (cmpRank(a, b) >= 0 ? a : b))
    const winners = inLayer.filter((p) => cmpRank(ranks.get(p.id)!, best) === 0)
    const share = Math.floor(potAmount / winners.length)
    for (const w of winners) w.stack += share
    winners[0].stack += potAmount - share * winners.length // 余筹给首个赢家
    for (const w of winners) {
      const exist = rows.find((r) => r.id === w.id)
      if (exist) exist.win += share
      else rows.push({ id: w.id, name: w.name, desc: ranks.get(w.id)!.desc, win: share })
    }
  }
  const mine = rows.find((r) => r.id === 0)
  st.handOver = {
    text: rows.length ? `摊牌：${rows.map((r) => `${r.name}（${r.desc}）+${r.win}`).join('，')}` : '摊牌结算',
    rows,
    log: buildLog(st, mine ? mine.win - st.players[0].totalBet : -st.players[0].totalBet, mine ? `摊牌胜 · ${mine.desc}` : `摊牌负 · ${ranks.get(0)?.desc ?? ''}`)
  }
  finishHand(st)
  return st
}

function cmpRank(a: HandRank, b: HandRank): number {
  if (a.cat !== b.cat) return a.cat - b.cat
  for (let i = 0; i < Math.max(a.ranks.length, b.ranks.length); i++) {
    const x = a.ranks[i] ?? 0
    const y = b.ranks[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

function finishHand(st: PokerState): void {
  st.handsLog.push(st.handOver!.log)
  // 底池已全部结清：归零下注计数（否则出局玩家的残留 totalBet 会被下一手 endByFold/摊牌误当底池重复发放）
  for (const p of st.players) {
    p.bet = 0
    p.totalBet = 0
  }
  // 破产出局（同手多人破产：余码少者名次更差）
  const busted = alivePlayers(st)
    .filter((p) => p.stack <= 0)
    .sort((a, b) => a.stack - b.stack)
  for (const b of busted) {
    b.out = true
    st.bustOrder.push(b.id)
  }
  if (busted.some((b) => b.id === 0) || alivePlayers(st).length <= 1) {
    st.gameRank = rankOf(st, 0)
    st.awaiting = 'gameover'
  } else {
    st.awaiting = 'handover'
  }
  st.toAct = -1
}

/** 名次推导：出局序倒推；幸存者 = 冠军 */
export function rankOf(st: PokerState, id: number): number {
  const idx = st.bustOrder.indexOf(id)
  if (idx >= 0) return st.players.length - idx
  return 1
}

/** 手间继续（awaiting==='handover' 时由 UI 调用开下一手） */
export function continueHand(prev: PokerState): PokerState {
  return startHand(prev)
}

export function elapsedMs(st: PokerState): number {
  return Date.now() - st.startedAtMs
}
