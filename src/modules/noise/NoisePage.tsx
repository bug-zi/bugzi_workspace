// 白噪音页薄壳（播放队列轮 §4）：header tab「混音器 | 播放队列」+ 播放大按钮两 tab 共用；
// 自定义混音在本层加载/持久化（两面板共用）并同步引擎（队列解析 custom 项的依据）。
import { useEffect, useState, useSyncExternalStore } from 'react'
import { noiseEngine } from '../../services/noiseEngine'
import { SettingsKeys } from '../../shared/types'
import { useToast } from '../../components/Toast'
import MixerPanel from './MixerPanel'
import QueuePanel from './QueuePanel'
import { QUEUE_DEFAULT_MINUTES, genQueueItemId, saveQueueConfig, type QueueSoundRef } from './queueStore'
import './noise.css'

/** 自定义混音（noise_custom_mixes JSON 条目；不含主音量） */
export interface CustomMix {
  id: string
  name: string
  sceneId: string
  layers: Record<string, number>
  createdAt: string
}

/** settings JSON 容错解析：非数组/缺关键字段的条目丢弃，坏数据不炸页面 */
function parseMixes(raw: string | null): CustomMix[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (m): m is CustomMix =>
        !!m &&
        typeof m === 'object' &&
        typeof (m as CustomMix).id === 'string' &&
        typeof (m as CustomMix).name === 'string' &&
        typeof (m as CustomMix).sceneId === 'string' &&
        typeof (m as CustomMix).layers === 'object'
    )
  } catch {
    return []
  }
}

export default function NoisePage() {
  const { toast } = useToast()
  useSyncExternalStore(noiseEngine.subscribe, noiseEngine.getSnapshot)
  const st = noiseEngine.getState()
  const [tab, setTab] = useState<'mixer' | 'queue'>('mixer')
  const [mixes, setMixes] = useState<CustomMix[]>([])

  useEffect(() => {
    void window.api.settings.get(SettingsKeys.NoiseCustomMixes).then((raw) => setMixes(parseMixes(raw)))
  }, [])

  // 引擎通知 → toast（退出队列/队列播完等轻提示；本页 keep-alive 常驻，挂载即接管）
  useEffect(() => {
    noiseEngine.onNotice = (msg: string): void => toast(msg)
    return () => {
      noiseEngine.onNotice = null
    }
  }, [toast])

  // 自定义混音同步引擎（队列解析 kind=custom 项的依据）
  useEffect(() => {
    noiseEngine.setCustomMixes(mixes)
  }, [mixes])

  const persistMixes = (next: CustomMix[]): void => {
    setMixes(next)
    void window.api.settings.set(SettingsKeys.NoiseCustomMixes, JSON.stringify(next))
  }

  // chip 快捷追加（第38轮反馈修订）：默认 30 分钟追加队尾；队列运行中也可加（下次推进/重洗自然纳入）
  const addToQueue = (ref: QueueSoundRef): void => {
    const q = noiseEngine.getQueue()
    saveQueueConfig(
      [
        ...q.items,
        {
          id: genQueueItemId(),
          kind: ref.kind,
          sceneId: ref.sceneId,
          ...(ref.kind === 'preset' ? { presetId: ref.presetId } : { mixId: ref.mixId }),
          minutes: QUEUE_DEFAULT_MINUTES
        }
      ],
      q.mode
    )
    toast(`已加入队列：${ref.label}`)
  }

  const onToggle = (): void => {
    noiseEngine.toggle().catch(() => toast('音频初始化失败'))
  }

  return (
    <div className="module-page noise-page">
      <div className="module-header">
        <span className="module-title">白噪音</span>
        <span className="module-sub">全局背景音 · 切换模块不打断</span>
        <div className="recycle-tabs noise-tabs">
          <button className={`recycle-tab${tab === 'mixer' ? ' active' : ''}`} onClick={() => setTab('mixer')}>
            混音器
          </button>
          <button className={`recycle-tab${tab === 'queue' ? ' active' : ''}`} onClick={() => setTab('queue')}>
            播放队列
          </button>
        </div>
        <button className="btn btn-primary noise-play" style={{ marginLeft: 'auto' }} onClick={onToggle}>
          <span className="material-symbols-outlined">{st.playing ? 'pause' : 'play_arrow'}</span>
          {st.playing ? '暂停' : '播放'}
        </button>
      </div>
      {tab === 'mixer' ? (
        <MixerPanel mixes={mixes} persistMixes={persistMixes} onAddToQueue={addToQueue} onViewQueue={() => setTab('queue')} />
      ) : (
        <QueuePanel mixes={mixes} />
      )}
    </div>
  )
}
