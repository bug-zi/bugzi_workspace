// 白噪音场景注册表（specs §1）：场景 = 层清单 + 出厂预设 + 图标，引擎只认「层」不认具体场景；
// 后续新场景（海浪/篝火…）= 追加一份配置项，引擎零改动。频点/间隔/配比为调参基准，实施听感环节可微调，id 与结构定死。

/** 稳态层：噪声缓冲循环 → 滤波 → 增益，持续发声 */
export interface SteadyLayerDef {
  id: string
  label: string
  type: 'steady'
  noise: 'white' | 'pink' | 'brown'
  filter: { kind: 'lowpass' | 'bandpass' | 'highpass'; freq: number; q?: number }
  /** 幅度抖动（密雨的雨点忽密忽疏感）：gain = 1 ± depth */
  am?: { rateHz: number; depth: number }
  /** 低通截止慢扫（风的阵风感）：freq ± depthHz */
  lfoFilter?: { rateHz: number; depthHz: number }
}

/** 事件层合成参数覆盖（260911 新场景）：缺省用各 spawn 类型内置随机区间；
 *  多场景/多层共用同种合成器时（鸟/鸥同 chirp）用它差异化音高与时长 */
export interface EventSpawnCfg {
  /** 基准频率下限/上限（Hz；chirp/clink 的音高、wave/crackle 的滤波中心） */
  freqMin?: number
  freqMax?: number
  /** 单次发声时长下限/上限（秒） */
  durMin?: number
  durMax?: number
  /** chirp 连发音节数上限（实际 1..n 随机） */
  chirpsMax?: number
}

/** 事件层：随机间隔触发的离散短声（雷/水滴/敲击/鸟鸣/浪涌/噼啪/杯盘），由引擎调度器驱动 */
export interface EventLayerDef {
  id: string
  label: string
  type: 'event'
  minGapSec: number
  maxGapSec: number
  spawn: 'thunder' | 'drip' | 'tap' | 'chirp' | 'wave' | 'crackle' | 'clink'
  spawnCfg?: EventSpawnCfg
}

export type NoiseLayerDef = SteadyLayerDef | EventLayerDef

export interface NoisePreset {
  id: string
  label: string
  layers: Record<string, number>
}

export interface NoiseScene {
  id: string
  label: string
  icon: string
  layers: NoiseLayerDef[]
  /** 进场景/切场景时的默认层配比 */
  defaults: Record<string, number>
  presets: NoisePreset[]
}

/** 雨场景（首版唯一场景）：8 层 */
const RAIN: NoiseScene = {
  id: 'rain',
  label: '雨',
  icon: 'rainy',
  layers: [
    { id: 'thunder', label: '远雷', type: 'event', minGapSec: 20, maxGapSec: 60, spawn: 'thunder' },
    { id: 'body_low', label: '雨体·沉', type: 'steady', noise: 'brown', filter: { kind: 'lowpass', freq: 120 } },
    { id: 'body_hiss', label: '雨体·沙沙', type: 'steady', noise: 'pink', filter: { kind: 'bandpass', freq: 600, q: 0.7 } },
    { id: 'patter', label: '密雨', type: 'steady', noise: 'white', filter: { kind: 'bandpass', freq: 2000, q: 0.6 }, am: { rateHz: 1, depth: 0.15 } },
    { id: 'fine', label: '细雨·高频', type: 'steady', noise: 'white', filter: { kind: 'highpass', freq: 4000 } },
    { id: 'drips', label: '屋檐滴水', type: 'event', minGapSec: 0.2, maxGapSec: 2, spawn: 'drip' },
    { id: 'window', label: '雨打窗', type: 'event', minGapSec: 1, maxGapSec: 6, spawn: 'tap' },
    { id: 'wind', label: '风', type: 'steady', noise: 'pink', filter: { kind: 'lowpass', freq: 500 }, lfoFilter: { rateHz: 0.08, depthHz: 300 } }
  ],
  defaults: { thunder: 20, body_low: 40, body_hiss: 60, patter: 50, fine: 40, drips: 40, window: 20, wind: 30 },
  presets: [
    { id: 'drizzle', label: '细雨', layers: { thunder: 0, body_low: 15, body_hiss: 45, patter: 20, fine: 35, drips: 25, window: 10, wind: 20 } },
    { id: 'downpour', label: '暴雨', layers: { thunder: 10, body_low: 70, body_hiss: 75, patter: 85, fine: 55, drips: 15, window: 30, wind: 40 } },
    { id: 'eaves', label: '屋檐夜雨', layers: { thunder: 0, body_low: 20, body_hiss: 35, patter: 15, fine: 25, drips: 80, window: 15, wind: 10 } },
    { id: 'storm', label: '雷雨', layers: { thunder: 70, body_low: 65, body_hiss: 70, patter: 75, fine: 45, drips: 10, window: 25, wind: 55 } },
    { id: 'breeze', label: '微风细雨', layers: { thunder: 0, body_low: 10, body_hiss: 40, patter: 15, fine: 40, drips: 15, window: 5, wind: 65 } }
  ]
}

/** 森林场景（260911 新场景）：风叶 + 林涛稳态层，鸟鸣事件层（近鸟连发/远鸟细碎两变体） */
const FOREST: NoiseScene = {
  id: 'forest',
  label: '森林',
  icon: 'forest',
  layers: [
    { id: 'leaves', label: '树叶沙沙', type: 'steady', noise: 'white', filter: { kind: 'bandpass', freq: 1500, q: 0.5 }, am: { rateHz: 0.3, depth: 0.25 } },
    { id: 'gust', label: '阵风', type: 'steady', noise: 'brown', filter: { kind: 'lowpass', freq: 400 }, lfoFilter: { rateHz: 0.07, depthHz: 250 } },
    { id: 'canopy', label: '林涛', type: 'steady', noise: 'brown', filter: { kind: 'lowpass', freq: 150 } },
    { id: 'birds', label: '鸟鸣', type: 'event', minGapSec: 2, maxGapSec: 8, spawn: 'chirp' },
    { id: 'birds_far', label: '远处鸟语', type: 'event', minGapSec: 4, maxGapSec: 15, spawn: 'chirp', spawnCfg: { freqMin: 3200, freqMax: 5200, durMin: 0.04, durMax: 0.09, chirpsMax: 2 } }
  ],
  defaults: { leaves: 35, gust: 45, canopy: 40, birds: 35, birds_far: 22 },
  presets: [
    { id: 'morning', label: '晨林', layers: { leaves: 25, gust: 30, canopy: 30, birds: 60, birds_far: 45 } },
    { id: 'noon', label: '午后微风', layers: { leaves: 55, gust: 60, canopy: 40, birds: 15, birds_far: 8 } },
    { id: 'night', label: '深夜林语', layers: { leaves: 35, gust: 70, canopy: 55, birds: 0, birds_far: 0 } }
  ]
}

/** 海浪场景：浪涌事件层（慢起慢落包络）+ 碎沫/海风稳态层 + 稀疏鸥鸣（低频长下滑变体） */
const OCEAN: NoiseScene = {
  id: 'ocean',
  label: '海浪',
  icon: 'waves',
  layers: [
    { id: 'surge', label: '浪涌', type: 'event', minGapSec: 6, maxGapSec: 12, spawn: 'wave' },
    { id: 'foam', label: '浪花碎沫', type: 'steady', noise: 'white', filter: { kind: 'highpass', freq: 3500 }, lfoFilter: { rateHz: 0.12, depthHz: 2000 } },
    { id: 'seawind', label: '海风', type: 'steady', noise: 'pink', filter: { kind: 'bandpass', freq: 800, q: 0.4 }, am: { rateHz: 0.15, depth: 0.2 } },
    { id: 'gulls', label: '鸥鸣', type: 'event', minGapSec: 15, maxGapSec: 45, spawn: 'chirp', spawnCfg: { freqMin: 900, freqMax: 1400, durMin: 0.5, durMax: 1.0, chirpsMax: 1 } }
  ],
  defaults: { surge: 55, foam: 30, seawind: 35, gulls: 25 },
  presets: [
    { id: 'beach', label: '沙滩缓浪', layers: { surge: 50, foam: 22, seawind: 30, gulls: 25 } },
    { id: 'reef', label: '礁石激浪', layers: { surge: 80, foam: 60, seawind: 45, gulls: 10 } },
    { id: 'tide', label: '深夜潮声', layers: { surge: 45, foam: 25, seawind: 20, gulls: 0 } }
  ]
}

/** 夜晚篝火场景：火苗幅度快抖 + 噼啪事件层（密集窄脉冲）+ 炭火低鸣 + 慢扫夜风 */
const FIRE: NoiseScene = {
  id: 'fire',
  label: '夜晚篝火',
  icon: 'local_fire_department',
  layers: [
    { id: 'flames', label: '火苗噗噗', type: 'steady', noise: 'brown', filter: { kind: 'lowpass', freq: 300 }, am: { rateHz: 2.5, depth: 0.35 } },
    { id: 'crackles', label: '噼啪爆裂', type: 'event', minGapSec: 0.3, maxGapSec: 2.5, spawn: 'crackle' },
    { id: 'coals', label: '炭火低鸣', type: 'steady', noise: 'brown', filter: { kind: 'lowpass', freq: 100 } },
    { id: 'nightwind', label: '夜风', type: 'steady', noise: 'pink', filter: { kind: 'bandpass', freq: 500, q: 0.5 }, lfoFilter: { rateHz: 0.05, depthHz: 300 } }
  ],
  defaults: { flames: 55, crackles: 40, coals: 35, nightwind: 20 },
  presets: [
    { id: 'crackling', label: '围炉噼啪', layers: { flames: 55, crackles: 65, coals: 30, nightwind: 10 } },
    { id: 'embers', label: '余烬低语', layers: { flames: 25, crackles: 15, coals: 60, nightwind: 15 } },
    { id: 'soft', label: '夜话轻焰', layers: { flames: 45, crackles: 30, coals: 25, nightwind: 30 } }
  ]
}

/** 咖啡馆场景：人声为粉噪多段滤波 + 起伏的近似模拟（非真人录音，听感预期已对齐）；
 *  杯盘谐振 ping + 环境杂响（tap 现成）+ 低频底噪 */
const CAFE: NoiseScene = {
  id: 'cafe',
  label: '咖啡馆',
  icon: 'local_cafe',
  layers: [
    { id: 'murmur_low', label: '人声嗡嗡', type: 'steady', noise: 'pink', filter: { kind: 'bandpass', freq: 350, q: 0.3 }, am: { rateHz: 0.8, depth: 0.3 } },
    { id: 'murmur_hi', label: '人声细碎', type: 'steady', noise: 'pink', filter: { kind: 'bandpass', freq: 1100, q: 0.5 }, am: { rateHz: 1.2, depth: 0.35 } },
    { id: 'cups', label: '杯盘轻碰', type: 'event', minGapSec: 8, maxGapSec: 30, spawn: 'clink' },
    { id: 'clatter', label: '环境杂响', type: 'event', minGapSec: 3, maxGapSec: 12, spawn: 'tap' },
    { id: 'hvac', label: '空调底噪', type: 'steady', noise: 'brown', filter: { kind: 'lowpass', freq: 200 } }
  ],
  defaults: { murmur_low: 55, murmur_hi: 35, cups: 30, clatter: 20, hvac: 30 },
  presets: [
    { id: 'chatter', label: '午后闲谈', layers: { murmur_low: 65, murmur_hi: 45, cups: 30, clatter: 20, hvac: 25 } },
    { id: 'corner', label: '角落安静', layers: { murmur_low: 30, murmur_hi: 15, cups: 15, clatter: 8, hvac: 25 } },
    { id: 'closing', label: '打烊时分', layers: { murmur_low: 18, murmur_hi: 8, cups: 20, clatter: 12, hvac: 40 } }
  ]
}

export const SCENES: NoiseScene[] = [RAIN, FOREST, OCEAN, FIRE, CAFE]

export function sceneById(id: string): NoiseScene | undefined {
  return SCENES.find((s) => s.id === id)
}
