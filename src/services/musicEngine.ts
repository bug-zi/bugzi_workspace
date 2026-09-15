// 轻音乐引擎（音乐吧设计 §二/§四）：渲染层 HTMLAudioElement 单例，挂在任何模块组件之外——切模块不断声。
// 与白噪音互斥（audioExclusive）；曲库目录由 MusicPanel 同步进来（setCatalog，丢文件 toast 报曲名用）；
// mp3 字节经 IPC 读入 → Blob URL 播放；时长懒回写（music:duration）；MusicState 持久化（重启记参数默认暂停）。
import { registerAudioStopper, markAudioActive, stopOthers } from './audioExclusive'
import { shuffleIds } from './queueOrder'
import { SettingsKeys } from '../shared/types'
import type { MusicLoopMode } from '../shared/types'

export interface MusicEngineState {
  playing: boolean
  trackId: number | null
  /** 播放上下文（从哪个列表点播就按哪个连播；按加入时间序） */
  contextIds: number[]
  positionSec: number
  durationSec: number
  volume: number
  loopMode: MusicLoopMode
}

type Listener = () => void

class MusicEngine {
  private audio: HTMLAudioElement | null = null
  private url: string | null = null
  private catalog = new Map<number, string>() // id → title（丢文件提示用）
  private state: MusicEngineState = {
    playing: false,
    trackId: null,
    contextIds: [],
    positionSec: 0,
    durationSec: 0,
    volume: 80,
    loopMode: 'list-loop'
  }
  private version = 0
  private listeners = new Set<Listener>()
  private volumeTimer: ReturnType<typeof setTimeout> | null = null
  /** 连续加载失败计数（整轮上下文全失败则停，防死循环跳曲） */
  private failStreak = 0
  /** 引擎侧通知钩子（MusicPanel 挂载时接 toast，卸载置 null——同 noiseEngine.onNotice 惯例） */
  onNotice: ((msg: string) => void) | null = null

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  getSnapshot = (): number => this.version
  private emit(): void {
    this.version++
    this.listeners.forEach((fn) => fn())
  }

  isPlaying = (): boolean => this.state.playing
  getState = (): MusicEngineState => ({ ...this.state, contextIds: [...this.state.contextIds] })

  /** 曲库目录同步（MusicPanel 每次刷新后调用） */
  setCatalog = (tracks: { id: number; title: string }[]): void => {
    this.catalog = new Map(tracks.map((t) => [t.id, t.title]))
  }

  private titleOf(id: number): string {
    return this.catalog.get(id) ?? `#${id}`
  }

  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio
    const a = new Audio()
    a.volume = this.state.volume / 100
    a.addEventListener('loadedmetadata', () => {
      this.state.durationSec = a.duration
      if (this.state.trackId != null && Number.isFinite(a.duration)) {
        void window.api.music.duration(this.state.trackId, a.duration)
      }
      this.emit()
    })
    a.addEventListener('timeupdate', () => {
      this.state.positionSec = a.currentTime
      this.emit()
    })
    a.addEventListener('ended', () => {
      void this.onEnded()
    })
    this.audio = a
    return a
  }

  /** 加载曲目并播放（bytes → Blob URL）；失败提示并自动跳下一首 */
  private async loadAndPlay(id: number): Promise<void> {
    const a = this.ensureAudio()
    const prevId = this.state.trackId
    this.state.trackId = id
    this.state.positionSec = 0
    this.state.durationSec = 0
    this.emit()
    try {
      const bytes = await window.api.music.file(id)
      if (prevId != null && this.url) URL.revokeObjectURL(this.url)
      this.url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'audio/mpeg' }))
      a.src = this.url
      await a.play()
      this.state.playing = true
      this.failStreak = 0
      stopOthers('music')
      markAudioActive('music')
      this.emit()
    } catch (e) {
      this.state.playing = false
      this.emit()
      // 区分丢文件（IPC NOT_FOUND）与解码失败（如 NotSupportedError），提示不误导
      const msg = String((e as Error)?.message ?? '')
      const reason = msg.includes('NOT_FOUND') ? '文件丢失' : `无法解码（${(e as Error)?.name ?? '未知错误'}）`
      this.onNotice?.(`「${this.titleOf(id)}」${reason}，已跳过`)
      this.failStreak++
      if (this.failStreak >= Math.max(this.state.contextIds.length, 1)) {
        this.onNotice?.('列表内没有可播放的曲目，已停止')
        return
      }
      await this.skip(1)
    }
  }

  /** 在某列表上下文中点播（MusicPanel 曲目行点击） */
  playContext = async (ids: number[], startId: number): Promise<void> => {
    this.state.contextIds = [...ids]
    this.failStreak = 0
    await this.loadAndPlay(startId)
  }

  /** 恢复/继续播放（当前曲已加载则直接 play；无曲则空操作） */
  play = async (): Promise<void> => {
    if (this.state.trackId == null) return
    const a = this.ensureAudio()
    if (!a.src) {
      await this.loadAndPlay(this.state.trackId)
      return
    }
    try {
      await a.play()
      this.state.playing = true
      stopOthers('music')
      markAudioActive('music')
      this.emit()
    } catch {
      this.onNotice?.('音频初始化失败')
    }
  }

  pause = (): void => {
    if (!this.state.playing) return
    this.audio?.pause()
    this.state.playing = false
    this.persist()
    this.emit()
  }

  toggle = async (): Promise<void> => {
    if (this.state.playing) this.pause()
    else await this.play()
  }

  /** 快捷控件恢复用：加载持久化曲目但不自动播（App 启动灌入） */
  loadPersisted = (saved: { trackId?: unknown; loopMode?: unknown; volume?: unknown }): void => {
    if (typeof saved.loopMode === 'string' && ['list-loop', 'single-loop', 'random'].includes(saved.loopMode)) {
      this.state.loopMode = saved.loopMode as MusicLoopMode
    }
    if (typeof saved.volume === 'number' && Number.isFinite(saved.volume)) {
      this.state.volume = Math.min(100, Math.max(0, Math.round(saved.volume)))
    }
    if (typeof saved.trackId === 'number') {
      this.state.trackId = saved.trackId
    }
    this.emit()
  }

  persist = (): void => {
    void window.api.settings.set(
      SettingsKeys.MusicState,
      JSON.stringify({ trackId: this.state.trackId, loopMode: this.state.loopMode, volume: this.state.volume })
    )
  }

  private idxOfCurrent(): number {
    return this.state.contextIds.indexOf(this.state.trackId ?? -1)
  }

  /** 切上/下一首（手动操作：list-loop/sequence 顺序回绕；random 走洗牌） */
  private async skip(dir: 1 | -1): Promise<void> {
    const ids = this.state.contextIds
    if (ids.length === 0) return
    let nextId: number
    if (this.state.loopMode === 'random') {
      const order = shuffleIds(ids.map(String), String(this.state.trackId))
      nextId = Number(order[0])
    } else {
      const i = this.idxOfCurrent()
      nextId = ids[(i + dir + ids.length) % ids.length]
    }
    await this.loadAndPlay(nextId)
  }

  next = async (): Promise<void> => this.skip(1)
  prev = async (): Promise<void> => this.skip(-1)

  /** 播完推进：单曲循环重播；random 洗牌；list-loop 回绕；顺序模式到末尾自动暂停 */
  private async onEnded(): Promise<void> {
    const ids = this.state.contextIds
    if (this.state.loopMode === 'single-loop') {
      const a = this.ensureAudio()
      a.currentTime = 0
      await a.play()
      return
    }
    if (ids.length === 0) {
      this.state.playing = false
      this.emit()
      return
    }
    if (this.state.loopMode === 'random') {
      await this.skip(1)
      return
    }
    const i = this.idxOfCurrent()
    if (i + 1 < ids.length) {
      await this.loadAndPlay(ids[i + 1])
    } else if (this.state.loopMode === 'list-loop') {
      await this.loadAndPlay(ids[0])
    } else {
      this.state.playing = false
      this.persist()
      this.emit()
      this.onNotice?.('轻音乐播完了')
    }
  }

  seek = (sec: number): void => {
    if (this.audio && Number.isFinite(sec)) {
      this.audio.currentTime = Math.max(0, Math.min(this.state.durationSec || sec, sec))
      this.state.positionSec = this.audio.currentTime
      this.emit()
    }
  }

  setVolume = (v: number): void => {
    this.state.volume = Math.min(100, Math.max(0, Math.round(v)))
    if (this.audio) this.audio.volume = this.state.volume / 100
    if (this.volumeTimer) clearTimeout(this.volumeTimer)
    this.volumeTimer = setTimeout(() => this.persist(), 500) // 拖动防抖
    this.emit()
  }

  setLoopMode = (m: MusicLoopMode): void => {
    this.state.loopMode = m
    this.persist()
    this.emit()
  }
}

export const musicEngine = new MusicEngine()
// 互斥注册（音乐吧设计 §二）：白噪音开播时经 stopOthers 调本 stop 暂停轻音乐
registerAudioStopper('music', () => musicEngine.pause())
