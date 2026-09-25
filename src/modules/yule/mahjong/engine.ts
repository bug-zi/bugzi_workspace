// 灵溪麻将引擎（娱乐城 specs §11，阶段一）：渲染层纯 TS，不碰 DB/IPC/React，状态可整体 JSON 序列化。
// 规则蓝本：百度百科「灵溪麻将」词条（specs §9）。财神口径（§11.1 反推）：定位墩两张亮出后放回，
// 全场同面 4 张皆为财神——否则「杀猪胡五财神+26/六财神+52」不可能成立。
// 推进模型照 poker/engine.ts：UI 在 awaiting==='ai' 时定时调 advance()；
// 响应窗（他家打牌后的 胡/碰/杠/吃）由引擎在打牌时同步解析，人类有声明时挂起等 humanClaim()。
// 阶段二补 score.ts（全套台数/结算/包赔/诈胡罚），阶段三升级 AI 与快照落库。
import {
  FLOWER_FACES,
  FLOWER_QUARTETS,
  isFlower,
  isSuit,
  suitNum,
  suitOf,
  tileText,
  type TileId
} from './tiles'

export const AI_THINK_MS = 800
/** 1 台 = 10 筹码（specs §9，阶段二接入钱包） */
export const CHIP_PER_TAI = 10
/** 牌池剩 10 墩（20 张）流局，每杠 +1 墩 */
const DRAW_LINE_TILES = 20

export type MjPersona = 'aggr' | 'bal' | 'solid'

export const PERSONA_LABEL: Record<MjPersona, string> = { aggr: '激进', bal: '均衡', solid: '稳健' }

const AI_ROSTER: { name: string; persona: MjPersona }[] = [
  { name: '桥头王', persona: 'aggr' },
  { name: '阿灵', persona: 'bal' },
  { name: '老算盘', persona: 'solid' }
]

export interface MjMeld {
  kind: 'peng' | 'gang' | 'angang' | 'chi'
  /** peng/gang/angang = 牌面；chi = 顺子低位 face-index（W0 基） */
  a: string | number
  /** gang 专用：碰后补杠（4 张），抢杠胡以此为据 */
  bug?: boolean
}

export interface FlowerKongRec {
  /** FLOWER_QUARTETS key */
  key: string
  initial: boolean
}

export interface MjPlayer {
  seat: number
  name: string
  isHuman: boolean
  persona: MjPersona | null
  hand: TileId[]
  melds: MjMeld[]
  discards: TileId[]
  flowers: TileId[]
  flowerKongs: FlowerKongRec[]
  dealerCount: number
}

export interface ChiOption {
  /** 与被打牌组成顺子的两张手牌 */
  use: [TileId, TileId]
  /** 顺子低位 face-index */
  low: number
}

export interface ClaimEntry {
  seat: number
  canHu: boolean
  /** 财神单钓听牌（对子含财神）→ 让胡 */
  qiong: boolean
  canPeng: boolean
  canGang: boolean
  chiOptions: ChiOption[]
}

export interface RoundResult {
  kind: 'hu' | 'zimo' | 'draw' | 'zhusha' | 'flowerHu'
  winner: number | null
  /** 放炮 / 抢杠来源座位 */
  from: number | null
  lianzhuang: boolean
  /** 结果一句话（阶段一；阶段二补台数明细） */
  text: string
}

export interface MjState {
  players: MjPlayer[]
  wall: TileId[]
  drawIdx: number
  replIdx: number
  jokerFaces: string[]
  roundNo: number
  dealerSeat: number
  turn: number
  phase: 'playing' | 'roundOver' | 'circleOver'
  awaiting: 'ai' | 'human' | 'humanClaim' | 'none'
  claims: ClaimEntry[] | null
  claimIdx: number
  claimTile: TileId | null
  claimFrom: number
  /** 响应窗类别：打牌后 / 补杠抢杠（过牌收尾分别走 下家摸牌 / 杠补牌） */
  claimKind: 'discard' | 'rob' | null
  result: RoundResult | null
  last4Mode: boolean
  gangCount: number
  feed: string[]
  startedAtMs: number
}

// ---------- 基础工具 ----------

const clone = (st: MjState): MjState => JSON.parse(JSON.stringify(st))

const seatName = (st: MjState, seat: number): string => st.players[seat].name

function pushFeed(st: MjState, line: string): void {
  st.feed.push(line)
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function freshWall(): TileId[] {
  const wall: TileId[] = []
  const base: string[] = [
    ...Array.from({ length: 9 }, (_, i) => `W${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `T${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `S${i + 1}`),
    'EF',
    'SF',
    'WF',
    'NF',
    'RZ',
    'FC',
    'BB'
  ]
  for (const f of base) for (let k = 0; k < 4; k++) wall.push(f)
  for (const f of FLOWER_FACES) wall.push(f)
  return shuffle(wall)
}

const isJokerFace = (st: MjState, face: TileId): boolean => st.jokerFaces.includes(face)

function isReplenish(st: MjState, tile: TileId): boolean {
  return (isFlower(tile) || tile === 'BB') && !isJokerFace(st, tile)
}

const remainingTiles = (st: MjState): number => st.replIdx - st.drawIdx + 1

function drawHead(st: MjState): TileId {
  return st.wall[st.drawIdx++]
}

function drawTail(st: MjState): TileId {
  if (st.replIdx < st.drawIdx) return ''
  return st.wall[st.replIdx--]
}

const isEmptyDraw = (tile: TileId): boolean => tile === ''

// ---------- 胡牌分解（财神作万能牌全枚举） ----------

/** face → 序号：W0-8 / T9-17 / S18-26 / 东27 南28 西29 北30 中31 发32 白33（花牌不入分解） */
function faceIndex(face: TileId): number {
  const s = suitOf(face)
  if (s != null) return s * 9 + (suitNum(face)! - 1)
  switch (face) {
    case 'EF':
      return 27
    case 'SF':
      return 28
    case 'WF':
      return 29
    case 'NF':
      return 30
    case 'RZ':
      return 31
    case 'FC':
      return 32
    default:
      return 33
  }
}

export interface WinPart {
  kind: 'pair' | 'tri' | 'run'
  /** pair/tri = face-index；run = 顺子低位 face-index；-1 = 纯财神组 */
  a: number
  jokers: number
}

export function splitHand(st: MjState, hand: TileId[]): { counts: number[]; jokers: number } {
  const counts = new Array(34).fill(0) as number[]
  let jokers = 0
  for (const t of hand) {
    if (isJokerFace(st, t)) jokers++
    else counts[faceIndex(t)]++
  }
  return { counts, jokers }
}

/**
 * 枚举「对子 + m×刻 + n×顺」全部分解（财神可代替除花牌/白板外任意面，也可 2 张成对/3 张成纯财神组）。
 * 多分解全量返回——阶段二判台取各分解最大值。
 */
export function enumerateWins(counts: number[], jokers: number): WinPart[][] {
  const out: WinPart[][] = []
  const rec = (cs: number[], j: number, needPair: boolean, acc: WinPart[]): void => {
    const f = cs.findIndex((v) => v > 0)
    if (f < 0) {
      if (needPair) {
        if (j >= 2) {
          acc.push({ kind: 'pair', a: -1, jokers: 2 })
          rec(cs, j - 2, false, acc)
          acc.pop()
        }
        return
      }
      if (j === 0) out.push([...acc])
      else if (j === 2) out.push([...acc, { kind: 'pair', a: -1, jokers: 2 }])
      else if (j === 3) out.push([...acc, { kind: 'tri', a: -1, jokers: 3 }])
      return
    }
    if (needPair) {
      for (let real = 0; real <= Math.min(2, cs[f]); real++) {
        const jj = 2 - real
        if (jj > j) continue
        cs[f] -= real
        acc.push({ kind: 'pair', a: f, jokers: jj })
        rec(cs, j - jj, false, acc)
        acc.pop()
        cs[f] += real
      }
    }
    for (let real = 0; real <= Math.min(3, cs[f]); real++) {
      const jj = 3 - real
      if (jj > j) continue
      cs[f] -= real
      acc.push({ kind: 'tri', a: f, jokers: jj })
      rec(cs, j - jj, needPair, acc)
      acc.pop()
      cs[f] += real
    }
    const off = f % 9
    if (f < 27 && off <= 6) {
      for (const use1 of [1, 0]) {
        for (const use2 of [1, 0]) {
          if (use1 && cs[f + 1] < 1) continue
          if (use2 && cs[f + 2] < 1) continue
          const jj = 2 - use1 - use2
          if (jj > j) continue
          if (use1) cs[f + 1]--
          if (use2) cs[f + 2]--
          cs[f]--
          acc.push({ kind: 'run', a: f, jokers: jj })
          rec(cs, j - jj, needPair, acc)
          acc.pop()
          cs[f]++
          if (use1) cs[f + 1]++
          if (use2) cs[f + 2]++
        }
      }
    }
  }
  rec(counts, jokers, true, [])
  return out
}

export function canWinHand(st: MjState, hand: TileId[]): boolean {
  const { counts, jokers } = splitHand(st, hand)
  return enumerateWins(counts, jokers).length > 0
}

/** 财神单钓：所有可行分解的对子都含财神（任牌可胡，让胡不截） */
export function isQiongDiaoWin(st: MjState, hand: TileId[]): boolean {
  const { counts, jokers } = splitHand(st, hand)
  const wins = enumerateWins(counts, jokers)
  if (!wins.length) return false
  return wins.every((parts) => {
    const pair = parts.find((p) => p.kind === 'pair')
    return !pair || pair.a === -1 || pair.jokers > 0
  })
}

// ---------- 牌效率评估（阶段一最简 AI 用；阶段三升级防守/台数感知） ----------

/** 极大化 刻10/顺9/对4/半顺3，财神每张作万能补缺、孤张计 0；返回整手价值 */
function evalPot(counts: number[], jokers: number): number {
  const cs = [...counts]
  const rec = (j: number, acc: number): number => {
    const f = cs.findIndex((v) => v > 0)
    if (f < 0) return acc + j * 4
    let best: number
    const save = cs[f]
    // 孤张：不计价值跳过（后续打掉）
    cs[f] = 0
    best = rec(j, acc)
    cs[f] = save
    // 对子
    for (let real = 0; real <= Math.min(2, save); real++) {
      const jj = 2 - real
      if (jj > j) continue
      cs[f] -= real
      best = Math.max(best, rec(j - jj, acc + 4))
      cs[f] += real
    }
    // 刻子
    for (let real = 0; real <= Math.min(3, save); real++) {
      const jj = 3 - real
      if (jj > j) continue
      cs[f] -= real
      best = Math.max(best, rec(j - jj, acc + 10))
      cs[f] += real
    }
    const off = f % 9
    if (f < 27 && off <= 6) {
      // 顺子
      for (const use1 of [1, 0]) {
        for (const use2 of [1, 0]) {
          if (use1 && cs[f + 1] < 1) continue
          if (use2 && cs[f + 2] < 1) continue
          const jj = 2 - use1 - use2
          if (jj > j) continue
          if (use1) cs[f + 1]--
          if (use2) cs[f + 2]--
          cs[f]--
          best = Math.max(best, rec(j - jj, acc + 9))
          cs[f]++
          if (use1) cs[f + 1]++
          if (use2) cs[f + 2]++
        }
      }
      // 半顺搭子
      for (const d of [1, 2]) {
        if (off + d > 8) continue
        if (cs[f + d] > 0) {
          cs[f]--
          cs[f + d]--
          best = Math.max(best, rec(j, acc + 3))
          cs[f]++
          cs[f + d]++
        } else if (j > 0) {
          cs[f]--
          best = Math.max(best, rec(j - 1, acc + 3))
          cs[f]++
        }
      }
    }
    return best
  }
  return rec(jokers, 0)
}

// ---------- 开局 ----------

function rollDice(): number {
  return 1 + Math.floor(Math.random() * 6)
}

function createPlayers(): MjPlayer[] {
  return [
    {
      seat: 0,
      name: '我',
      isHuman: true,
      persona: null,
      hand: [],
      melds: [],
      discards: [],
      flowers: [],
      flowerKongs: [],
      dealerCount: 0
    },
    ...AI_ROSTER.map((r, i) => ({
      seat: i + 1,
      name: r.name,
      isHuman: false,
      persona: r.persona,
      hand: [],
      melds: [],
      discards: [],
      flowers: [],
      flowerKongs: [],
      dealerCount: 0
    }))
  ]
}

export function createGame(): MjState {
  const st: MjState = {
    players: createPlayers(),
    wall: [],
    drawIdx: 0,
    replIdx: 0,
    jokerFaces: [],
    roundNo: 0,
    dealerSeat: 0,
    turn: 0,
    phase: 'playing',
    awaiting: 'none',
    claims: null,
    claimIdx: 0,
    claimTile: null,
    claimFrom: -1,
    claimKind: null,
    result: null,
    last4Mode: false,
    gangCount: 0,
    feed: [],
    startedAtMs: Date.now()
  }
  return startRound(st)
}

/** 开一局：庄次数记账、掷骰定位、翻财神、发牌、补花、庄先出牌。dealerSeat 由 createGame(圈首=0)/nextRound(轮转) 就绪 */
function startRound(st: MjState): MjState {
  st.roundNo += 1
  st.players[st.dealerSeat].dealerCount += 1
  st.phase = 'playing'
  st.gangCount = 0
  st.last4Mode = false
  st.result = null
  st.claims = null
  st.claimTile = null
  st.claimFrom = -1
  st.claimKind = null
  st.turn = st.dealerSeat
  for (const p of st.players) {
    p.hand = []
    p.melds = []
    p.discards = []
    p.flowers = []
    p.flowerKongs = []
  }
  pushFeed(st, `—— 第 ${st.roundNo} 局 · 庄家 ${seatName(st, st.dealerSeat)} ——`)

  // 掷骰两次定位（specs §11.1）：头家掷 d1；2/5/6/10→南(+1)、3/7/11→西(+2)、4/8/9/12→北(+3) 二掷
  const d1 = rollDice()
  const secondOff = [2, 5, 6, 10].includes(d1) ? 1 : [3, 7, 11].includes(d1) ? 2 : 3
  const d2 = rollDice()
  const sum = d1 + d2
  // 牌墙按座位分 4 段各 36 张；二掷家段内从右数 sum 墩 = 拿牌起点
  const secondSeat = (st.dealerSeat + secondOff) % 4
  const segStart = secondSeat * 36
  const breakIdx = (segStart + (18 - sum) * 2 + 144) % 144
  const wall = freshWall()
  // 旋转使拿牌起点 = 0；起点前一墩（旋转后末两位）亮出作财神，亮出后放回（财神口径见文件头）
  const rotated = [...wall.slice(breakIdx), ...wall.slice(0, breakIdx)]
  st.wall = rotated
  st.drawIdx = 0
  st.replIdx = 143
  st.jokerFaces = [rotated[142], rotated[143]]
  pushFeed(
    st,
    `掷骰 ${d1}+${d2} 定位，财神「${tileText(st.jokerFaces[0])}${st.jokerFaces[1] !== st.jokerFaces[0] ? `·${tileText(st.jokerFaces[1])}` : ''}」（同面 4 张皆为财神）`
  )

  // 发牌：每人轮流 2 墩（4 张）×4 轮 = 16 张，庄再抓头牌 1 张
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 4; i++) {
      const seat = (st.dealerSeat + i) % 4
      for (let k = 0; k < 4; k++) st.players[seat].hand.push(drawHead(st))
    }
  }
  st.players[st.dealerSeat].hand.push(drawHead(st))

  fixAllFlowers(st)
  st.awaiting = st.dealerSeat === 0 ? 'human' : 'ai'
  return st
}

/** 全员补花：庄起逆时针逐轮亮花补牌；起手四张组作暗杠只补 1 张；补进的花等下一轮再补 */
function fixAllFlowers(st: MjState): void {
  // 起手四张组检测（春夏秋冬 / 梅兰菊竹 / 白板×4；白板为财神面时不可补花不成组）
  for (const p of st.players) {
    for (const q of FLOWER_QUARTETS) {
      if (q.key === 'bb') {
        if (isJokerFace(st, 'BB')) continue
        const n = p.hand.filter((t) => t === 'BB').length
        if (n === 4) {
          p.hand = p.hand.filter((t) => t !== 'BB')
          p.flowers.push('BB', 'BB', 'BB', 'BB')
          p.flowerKongs.push({ key: 'bb', initial: true })
          p.hand.push(drawTail(st))
        }
      } else {
        if (q.faces.every((f) => p.hand.includes(f))) {
          for (const f of q.faces) p.hand.splice(p.hand.indexOf(f), 1)
          p.flowers.push(...q.faces)
          p.flowerKongs.push({ key: q.key, initial: true })
          p.hand.push(drawTail(st))
        }
      }
    }
  }
  // 逐轮补花至无花
  let pass = 0
  for (;;) {
    let moved = false
    for (let i = 0; i < 4; i++) {
      const p = st.players[(st.dealerSeat + i) % 4]
      const fs = p.hand.filter((t) => isReplenish(st, t))
      if (!fs.length) continue
      moved = true
      for (const f of fs) {
        p.hand.splice(p.hand.indexOf(f), 1)
        addFlower(st, p, f)
        p.hand.push(drawTail(st))
      }
    }
    if (!moved || ++pass > 20) break
  }
  // 补进牌若带花已循环处理；收尾兜底清一次（防御，正常不可达）
  for (const p of st.players) {
    const fs = p.hand.filter((t) => isReplenish(st, t))
    for (const f of fs) {
      p.hand.splice(p.hand.indexOf(f), 1)
      addFlower(st, p, f)
      p.hand.push(drawTail(st))
    }
  }
}

/** 花牌入补花区：记录四张组成型 + 花胡判定（集齐 8 花无视牌型即胡） */
function addFlower(st: MjState, p: MjPlayer, face: TileId): void {
  p.flowers.push(face)
  for (const q of FLOWER_QUARTETS) {
    if (q.key === 'bb') continue
    const done = q.faces.every((f) => p.flowers.includes(f))
    const recorded = p.flowerKongs.some((k) => k.key === q.key)
    if (done && !recorded) p.flowerKongs.push({ key: q.key, initial: false })
  }
  const allEight = (FLOWER_FACES as readonly string[]).every((f) => p.flowers.includes(f))
  if (allEight) {
    pushFeed(st, `${p.name} 集齐春夏秋冬梅兰菊竹——花胡！`)
    endRound(st, { kind: 'flowerHu', winner: p.seat, from: null })
  }
}

// ---------- 行牌推进 ----------

/** 轮到 seat 摸牌：流局线检查 → 摸头 → 花/补花 → 末 4 张 → 待动作 */
function beginTurn(st: MjState, seat: number): void {
  if (st.phase !== 'playing') return
  const line = DRAW_LINE_TILES + 2 * st.gangCount
  const remaining = remainingTiles(st)
  if (remaining <= line) {
    pushFeed(st, `牌墙仅剩 ${Math.floor(remaining / 2)} 墩——流局`)
    endRound(st, { kind: 'draw', winner: null, from: null })
    return
  }
  const drawsLeft = remaining - line
  st.last4Mode = drawsLeft <= 4
  if (st.last4Mode && drawsLeft === 4) pushFeed(st, '—— 末 4 张：摸进不打、不补花、不杠 ——')
  st.turn = seat
  let tile = drawHead(st)
  if (isEmptyDraw(tile)) {
    endRound(st, { kind: 'draw', winner: null, from: null })
    return
  }
  if (isReplenish(st, tile)) {
    addFlower(st, st.players[seat], tile)
    if (st.phase !== 'playing') return
    if (st.last4Mode) {
      // 末 4 张不补花：花入补花区、无替代、直接过
      pushFeed(st, `${seatName(st, seat)} 摸进 ${tileText(tile)}（花，末 4 张不补）`)
      st.awaiting = seat === 0 ? 'human' : 'ai'
      return
    }
    for (;;) {
      pushFeed(st, `${seatName(st, seat)} 补花 ${tileText(tile)}`)
      tile = drawTail(st)
      if (!isReplenish(st, tile)) break
      addFlower(st, st.players[seat], tile)
      if (st.phase !== 'playing') return
    }
  }
  if (isEmptyDraw(tile)) {
    endRound(st, { kind: 'draw', winner: null, from: null })
    return
  }
  st.players[seat].hand.push(tile)
  pushFeed(st, `${seatName(st, seat)} 摸牌`)
  st.awaiting = seat === 0 ? 'human' : 'ai'
}

/** 杠补牌（牌墙尾）：花自动补循环；补完进入该座动作阶段 */
function kangDraw(st: MjState, seat: number): void {
  let tile = drawTail(st)
  while (isReplenish(st, tile)) {
    addFlower(st, st.players[seat], tile)
    if (st.phase !== 'playing') return
    pushFeed(st, `${seatName(st, seat)} 杠上补花 ${tileText(tile)}`)
    tile = drawTail(st)
  }
  if (isEmptyDraw(tile)) {
    endRound(st, { kind: 'draw', winner: null, from: null })
    return
  }
  st.players[seat].hand.push(tile)
  pushFeed(st, `${seatName(st, seat)} 杠后补牌`)
  st.awaiting = seat === 0 ? 'human' : 'ai'
}

function canZhushaNow(st: MjState, seat: number): boolean {
  const cnt = new Map<string, number>()
  let total = 0
  for (const t of st.players[seat].hand) {
    if (isJokerFace(st, t)) {
      cnt.set(t, (cnt.get(t) ?? 0) + 1)
      total++
    }
  }
  if (st.jokerFaces.length === 1) return total >= 2
  const [a, b] = st.jokerFaces
  const ca = cnt.get(a) ?? 0
  const cb = cnt.get(b) ?? 0
  return (ca >= 3 && cb >= 1) || (cb >= 3 && ca >= 1)
}

// ---------- 打牌与响应窗 ----------

function discardInternal(st: MjState, seat: number, tile: TileId): void {
  const hand = st.players[seat].hand
  hand.splice(hand.indexOf(tile), 1)
  st.players[seat].discards.push(tile)
  st.claimTile = tile
  st.claimFrom = seat
  pushFeed(st, `${seatName(st, seat)} 打 ${tileText(tile)}`)
  buildClaims(st)
  processClaims(st)
}

/** 响应窗构建：胡 > 碰/杠 > 吃（吃仅下家）；财神单钓让胡排后 */
function buildClaims(st: MjState): void {
  const tile = st.claimTile!
  const from = st.claimFrom
  st.claimKind = 'discard'
  const entries: ClaimEntry[] = []
  for (let i = 1; i <= 3; i++) {
    const seat = (from + i) % 4
    const p = st.players[seat]
    const test = [...p.hand, tile]
    const canHu = canWinHand(st, test)
    const n = p.hand.filter((t) => t === tile).length
    entries.push({
      seat,
      canHu,
      qiong: canHu && isQiongDiaoWin(st, test),
      canPeng: n >= 2,
      canGang: n >= 3,
      chiOptions: buildChiOptions(st, p.hand, tile)
    })
  }
  const rank = (e: ClaimEntry): number => {
    if (e.canHu) return e.qiong ? 1 : 0
    if (e.canPeng || e.canGang) return 2
    if (e.chiOptions.length) return 3
    return 9
  }
  entries.sort((a, b) => rank(a) - rank(b) || a.seat - b.seat)
  st.claims = entries.filter((e) => rank(e) < 9)
  st.claimIdx = 0
}

function buildChiOptions(st: MjState, hand: TileId[], tile: TileId): ChiOption[] {
  void st
  const s = suitOf(tile)
  if (s == null) return []
  const n = suitNum(tile)!
  const has = (sn: number): boolean => hand.includes(`${'WTS'[s]}${sn}`)
  const opts: ChiOption[] = []
  if (n >= 3 && has(n - 2) && has(n - 1)) opts.push({ use: [`${'WTS'[s]}${n - 2}`, `${'WTS'[s]}${n - 1}`], low: faceIndex(`${'WTS'[s]}${n - 2}`) })
  if (n >= 2 && n <= 8 && has(n - 1) && has(n + 1)) opts.push({ use: [`${'WTS'[s]}${n - 1}`, `${'WTS'[s]}${n + 1}`], low: faceIndex(`${'WTS'[s]}${n - 1}`) })
  if (n <= 7 && has(n + 1) && has(n + 2)) opts.push({ use: [`${'WTS'[s]}${n + 1}`, `${'WTS'[s]}${n + 2}`], low: faceIndex(`${'WTS'[s]}${n}`) })
  return opts
}

/** 依优先序走响应队列：AI 即时决策；人类有声明则挂起 */
function processClaims(st: MjState): void {
  const claims = st.claims
  if (!claims) return
  while (st.claimIdx < claims.length) {
    const e = claims[st.claimIdx]
    if (e.seat === 0) {
      st.awaiting = 'humanClaim'
      return
    }
    const act = aiClaimDecision(st, e)
    if (act === 'pass') {
      st.claimIdx++
      continue
    }
    executeClaim(st, e, act)
    return
  }
  // 队列走完：打牌响应 → 下家摸牌；抢杠响应 → 杠补牌
  const from = st.claimFrom
  const kind = st.claimKind
  st.claims = null
  st.claimTile = null
  st.claimFrom = -1
  st.claimKind = null
  if (kind === 'rob') kangDraw(st, from)
  else beginTurn(st, (from + 1) % 4)
}

type ClaimAct = 'hu' | 'peng' | 'gang' | 'chi'

function executeClaim(st: MjState, e: ClaimEntry, act: ClaimAct): void {
  const tile = st.claimTile!
  const kind = st.claimKind
  st.claims = null
  st.claimTile = null
  const from = st.claimFrom
  st.claimFrom = -1
  st.claimKind = null
  const p = st.players[e.seat]
  if (act === 'hu') {
    p.hand.push(tile)
    if (kind === 'discard') {
      // 被胡的牌从牌河移入胡家（守恒）
      st.players[from].discards.pop()
    } else if (kind === 'rob') {
      // 抢杠：杠家副露退回碰、流局线还原，杠牌归胡家
      const m = st.players[from].melds.find((x) => x.kind === 'gang' && x.a === faceIndex(tile))
      if (m) {
        m.kind = 'peng'
        m.bug = undefined
      }
      st.gangCount--
    }
    endRound(st, { kind: 'hu', winner: e.seat, from, tile, rob: kind === 'rob' })
    return
  }
  const take = (n: number): void => {
    // 被要的牌离开牌河（守恒），与手中 n 张合成副露
    st.players[from].discards.pop()
    for (let k = 0; k < n; k++) p.hand.splice(p.hand.indexOf(tile), 1)
  }
  if (act === 'peng') {
    take(2)
    p.melds.push({ kind: 'peng', a: faceIndex(tile) })
    pushFeed(st, `${p.name} 碰 ${tileText(tile)}`)
    st.turn = e.seat
    st.awaiting = e.seat === 0 ? 'human' : 'ai'
    return
  }
  if (act === 'gang') {
    take(3)
    p.melds.push({ kind: 'gang', a: faceIndex(tile) })
    st.gangCount++
    pushFeed(st, `${p.name} 杠 ${tileText(tile)}`)
    kangDraw(st, e.seat)
    return
  }
  const opt = e.chiOptions[0]
  st.players[from].discards.pop()
  for (const t of opt.use) p.hand.splice(p.hand.indexOf(t), 1)
  p.melds.push({ kind: 'chi', a: opt.low })
  pushFeed(st, `${p.name} 吃 ${tileText(opt.use[0])}${tileText(opt.use[1])}${tileText(tile)}`)
  st.turn = e.seat
  st.awaiting = e.seat === 0 ? 'human' : 'ai'
}

// ---------- AI（阶段一最简：牌效率 + 随机扰动；阶段三升级） ----------

const personaNoise = (p: MjPersona): number => (p === 'aggr' ? -2 : p === 'solid' ? 2 : 0)

function aiClaimDecision(st: MjState, e: ClaimEntry): ClaimAct | 'pass' {
  const p = st.players[e.seat]
  const tile = st.claimTile!
  if (e.canHu) return 'hu'
  const { counts, jokers } = splitHand(st, p.hand)
  const noise = personaNoise(p.persona!) + (Math.random() * 4 - 2)
  if (e.canGang) return 'gang'
  if (e.canPeng) {
    const cs = [...counts]
    cs[faceIndex(tile)] -= 2
    if (10 + evalPot(cs, jokers) > evalPot(counts, jokers) + 3 + noise) return 'peng'
  }
  if (e.chiOptions.length) {
    const opt = e.chiOptions[Math.floor(Math.random() * e.chiOptions.length)]
    const cs = [...counts]
    for (const t of opt.use) cs[faceIndex(t)]--
    if (9 + evalPot(cs, jokers) > evalPot(counts, jokers) + 4 + noise) {
      // 记住所选吃法（engine 侧透传：executeClaim 用 chiOptions[0]，这里把选中的挪到首位）
      const picked = e.chiOptions.splice(e.chiOptions.indexOf(opt), 1)
      e.chiOptions.unshift(picked[0])
      return 'chi'
    }
  }
  return 'pass'
}

function aiAct(st: MjState): void {
  const seat = st.turn
  const p = st.players[seat]
  if (canZhushaNow(st, seat)) {
    endRound(st, { kind: 'zhusha', winner: seat, from: null })
    return
  }
  if (canWinHand(st, p.hand)) {
    endRound(st, { kind: 'zimo', winner: seat, from: null })
    return
  }
  if (!st.last4Mode) {
    const angangFace = findAngangFace(st, p.hand)
    if (angangFace && Math.random() < 0.8) {
      for (let k = 0; k < 4; k++) p.hand.splice(p.hand.indexOf(angangFace), 1)
      p.melds.push({ kind: 'angang', a: faceIndex(angangFace) })
      st.gangCount++
      pushFeed(st, `${p.name} 暗杠`)
      kangDraw(st, seat)
      return
    }
    const bugangFace = findBugangFace(st, p.hand)
    if (bugangFace && Math.random() < 0.7) {
      p.hand.splice(p.hand.indexOf(bugangFace), 1)
      const meld = p.melds.find((m) => (m.kind === 'peng' || m.kind === 'gang') && m.a === faceIndex(bugangFace))
      if (meld) {
        meld.kind = 'gang'
        meld.bug = true
      }
      st.gangCount++
      pushFeed(st, `${p.name} 补杠 ${tileText(bugangFace)}`)
      robKong(st, seat, bugangFace)
      return
    }
  }
  if (st.last4Mode) {
    pushFeed(st, `${p.name} 留牌不打（末 4 张）`)
    beginTurn(st, (seat + 1) % 4)
    return
  }
  const tile = aiChooseDiscard(st, p)
  discardInternal(st, seat, tile)
}

function findAngangFace(st: MjState, hand: TileId[]): TileId | null {
  const cnt = new Map<string, number>()
  for (const t of hand) {
    if (isJokerFace(st, t) || isReplenish(st, t)) continue
    cnt.set(t, (cnt.get(t) ?? 0) + 1)
  }
  for (const [f, n] of cnt) if (n === 4) return f
  return null
}

function findBugangFace(st: MjState, hand: TileId[]): TileId | null {
  for (const t of hand) {
    if (isJokerFace(st, t) || isReplenish(st, t)) continue
    if (st.players[st.turn].melds.some((m) => m.kind === 'peng' && m.a === faceIndex(t))) return t
  }
  return null
}

function aiChooseDiscard(st: MjState, p: MjPlayer): TileId {
  const { counts, jokers } = splitHand(st, p.hand)
  const seen = new Set<string>()
  let best: TileId | null = null
  let bestScore = -Infinity
  for (const t of p.hand) {
    if (isJokerFace(st, t) || seen.has(t)) continue
    seen.add(t)
    const cs = [...counts]
    cs[faceIndex(t)]--
    const score = evalPot(cs, jokers) + (isSuit(t) ? 0 : 0.4) + Math.random() * 1.5
    if (score > bestScore) {
      bestScore = score
      best = t
    }
  }
  return best ?? p.hand[0]
}

// ---------- 抢杠 ----------

function robKong(st: MjState, kongSeat: number, tile: TileId): void {
  const entries: ClaimEntry[] = []
  for (let i = 1; i <= 3; i++) {
    const seat = (kongSeat + i) % 4
    const p = st.players[seat]
    const test = [...p.hand, tile]
    const canHu = canWinHand(st, test)
    entries.push({ seat, canHu, qiong: canHu && isQiongDiaoWin(st, test), canPeng: false, canGang: false, chiOptions: [] })
  }
  st.claimTile = tile
  st.claimFrom = kongSeat
  st.claimKind = 'rob'
  st.claims = entries.filter((e) => e.canHu)
  st.claimIdx = 0
  processClaims(st)
}

// ---------- 局终 ----------

interface EndInput {
  kind: RoundResult['kind']
  winner: number | null
  from: number | null
  /** 胡/自摸的牌面（流水文案用） */
  tile?: TileId
  /** 抢杠胡（文案区分放炮） */
  rob?: boolean
  taiText?: string
}

function endRound(st: MjState, input: EndInput): void {
  const lianzhuang = input.winner != null && input.winner === st.dealerSeat
  const nameOf = (s: number | null): string => (s == null ? '' : seatName(st, s))
  const tileTxt = input.tile ? tileText(input.tile) : ''
  let text = ''
  switch (input.kind) {
    case 'zimo':
      text = `${nameOf(input.winner)} 自摸胡${tileTxt ? `（${tileTxt}）` : ''}${input.taiText ? ` · ${input.taiText}` : ''}`
      break
    case 'hu':
      text = `${nameOf(input.winner)} 胡${tileTxt ? ` ${tileTxt}` : ''}（${input.rob ? '抢杠' : '放炮'} ${nameOf(input.from)}）${input.taiText ? ` · ${input.taiText}` : ''}`
      break
    case 'zhusha':
      text = `${nameOf(input.winner)} 杀猪（无视牌型 13 台）`
      break
    case 'flowerHu':
      text = `${nameOf(input.winner)} 花胡（集齐 8 花，52 台）`
      break
    default:
      text = '流局，本局不计台'
  }
  st.result = { kind: input.kind, winner: input.winner, from: input.from, lianzhuang, text }
  st.phase = 'roundOver'
  st.awaiting = 'none'
  st.claims = null
  st.claimTile = null
  st.claimFrom = -1
  st.claimKind = null
  pushFeed(st, text)
}

/** 结算卡确认：庄轮转（胡牌方为庄且庄次未满则连庄，否则下家）→ 全员庄满两次即圈终 → 开下局 */
export function nextRound(prev: MjState): MjState {
  const st = clone(prev)
  if (st.phase !== 'roundOver') return st
  const r = st.result
  const canDeal = (seat: number): boolean => st.players[seat].dealerCount < 2
  let seat = st.dealerSeat
  if (!(r && r.lianzhuang && canDeal(seat))) {
    let found = false
    for (let i = 0; i < 4; i++) {
      seat = (seat + 1) % 4
      if (canDeal(seat)) {
        found = true
        break
      }
    }
    if (!found) {
      st.phase = 'circleOver'
      st.awaiting = 'none'
      pushFeed(st, `—— 一圈 ${st.roundNo} 局打完 ——`)
      return st
    }
  }
  st.dealerSeat = seat
  return startRound(st)
}

/** 圈终「再来一圈」 */
export function newCircle(_prev: MjState): MjState {
  return createGame()
}

// ---------- 玩家动作入口 ----------

function requireHumanTurn(st: MjState): boolean {
  return st.phase === 'playing' && st.awaiting === 'human' && st.turn === 0
}

export interface OwnActions {
  canHu: boolean
  canZhusha: boolean
  angangFaces: TileId[]
  bugangFaces: TileId[]
  mustKeep: boolean
}

export function ownActions(st: MjState): OwnActions {
  if (!requireHumanTurn(st)) {
    return { canHu: false, canZhusha: false, angangFaces: [], bugangFaces: [], mustKeep: false }
  }
  const hand = st.players[0].hand
  return {
    canHu: canWinHand(st, hand),
    canZhusha: canZhushaNow(st, 0),
    angangFaces: st.last4Mode ? [] : [findAngangFace(st, hand)].filter((t): t is TileId => t != null),
    bugangFaces: st.last4Mode ? [] : [findBugangFace(st, hand)].filter((t): t is TileId => t != null),
    mustKeep: st.last4Mode
  }
}

export function discardTile(prev: MjState, tile: TileId): MjState {
  const st = clone(prev)
  if (!requireHumanTurn(st) || st.last4Mode) return st
  if (isJokerFace(st, tile) || isReplenish(st, tile)) return st
  if (!st.players[0].hand.includes(tile)) return st
  discardInternal(st, 0, tile)
  return st
}

/** 末 4 张：摸进不打，直接过 */
export function passTurn(prev: MjState): MjState {
  const st = clone(prev)
  if (!requireHumanTurn(st) || !st.last4Mode) return st
  pushFeed(st, '你 留牌不打（末 4 张）')
  beginTurn(st, (st.turn + 1) % 4)
  return st
}

export function humanHuSelf(prev: MjState): MjState {
  const st = clone(prev)
  if (!requireHumanTurn(st) || !canWinHand(st, st.players[0].hand)) return st
  endRound(st, { kind: 'zimo', winner: 0, from: null })
  return st
}

export function humanZhusha(prev: MjState): MjState {
  const st = clone(prev)
  if (!requireHumanTurn(st) || !canZhushaNow(st, 0)) return st
  endRound(st, { kind: 'zhusha', winner: 0, from: null })
  return st
}

export function humanAngang(prev: MjState, face: TileId): MjState {
  const st = clone(prev)
  if (!requireHumanTurn(st) || st.last4Mode) return st
  const p = st.players[0]
  if (findAngangFace(st, p.hand) !== face) return st
  for (let k = 0; k < 4; k++) p.hand.splice(p.hand.indexOf(face), 1)
  p.melds.push({ kind: 'angang', a: faceIndex(face) })
  st.gangCount++
  pushFeed(st, '你 暗杠')
  kangDraw(st, 0)
  return st
}

export function humanBugang(prev: MjState, face: TileId): MjState {
  const st = clone(prev)
  if (!requireHumanTurn(st) || st.last4Mode) return st
  const p = st.players[0]
  if (findBugangFace(st, p.hand) !== face) return st
  p.hand.splice(p.hand.indexOf(face), 1)
  const meld = p.melds.find((m) => m.kind === 'peng' && m.a === faceIndex(face))
  if (meld) {
    meld.kind = 'gang'
    meld.bug = true
  }
  st.gangCount++
  pushFeed(st, `你 补杠 ${tileText(face)}`)
  robKong(st, 0, face)
  return st
}

export interface HumanClaimAction {
  type: 'hu' | 'peng' | 'gang' | 'chi' | 'pass'
  chiLow?: number
}

export function humanClaim(prev: MjState, act: HumanClaimAction): MjState {
  const st = clone(prev)
  if (st.phase !== 'playing' || st.awaiting !== 'humanClaim' || !st.claims) return st
  const e = st.claims[st.claimIdx]
  if (!e || e.seat !== 0) return st
  if (act.type === 'pass') {
    st.claimIdx++
    processClaims(st)
    return st
  }
  const legal =
    (act.type === 'hu' && e.canHu) ||
    (act.type === 'peng' && e.canPeng) ||
    (act.type === 'gang' && e.canGang) ||
    (act.type === 'chi' && e.chiOptions.length > 0)
  if (!legal) return st
  if (act.type === 'chi' && act.chiLow != null) {
    const picked = e.chiOptions.find((o) => o.low === act.chiLow)
    if (picked) {
      const rest = e.chiOptions.filter((o) => o !== picked)
      e.chiOptions.length = 0
      e.chiOptions.push(picked, ...rest)
    }
  }
  executeClaim(st, e, act.type)
  return st
}

// ---------- 推进 ----------

/** awaiting==='ai' 时执行 AI 一步（UI 以 AI_THINK_MS 定时调） */
export function advance(prev: MjState): MjState {
  const st = clone(prev)
  if (st.phase !== 'playing' || st.awaiting !== 'ai') return st
  aiAct(st)
  return st
}
