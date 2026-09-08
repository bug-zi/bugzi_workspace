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

/** 事件层：随机间隔触发的离散短声（雷/水滴/敲击），由引擎调度器驱动 */
export interface EventLayerDef {
  id: string
  label: string
  type: 'event'
  minGapSec: number
  maxGapSec: number
  spawn: 'thunder' | 'drip' | 'tap'
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

export const SCENES: NoiseScene[] = [RAIN]

export function sceneById(id: string): NoiseScene | undefined {
  return SCENES.find((s) => s.id === id)
}
