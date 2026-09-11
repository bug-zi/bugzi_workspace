// 队列配置写入小件（播放队列轮·第38轮反馈修订）：setQueueConfig + settings 落盘与行 id 生成收敛一处，
// QueuePanel（整表编辑）与 MixerPanel chip 快捷追加（经 NoisePage）共用，防两处各写一套。
import { noiseEngine, type NoiseQueueItem, type NoiseQueueMode } from '../../services/noiseEngine'
import { SettingsKeys } from '../../shared/types'

/** 新加入项的默认时长（分钟；加入后可在队列行逐项改） */
export const QUEUE_DEFAULT_MINUTES = 30

export function genQueueItemId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** 队列配置唯一写入口：引擎为状态源，settings 随写落盘 */
export function saveQueueConfig(items: NoiseQueueItem[], mode: NoiseQueueMode): void {
  noiseEngine.setQueueConfig(items, mode)
  void window.api.settings.set(SettingsKeys.NoisePlayQueue, JSON.stringify({ items, mode }))
}

/** chip 快捷追加的音效引用（MixerPanel → NoisePage） */
export interface QueueSoundRef {
  kind: 'preset' | 'custom'
  sceneId: string
  presetId?: string
  mixId?: string
  label: string
}
