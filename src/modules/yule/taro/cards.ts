// 塔罗牌常量（娱乐城 specs §1）：韦特塔罗 78 张——大阿卡纳 22 + 小阿卡纳 56（程序生成）。
// 不内置牌意文案：AI 解读按牌名 + 正逆位 + 牌位由 LLM 生成（specs §4）。

export interface TaroCardDef {
  name: string // 中文牌名，如「愚者」「权杖王后」
  major: boolean
  no: number // 大阿卡纳 0..21；小阿卡纳 1..56
}

export const MAJOR_ARCANA = [
  '愚者',
  '魔术师',
  '女祭司',
  '女皇',
  '皇帝',
  '教皇',
  '恋人',
  '战车',
  '力量',
  '隐者',
  '命运之轮',
  '正义',
  '倒吊人',
  '死神',
  '节制',
  '恶魔',
  '高塔',
  '星星',
  '月亮',
  '太阳',
  '审判',
  '世界'
]

const SUITS: { key: string; name: string }[] = [
  { key: 'wands', name: '权杖' },
  { key: 'cups', name: '圣杯' },
  { key: 'swords', name: '宝剑' },
  { key: 'pentacles', name: '星币' }
]
const RANKS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '侍从', '骑士', '王后', '国王']

export const TARO_CARDS: TaroCardDef[] = [
  ...MAJOR_ARCANA.map((name, i) => ({ name, major: true, no: i })),
  ...SUITS.flatMap((s) => RANKS.map((r) => ({ name: `${s.name}${r}`, major: false, no: 0 }))).map((c, i) => ({
    ...c,
    no: i + 1
  }))
]

/** 从 78 张里抽 n 张不重复（正逆位各 50%），用 poker engine 的 Card 做随机种子无必要——直接独立洗牌 */
export interface DrawnCard {
  def: TaroCardDef
  upright: boolean
  position: string // 牌位中文（如「过去」）
}

export function drawCards(spread: TaroSpreadKey, usedRandom: () => number = Math.random): DrawnCard[] {
  const spreadDef = TARO_SPREADS[spread]
  const pool = [...TARO_CARDS]
  const out: DrawnCard[] = []
  for (let i = 0; i < spreadDef.positions.length; i++) {
    const idx = Math.floor(usedRandom() * pool.length)
    const def = pool.splice(idx, 1)[0]
    out.push({ def, upright: usedRandom() < 0.5, position: spreadDef.positions[i] })
  }
  return out
}

export type TaroSpreadKey = 'single' | 'three'

export interface TaroSpreadDef {
  key: TaroSpreadKey
  name: string
  desc: string
  positions: string[]
}

export const TARO_SPREADS: Record<TaroSpreadKey, TaroSpreadDef> = {
  single: { key: 'single', name: '单张 · 每日指引', desc: '抽一张牌，看今天的主题与提醒', positions: ['指引'] },
  three: {
    key: 'three',
    name: '三张 · 过去现在未来',
    desc: '三张牌铺出事情的来路与去向',
    positions: ['过去', '现在', '未来']
  }
}
