// 麻将牌面常量与工具（娱乐城 specs §11.1）：灵溪麻将 144 张
// = 序数牌（万W/筒T/索S × 1-9）各 4 张 + 字牌（东南西北风 + 中发白）各 4 张 + 花牌（春夏秋冬梅兰菊竹）各 1 张
// 白板 BB 属字牌但走补花；花/白板作为财神面时不可补花（留在手中只计台）。

export type TileId = string

/** 序数牌花色（万/筒/索） */
export const SUIT_HANZI = ['万', '筒', '索'] as const
export const WIND_FACES = ['EF', 'SF', 'WF', 'NF'] as const
export const DRAGON_FACES = ['RZ', 'FC', 'BB'] as const
export const HONOR_FACES = [...WIND_FACES, ...DRAGON_FACES]
export const FLOWER_FACES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'] as const
/** 花牌中文名（F1-F8 = 春夏秋冬梅兰菊竹） */
export const FLOWER_TEXT: Record<string, string> = {
  F1: '春',
  F2: '夏',
  F3: '秋',
  F4: '冬',
  F5: '梅',
  F6: '兰',
  F7: '菊',
  F8: '竹'
}
export const HONOR_TEXT: Record<string, string> = {
  EF: '东',
  SF: '南',
  WF: '西',
  NF: '北',
  RZ: '中',
  FC: '发',
  BB: '白'
}
const NUM_HANZI = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']

/** 三个花牌四张组（起手集齐作暗杠；台数按组计）：春夏秋冬 / 梅兰菊竹 / 白板×4 */
export const FLOWER_QUARTETS: { key: string; faces: string[] }[] = [
  { key: 'sxq', faces: ['F1', 'F2', 'F3', 'F4'] },
  { key: 'mljz', faces: ['F5', 'F6', 'F7', 'F8'] },
  { key: 'bb', faces: ['BB', 'BB', 'BB', 'BB'] }
]

/** 牌面全表（34 序数字牌面 + 8 花面） */
export const ALL_FACES: readonly string[] = [
  ...Array.from({ length: 9 }, (_, i) => `W${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `T${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `S${i + 1}`),
  ...HONOR_FACES,
  ...FLOWER_FACES
]

/** 万/筒/索序数牌面：首字母后必须跟数字——防止 WF(西风)/SF(南风) 被误判为序数牌 */
const SUIT_RE = /^[WTS][1-9]$/

export function isSuit(face: TileId): boolean {
  return SUIT_RE.test(face)
}
export function suitOf(face: TileId): number | null {
  return SUIT_RE.test(face) ? 'WTS'.indexOf(face[0]) : null
}
export function suitNum(face: TileId): number | null {
  return SUIT_RE.test(face) ? Number(face.slice(1)) : null
}
export function isHonor(face: TileId): boolean {
  return (HONOR_FACES as string[]).includes(face)
}
export function isFlower(face: TileId): boolean {
  return (FLOWER_FACES as readonly string[]).includes(face)
}
/** 财神可代替的面（除花牌与白板外的任意牌） */
export const JOKER_SUBSTITUTABLE = [
  ...Array.from({ length: 9 }, (_, i) => `W${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `T${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `S${i + 1}`),
  'EF',
  'SF',
  'WF',
  'NF',
  'RZ',
  'FC'
]

/** 牌面中文（三万 / 东 / 中 / 春） */
export function tileText(face: TileId): string {
  const suit = suitOf(face)
  if (suit != null) return `${NUM_HANZI[suitNum(face)!]}${SUIT_HANZI[suit]}`
  if (isFlower(face)) return FLOWER_TEXT[face] ?? face
  return HONOR_TEXT[face] ?? face
}
