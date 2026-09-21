// 音乐吧页薄壳（260915 更名+轻音乐）：大 tab「轻音乐 | 白噪音」（默认轻音乐，会话内保留）；
// 白噪音 tab 内保留既有「混音器 | 播放队列」子 tab 与两面板（零改动）；页头大播放按钮按
// 当前活跃音源口径（谁在播控谁；都停着控上次音源，从未播过默认白噪音——audioExclusive）。
import { useEffect, useState, useSyncExternalStore } from 'react'
import { noiseEngine, type TriggerState } from '../../services/noiseEngine'
import { SCENES } from '../../services/noiseScenes'
import { musicEngine } from '../../services/musicEngine'
import { activeAudioKind } from '../../services/audioExclusive'
import { SettingsKeys } from '../../shared/types'
import { useToast } from '../../components/Toast'
import MixerPanel from './MixerPanel'
import QueuePanel from './QueuePanel'
import MusicPanel from './MusicPanel'
import { QUEUE_DEFAULT_MINUTES, genQueueItemId, saveQueueConfig, type QueueSoundRef } from './queueStore'
import './noise.css'

/** 自定义混音（noise_custom_mixes JSON 条目；不含主音量；triggers = 260921 起携带的触发层快照，旧混音无此字段）；
 *  factoryKey = 出厂预设播种行（260921 冒烟反馈轮起预设并入本列表，可删不复活）；isDefault = 该场景默认混音 */
export interface CustomMix {
  id: string
  name: string
  sceneId: string
  layers: Record<string, number>
  triggers?: Record<string, TriggerState>
  factoryKey?: string
  isDefault?: boolean
  createdAt: string
}

/** 隐藏名单（noise_hidden JSON；260921 冒烟反馈轮）：删除场景/内置触发音/出厂混音行 = 进名单不显示、不复活 */
export interface NoiseHiddenData {
  scenes: string[]
  builtinTriggers: string[]
  factoryMixes: string[]
}

export function parseHidden(raw: string | null): NoiseHiddenData {
  const empty: NoiseHiddenData = { scenes: [], builtinTriggers: [], factoryMixes: [] }
  if (!raw) return empty
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    return { scenes: arr(o.scenes), builtinTriggers: arr(o.builtinTriggers), factoryMixes: arr(o.factoryMixes) }
  } catch {
    return empty
  }
}

/** 出厂预设播种：不在隐藏名单且列表里没有同 factoryKey 行的，追加为出厂混音（幂等） */
function seedFactories(mixes: CustomMix[], hidden: NoiseHiddenData): CustomMix[] {
  const next = [...mixes]
  for (const scene of SCENES) {
    for (const p of scene.presets) {
      const key = `${scene.id}:${p.id}`
      if (hidden.factoryMixes.includes(key)) continue
      if (next.some((m) => m.factoryKey === key)) continue
      next.push({
        id: `f:${key}`,
        name: p.label,
        sceneId: scene.id,
        layers: { ...p.layers },
        factoryKey: key,
        createdAt: new Date().toISOString()
      })
    }
  }
  return next
}

/** settings JSON 容错解析：非数组/缺关键字段的条目丢弃，坏数据不炸页面 */
function parseMixes(raw: string | null): CustomMix[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .filter(
        (m): m is CustomMix =>
          !!m &&
          typeof m === 'object' &&
          typeof (m as CustomMix).id === 'string' &&
          typeof (m as CustomMix).name === 'string' &&
          typeof (m as CustomMix).sceneId === 'string' &&
          typeof (m as CustomMix).layers === 'object'
      )
      .map((m) => ({
        ...m,
        factoryKey: typeof m.factoryKey === 'string' ? m.factoryKey : undefined,
        isDefault: m.isDefault === true
      }))
  } catch {
    return []
  }
}

export default function NoisePage() {
  const { toast } = useToast()
  useSyncExternalStore(noiseEngine.subscribe, noiseEngine.getSnapshot)
  useSyncExternalStore(musicEngine.subscribe, musicEngine.getSnapshot)
  const [pageTab, setPageTab] = useState<'music' | 'noise'>('music')
  const [tab, setTab] = useState<'mixer' | 'queue'>('mixer')
  const [mixes, setMixes] = useState<CustomMix[]>([])
  const [hidden, setHidden] = useState<NoiseHiddenData>({ scenes: [], builtinTriggers: [], factoryMixes: [] })

  useEffect(() => {
    void (async () => {
      const [mixRaw, hiddenRaw] = await Promise.all([
        window.api.settings.get(SettingsKeys.NoiseCustomMixes),
        window.api.settings.get(SettingsKeys.NoiseHidden)
      ])
      const loaded = parseMixes(mixRaw)
      const h = parseHidden(hiddenRaw)
      const seeded = seedFactories(loaded, h)
      setHidden(h)
      setMixes(seeded)
      if (seeded.length !== loaded.length) {
        void window.api.settings.set(SettingsKeys.NoiseCustomMixes, JSON.stringify(seeded))
      }
    })()
  }, [])

  const persistHidden = (next: NoiseHiddenData): void => {
    setHidden(next)
    void window.api.settings.set(SettingsKeys.NoiseHidden, JSON.stringify(next))
  }

  // 引擎通知 → toast（白噪音：退出队列/队列播完等轻提示；本页 keep-alive 常驻，挂载即接管）
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

  // 活跃音源口径：谁在播控谁；都停着控上次音源（audioExclusive.lastActive，默认 noise）
  const activeKind = noiseEngine.isPlaying() ? 'noise' : musicEngine.isPlaying() ? 'music' : activeAudioKind()
  const activePlaying = activeKind === 'music' ? musicEngine.isPlaying() : noiseEngine.isPlaying()

  const onToggle = (): void => {
    if (activeKind === 'music') void musicEngine.toggle()
    else noiseEngine.toggle().catch(() => toast('音频初始化失败'))
  }

  return (
    <div className="module-page noise-page">
      <div className="module-header">
        <span className="module-title">音乐吧</span>
        <span className="module-sub">全局背景音 · 切换模块不打断</span>
        <div className="recycle-tabs noise-tabs">
          <button
            className={`recycle-tab${pageTab === 'music' ? ' active' : ''}`}
            onClick={() => setPageTab('music')}
          >
            轻音乐
          </button>
          <button
            className={`recycle-tab${pageTab === 'noise' ? ' active' : ''}`}
            onClick={() => setPageTab('noise')}
          >
            白噪音
          </button>
        </div>
        <button className="btn btn-primary noise-play" style={{ marginLeft: 'auto' }} onClick={onToggle}>
          <span className="material-symbols-outlined">{activePlaying ? 'pause' : 'play_arrow'}</span>
          {activePlaying ? '暂停' : '播放'}
        </button>
      </div>
      {pageTab === 'music' ? (
        <MusicPanel />
      ) : (
        <>
          <div className="recycle-tabs noise-tabs" style={{ marginBottom: 10 }}>
            <button className={`recycle-tab${tab === 'mixer' ? ' active' : ''}`} onClick={() => setTab('mixer')}>
              混音器
            </button>
            <button className={`recycle-tab${tab === 'queue' ? ' active' : ''}`} onClick={() => setTab('queue')}>
              播放队列
            </button>
          </div>
          {tab === 'mixer' ? (
            <MixerPanel
              mixes={mixes}
              persistMixes={persistMixes}
              hidden={hidden}
              persistHidden={persistHidden}
              onAddToQueue={addToQueue}
              onViewQueue={() => setTab('queue')}
            />
          ) : (
            <QueuePanel mixes={mixes} />
          )}
        </>
      )}
    </div>
  )
}
