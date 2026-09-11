// 白噪音引擎（specs §2）：渲染层 Web Audio 纯合成的模块级单例，挂在任何模块组件之外——切模块不断声。
// 主链：各层 Gain → master Gain → destination；暂停 = AudioContext 挂起 + 事件调度器停表（层节点保留，恢复不重建）。
import { SCENES, sceneById, type EventLayerDef, type NoiseLayerDef, type SteadyLayerDef } from './noiseScenes'
import { nextValidId, shuffleIds } from './queueOrder'

/** 稳态层实例资源 */
interface SteadyNodes {
  source: AudioBufferSourceNode
  filter: BiquadFilterNode
  amOsc?: OscillatorNode
  amDepth?: GainNode
  lfoOsc?: OscillatorNode
  lfoDepth?: GainNode
}

/** 层实例：gain 公共；steady 持续节点 / event 调度器 timer */
interface LayerInstance {
  def: NoiseLayerDef
  gain: GainNode
  steady?: SteadyNodes
  timer?: ReturnType<typeof setTimeout>
}

export interface NoiseEngineState {
  sceneId: string
  layers: Record<string, number>
  master: number
}

// —— 播放队列（播放队列轮 §3）：音效 = 出厂预设或自定义混音的统称，队列项以引用指向 ——
export interface NoiseQueueItem {
  id: string
  kind: 'preset' | 'custom'
  sceneId: string
  presetId?: string
  mixId?: string
  /** 播放时长（分钟，1–480） */
  minutes: number
}
export type NoiseQueueMode = 'sequence' | 'list-loop' | 'single-loop' | 'random'

export interface NoiseQueueSnapshot {
  items: NoiseQueueItem[]
  mode: NoiseQueueMode
  /** 运行中项的行 id；null = 队列未运行 */
  activeId: string | null
  remainMs: number
}

/** 引擎内自定义混音最小形态（resolveSound 解析 kind=custom 用；NoisePage 同步进来） */
export interface EngineMixRef {
  id: string
  sceneId: string
  layers: Record<string, number>
}

type Listener = () => void

const clamp100 = (v: number): number => Math.min(100, Math.max(0, Math.round(v)))

class NoiseEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  /** 事件层共用噪声缓冲（spawn 频繁，避免每次重新生成） */
  private sharedBuffers = new Map<'white' | 'pink' | 'brown', AudioBuffer>()
  private layers = new Map<string, LayerInstance>()
  private state: NoiseEngineState = { sceneId: SCENES[0].id, layers: { ...SCENES[0].defaults }, master: 60 }
  private running = false
  /** 快照版本号：任何变化（播放态/场景/滑杆）自增，useSyncExternalStore 依此重渲染 */
  private version = 0
  private listeners = new Set<Listener>()

  // —— 播放队列状态（播放队列轮 §3）——
  private customMixes: EngineMixRef[] = []
  private queueItems: NoiseQueueItem[] = []
  private queueMode: NoiseQueueMode = 'sequence'
  private queueActiveId: string | null = null
  private queueRemainMs = 0
  /** random 模式洗牌序（有效项 id 序列） */
  private queueShuffle: string[] = []
  private queueTimer: ReturnType<typeof setInterval> | null = null
  /** 切歌淡出淡入进行中（计时未启动；tick 跳过） */
  private queueTransiting = false
  /** 异步链代际：停止/打断后旧 fade 链自废 */
  private queueToken = 0
  /** 引擎侧通知钩子（退出队列/队列播完等轻提示；NoisePage 挂载时接 toast，卸载置 null） */
  onNotice: ((msg: string) => void) | null = null

  // —— 订阅（useSyncExternalStore 协议）——
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

  isPlaying = (): boolean => this.running

  getState = (): NoiseEngineState & { playing: boolean } => ({
    sceneId: this.state.sceneId,
    layers: { ...this.state.layers },
    master: this.state.master,
    playing: this.running
  })

  // —— 播放控制 ——

  play = async (): Promise<void> => {
    if (this.running) return
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.mapGain(this.state.master)
      this.master.connect(this.ctx.destination)
      this.buildScene()
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    this.running = true
    this.startSchedulers()
    if (this.queueActiveId != null) this.startQueueTimer() // 队列恢复计时（remainMs 续跑）
    this.emit()
  }

  pause = (): void => {
    if (!this.running) return
    this.running = false
    this.stopSchedulers()
    this.stopQueueTimer() // 队列计时冻结（remainMs 保留，play 恢复续跑）
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend()
    this.emit()
  }

  toggle = async (): Promise<void> => {
    if (this.running) this.pause()
    else await this.play()
  }

  // —— 参数（滑杆 0–100 → 增益 (v/100)^2 等响近似；setTargetAtTime 平滑无爆音）——

  private mapGain(v: number): number {
    return (v / 100) ** 2
  }

  setLayer = (id: string, v: number): void => {
    this.interruptQueue() // 队列运行中手动调层 = 用户接管，退出队列（声音不断）
    this.state.layers[id] = clamp100(v)
    const inst = this.layers.get(id)
    if (inst && this.ctx) inst.gain.gain.setTargetAtTime(this.mapGain(this.state.layers[id]), this.ctx.currentTime, 0.05)
    this.emit()
  }

  setMaster = (v: number): void => {
    this.state.master = clamp100(v)
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.mapGain(this.state.master), this.ctx.currentTime, 0.05)
    this.emit()
  }

  /** 切场景：拆当前层建新层（defaults），事件调度器随播放态重启 */
  setScene = (sceneId: string): void => {
    const scene = sceneById(sceneId)
    if (!scene || sceneId === this.state.sceneId) return
    this.interruptQueue() // 队列运行中手动切场景 = 用户接管（点同场景卡本为无操作，不触发）
    this.state = { sceneId, layers: { ...scene.defaults }, master: this.state.master }
    if (this.ctx) {
      this.buildScene()
      if (this.running) this.startSchedulers()
    }
    this.emit()
  }

  /** 启动恢复（App 挂载时读 settings 灌入）：只恢复参数不播放 */
  loadState = (saved: Partial<NoiseEngineState>): void => {
    const scene = sceneById(typeof saved.sceneId === 'string' ? saved.sceneId : '') ?? SCENES[0]
    const layers = { ...scene.defaults }
    if (saved.layers && typeof saved.layers === 'object') {
      for (const key of Object.keys(layers)) {
        const v = saved.layers[key]
        if (typeof v === 'number' && Number.isFinite(v)) layers[key] = clamp100(v)
      }
    }
    const master = typeof saved.master === 'number' && Number.isFinite(saved.master) ? clamp100(saved.master) : 60
    this.state = { sceneId: scene.id, layers, master }
    if (this.ctx) {
      this.buildScene()
      if (this.master) this.master.gain.value = this.mapGain(master)
      if (this.running) this.startSchedulers()
    }
    this.emit()
  }

  // —— 播放队列（播放队列轮 §3）——

  getQueue = (): NoiseQueueSnapshot => ({
    items: this.queueItems.map((it) => ({ ...it })),
    mode: this.queueMode,
    activeId: this.queueActiveId,
    remainMs: this.queueRemainMs
  })

  /** 自定义混音同步（NoisePage 加载/增删后调用；resolveSound 解析依据） */
  setCustomMixes = (mixes: EngineMixRef[]): void => {
    this.customMixes = mixes.map((m) => ({ id: m.id, sceneId: m.sceneId, layers: { ...m.layers } }))
  }

  /** 队列配置编辑（QueuePanel 每次增删改/换模式调用；引擎为唯一状态源，emit 驱动重渲染） */
  setQueueConfig = (items: NoiseQueueItem[], mode: NoiseQueueMode): void => {
    this.queueItems = items
    this.queueMode = mode
    if (this.queueActiveId != null && !items.some((it) => it.id === this.queueActiveId)) {
      // 运行中的行被删：视为该项播完，立即按模式推进
      this.advanceQueue()
    }
    this.emit()
  }

  /** 启动恢复队列配置（App 挂载读 settings 灌入）：只恢复配置不运行 */
  loadQueue = (saved: unknown): void => {
    if (!saved || typeof saved !== 'object') return
    const obj = saved as { items?: unknown; mode?: unknown }
    const items: NoiseQueueItem[] = Array.isArray(obj.items)
      ? obj.items
          .filter(
            (it): it is NoiseQueueItem =>
              !!it &&
              typeof it === 'object' &&
              typeof (it as NoiseQueueItem).id === 'string' &&
              ((it as NoiseQueueItem).kind === 'preset' ||
                ((it as NoiseQueueItem).kind === 'custom' && typeof (it as NoiseQueueItem).mixId === 'string')) &&
              ((it as NoiseQueueItem).kind === 'custom' ||
                typeof (it as NoiseQueueItem).presetId === 'string') &&
              typeof (it as NoiseQueueItem).sceneId === 'string' &&
              typeof (it as NoiseQueueItem).minutes === 'number' &&
              Number.isFinite((it as NoiseQueueItem).minutes)
          )
          .map((it) => ({ ...it, minutes: Math.min(480, Math.max(1, Math.round(it.minutes))) }))
      : []
    const mode: NoiseQueueMode =
      obj.mode === 'list-loop' || obj.mode === 'single-loop' || obj.mode === 'random' ? obj.mode : 'sequence'
    this.queueItems = items
    this.queueMode = mode
    this.emit()
  }

  /** 启动队列（UI 按钮；false = 无有效项，UI toast） */
  startQueue = async (): Promise<boolean> => {
    if (this.queueActiveId != null) return true // 已在运行，幂等
    const ids = this.queueItems.map((it) => it.id)
    let first: string | null = null
    if (this.queueMode === 'random') {
      const valid = ids.filter((id) => this.soundValid(id))
      if (valid.length === 0) return false
      this.queueShuffle = shuffleIds(valid, null)
      first = this.queueShuffle[0] ?? null
    } else {
      first = nextValidId('sequence', ids, (id) => this.soundValid(id), null)
    }
    if (!first) return false
    await this.play() // 确保音频上下文在跑（幂等）
    await this.playQueueSound(first)
    return true
  }

  /** 手动停止（队列按钮/打断共用）：清运行态，声音不断、master 归位用户值 */
  stopQueue = (): void => {
    if (this.queueActiveId == null) return
    this.queueToken++
    this.clearQueueRunState()
    this.restoreMaster()
    this.emit()
  }

  /** 手动混音操作 → 退出队列（setLayer/setScene 入口调用） */
  private interruptQueue(): void {
    if (this.queueActiveId == null) return
    this.stopQueue()
    this.onNotice?.('已退出队列播放')
  }

  private clearQueueRunState(): void {
    this.stopQueueTimer()
    this.queueActiveId = null
    this.queueRemainMs = 0
    this.queueShuffle = []
    this.queueTransiting = false
  }

  /** master 立即归位用户主音量（淡出途中被打断/停止的兜底；暂停挂起态下于恢复时生效） */
  private restoreMaster(): void {
    if (this.ctx && this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime)
      this.master.gain.setTargetAtTime(this.mapGain(this.state.master), this.ctx.currentTime, 0.05)
    }
  }

  private resolveSound(item: NoiseQueueItem): { sceneId: string; layers: Record<string, number> } | null {
    if (item.kind === 'preset') {
      const scene = sceneById(item.sceneId)
      const preset = scene?.presets.find((p) => p.id === item.presetId)
      return scene && preset ? { sceneId: scene.id, layers: preset.layers } : null
    }
    const mix = this.customMixes.find((m) => m.id === item.mixId)
    return mix ? { sceneId: mix.sceneId, layers: mix.layers } : null
  }

  private soundValid = (id: string): boolean => {
    const item = this.queueItems.find((it) => it.id === id)
    return item != null && this.resolveSound(item) != null
  }

  /** 切歌主链：淡出 → 私有切场景/配比 → 淡入 → 起计时（过渡时长不占播放时长） */
  private async playQueueSound(id: string): Promise<void> {
    const item = this.queueItems.find((it) => it.id === id)
    const sound = item ? this.resolveSound(item) : null
    if (!item || !sound) {
      this.advanceFrom(id) // 失效（启动后被删等）：按模式推进下一项
      return
    }
    const token = ++this.queueToken
    this.queueActiveId = id
    this.queueRemainMs = item.minutes * 60_000
    this.queueTransiting = true
    this.emit()
    await this.fadeMaster(0, 1.2, token)
    if (this.queueToken !== token) return
    this.applySoundProgrammatic(sound.sceneId, sound.layers)
    await this.fadeMaster(this.mapGain(this.state.master), 1.2, token)
    if (this.queueToken !== token) return
    this.queueTransiting = false
    this.emit()
    this.startQueueTimer()
  }

  /** setTargetAtTime 渐近淡变（时间常数 seconds/3）；seconds 后 resolve，token 过期链自废。
   *  注：ctx 挂起时音频时钟冻结，此处按墙钟计时——恢复后淡变立即收敛，属可接受边界 */
  private fadeMaster(target: number, seconds: number, token: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ctx || !this.master) {
        resolve()
        return
      }
      const g = this.master.gain
      g.cancelScheduledValues(this.ctx.currentTime)
      g.setTargetAtTime(target, this.ctx.currentTime, seconds / 3)
      setTimeout(() => {
        if (this.queueToken === token) resolve()
      }, seconds * 1000)
    })
  }

  /** 队列专用：切场景+配比（不经公开 setLayer/setScene，不触发打断退出） */
  private applySoundProgrammatic(sceneId: string, layers: Record<string, number>): void {
    const scene = sceneById(sceneId)
    if (!scene) return
    if (sceneId !== this.state.sceneId) {
      this.state = { sceneId, layers: { ...scene.defaults }, master: this.state.master }
      for (const def of scene.layers) {
        const v = layers[def.id]
        if (typeof v === 'number') this.state.layers[def.id] = clamp100(v)
      }
      if (this.ctx) {
        this.buildScene()
        if (this.running) this.startSchedulers()
      }
    } else {
      // 同场景换配比：各层增益平滑过渡即可，无需拆建层
      for (const def of scene.layers) {
        const v = clamp100(layers[def.id] ?? 0)
        this.state.layers[def.id] = v
        const inst = this.layers.get(def.id)
        if (inst && this.ctx) inst.gain.gain.setTargetAtTime(this.mapGain(v), this.ctx.currentTime, 0.05)
      }
    }
    this.emit()
  }

  private startQueueTimer(): void {
    this.stopQueueTimer()
    this.queueTimer = setInterval(() => {
      if (!this.running || this.queueTransiting || this.queueActiveId == null) return
      this.queueRemainMs -= 1000
      if (this.queueRemainMs <= 0) this.advanceQueue()
      else this.emit()
    }, 1000)
  }

  private stopQueueTimer(): void {
    if (this.queueTimer != null) {
      clearInterval(this.queueTimer)
      this.queueTimer = null
    }
  }

  /** 当前项时长耗尽：按模式推进（single-loop 不切歌只重置计时） */
  private advanceQueue(): void {
    this.stopQueueTimer()
    const item = this.queueItems.find((it) => it.id === this.queueActiveId)
    if (this.queueMode === 'single-loop') {
      if (!item) {
        this.stopQueue() // 运行行刚被删的兜底（setQueueConfig 已即时推进过）
        return
      }
      this.queueRemainMs = item.minutes * 60_000
      this.startQueueTimer()
      this.emit()
      return
    }
    this.advanceFrom(this.queueActiveId)
  }

  /** 从 currentId 起按模式找下一个有效项并切歌；找不到 → 播完即停 */
  private advanceFrom(currentId: string | null): void {
    const ids = this.queueItems.map((it) => it.id)
    let next: string | null = null
    if (this.queueMode === 'random') {
      next = this.nextShuffleId()
    } else {
      next = nextValidId(this.queueMode === 'sequence' ? 'sequence' : 'list-loop', ids, (id) => this.soundValid(id), currentId)
    }
    if (next == null) void this.finishQueue()
    else void this.playQueueSound(next)
  }

  /** random：当前洗牌序的下一格；序耗尽/当前不在序中 → 重洗（首项避开刚播完的） */
  private nextShuffleId(): string | null {
    const valid = this.queueItems.filter((it) => this.soundValid(it.id)).map((it) => it.id)
    if (valid.length === 0) return null
    this.queueShuffle = this.queueShuffle.filter((id) => valid.includes(id))
    let pos = this.queueShuffle.indexOf(this.queueActiveId ?? '')
    if (pos < 0) pos = this.queueShuffle.length - 1 // 当前不在序中（重洗后首播等）：视为序尾
    if (pos + 1 < this.queueShuffle.length) return this.queueShuffle[pos + 1]
    this.queueShuffle = shuffleIds(valid, this.queueActiveId)
    return this.queueShuffle[0] ?? null
  }

  /** sequence 播完/全失效：淡出 → 自动暂停 → master 归位（下次手动播放恢复正常音量）；队列配置保留 */
  private async finishQueue(): Promise<void> {
    const token = ++this.queueToken
    this.queueActiveId = null
    this.queueRemainMs = 0
    this.queueTransiting = false
    this.stopQueueTimer()
    this.emit()
    await this.fadeMaster(0, 1.2, token)
    if (this.queueToken !== token) return
    this.pause()
    this.restoreMaster()
    this.onNotice?.('队列播完，已自动暂停')
  }

  // —— 场景实例化 ——

  private buildScene(): void {
    const ctx = this.ctx!
    const scene = sceneById(this.state.sceneId) ?? SCENES[0]
    this.teardownScene()
    for (const def of scene.layers) {
      const gain = ctx.createGain()
      gain.gain.value = this.mapGain(this.state.layers[def.id] ?? 0)
      gain.connect(this.master!)
      const inst: LayerInstance = { def, gain }
      if (def.type === 'steady') {
        inst.steady = this.buildSteady(ctx, def, gain)
      }
      this.layers.set(def.id, inst)
    }
  }

  /** 稳态层：独立生成的噪声缓冲（层间去相关，避免同一信号叠加发闷）→ 滤波 → [幅度调制] → 层增益 */
  private buildSteady(ctx: AudioContext, def: SteadyLayerDef, gain: GainNode): SteadyNodes {
    const source = ctx.createBufferSource()
    source.buffer = this.freshBuffer(def.noise)
    source.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = def.filter.kind
    filter.frequency.value = def.filter.freq
    if (def.filter.q != null) filter.Q.value = def.filter.q
    source.connect(filter)
    let tail: AudioNode = filter
    const nodes: SteadyNodes = { source, filter }
    if (def.am) {
      // 幅度抖动：tail → amGain(基准 1，LFO ±depth) → 层增益
      const amGain = ctx.createGain()
      amGain.gain.value = 1
      const amOsc = ctx.createOscillator()
      amOsc.frequency.value = def.am.rateHz
      const amDepth = ctx.createGain()
      amDepth.gain.value = def.am.depth
      amOsc.connect(amDepth)
      amDepth.connect(amGain.gain)
      tail.connect(amGain)
      tail = amGain
      nodes.amOsc = amOsc
      nodes.amDepth = amDepth
    }
    if (def.lfoFilter) {
      // 滤波扫调：LFO → depth → filter.frequency（中心 freq ±depthHz）
      const lfoOsc = ctx.createOscillator()
      lfoOsc.frequency.value = def.lfoFilter.rateHz
      const lfoDepth = ctx.createGain()
      lfoDepth.gain.value = def.lfoFilter.depthHz
      lfoOsc.connect(lfoDepth)
      lfoDepth.connect(filter.frequency)
      nodes.lfoOsc = lfoOsc
      nodes.lfoDepth = lfoDepth
    }
    tail.connect(gain)
    const startOffset = Math.random() * 3 // 循环起点随机，进一步错开层间相位
    source.start(0, startOffset)
    nodes.amOsc?.start()
    nodes.lfoOsc?.start()
    return nodes
  }

  private teardownScene(): void {
    for (const inst of this.layers.values()) {
      if (inst.timer != null) clearTimeout(inst.timer)
      const s = inst.steady
      if (s) {
        try {
          s.source.stop()
        } catch {
          /* 已停 */
        }
        s.amOsc?.stop()
        s.lfoOsc?.stop()
        s.source.disconnect()
        s.filter.disconnect()
        s.amDepth?.disconnect()
        s.lfoDepth?.disconnect()
      }
      inst.gain.disconnect()
    }
    this.layers.clear()
  }

  // —— 事件调度器（雷/水滴/打窗）：随机 gap 的 setTimeout 链，pause 清表、play 重启 ——

  private startSchedulers(): void {
    for (const inst of this.layers.values()) {
      if (inst.def.type === 'event' && inst.timer == null) this.scheduleEvent(inst)
    }
  }

  private stopSchedulers(): void {
    for (const inst of this.layers.values()) {
      if (inst.timer != null) {
        clearTimeout(inst.timer)
        inst.timer = undefined
      }
    }
  }

  private scheduleEvent(inst: LayerInstance): void {
    const def = inst.def as EventLayerDef
    const gapMs = (def.minGapSec + Math.random() * (def.maxGapSec - def.minGapSec)) * 1000
    inst.timer = setTimeout(() => {
      inst.timer = undefined
      if (!this.running || !this.ctx) return
      this.spawnEvent(inst)
      if (this.running) this.scheduleEvent(inst)
    }, gapMs)
  }

  /** 三种事件合成器：一次性节点，音量走该层增益（同一映射） */
  private spawnEvent(inst: LayerInstance): void {
    const ctx = this.ctx!
    const def = inst.def as EventLayerDef
    const t = ctx.currentTime
    if (def.spawn === 'thunder') {
      // 棕噪声 lowpass + 慢起慢落包络
      const src = ctx.createBufferSource()
      src.buffer = this.sharedBuffer('brown')
      src.loop = true
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = 100 + Math.random() * 100
      const g = ctx.createGain()
      const attack = 0.5 + Math.random() * 1.5
      const release = 4 + Math.random() * 6
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(1, t + attack)
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release)
      src.connect(f)
      f.connect(g)
      g.connect(inst.gain)
      src.start(t, Math.random() * 3)
      src.stop(t + attack + release + 0.1)
    } else if (def.spawn === 'drip') {
      // 指数衰减正弦 ping（随机音高）+ 高频噪声瞬态
      const osc = ctx.createOscillator()
      osc.frequency.value = 800 + Math.random() * 1600
      const g = ctx.createGain()
      const dur = 0.05 + Math.random() * 0.1
      g.gain.setValueAtTime(1, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      osc.connect(g)
      g.connect(inst.gain)
      osc.start(t)
      osc.stop(t + dur + 0.02)
      const src = ctx.createBufferSource()
      src.buffer = this.sharedBuffer('white')
      const hf = ctx.createBiquadFilter()
      hf.type = 'highpass'
      hf.frequency.value = 3000
      const tg = ctx.createGain()
      tg.gain.setValueAtTime(0.5, t)
      tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.02)
      src.connect(hf)
      hf.connect(tg)
      tg.connect(inst.gain)
      src.start(t, Math.random() * 3)
      src.stop(t + 0.05)
    } else if (def.spawn === 'chirp') {
      // 鸟鸣/鸥鸣（260911 新场景）：1..chirpsMax 个音节，每音节 = 正弦滑音（起止频率独立随机、方向随机）
      // + 快起缓落包络；音节间 50~110ms 间隔。鸥鸣用 spawnCfg 换低频长下滑。
      const cfg = def.spawnCfg
      const fMin = cfg?.freqMin ?? 2200
      const fMax = cfg?.freqMax ?? 4200
      const dMin = cfg?.durMin ?? 0.07
      const dMax = cfg?.durMax ?? 0.16
      const n = Math.max(1, 1 + Math.floor(Math.random() * (cfg?.chirpsMax ?? 3)))
      let t0 = t
      for (let i = 0; i < n; i++) {
        const f1 = fMin + Math.random() * (fMax - fMin)
        const f2 = fMin + Math.random() * (fMax - fMin)
        const up = f2 >= f1
        const dur = dMin + Math.random() * (dMax - dMin)
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(f1, t0)
        osc.frequency.exponentialRampToValueAtTime(Math.max(80, f2), t0 + dur)
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, t0)
        g.gain.exponentialRampToValueAtTime(0.7, t0 + dur * 0.25)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
        osc.connect(g)
        g.connect(inst.gain)
        osc.start(t0)
        osc.stop(t0 + dur + 0.02)
        t0 += dur + 0.05 + Math.random() * 0.06
        if (t0 - t > 2) break // 参数异常兜底：整串不超过 2s
      }
    } else if (def.spawn === 'wave') {
      // 浪涌（海浪场景）：棕噪 bandpass（中心随机）+ 慢起慢落包络（1.2~3s 涌起、3~6s 退去）
      const cfg = def.spawnCfg
      const fLo = cfg?.freqMin ?? 400
      const fHi = cfg?.freqMax ?? 900
      const src = ctx.createBufferSource()
      src.buffer = this.sharedBuffer('brown')
      src.loop = true
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.frequency.value = fLo + Math.random() * (fHi - fLo)
      f.Q.value = 0.8
      const g = ctx.createGain()
      const attack = 1.2 + Math.random() * 1.8
      const release = 3 + Math.random() * 3
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.9, t + attack)
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release)
      src.connect(f)
      f.connect(g)
      g.connect(inst.gain)
      src.start(t, Math.random() * 3)
      src.stop(t + attack + release + 0.1)
    } else if (def.spawn === 'crackle') {
      // 噼啪爆裂（篝火场景）：高通白噪极短脉冲（5~30ms），约四成概率 20~50ms 后跟第二响
      const src = ctx.createBufferSource()
      src.buffer = this.sharedBuffer('white')
      const f = ctx.createBiquadFilter()
      f.type = 'highpass'
      f.frequency.value = def.spawnCfg?.freqMin ?? 4000
      const g = ctx.createGain()
      const dur = 0.005 + Math.random() * 0.025
      g.gain.setValueAtTime(1, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      src.connect(f)
      f.connect(g)
      g.connect(inst.gain)
      src.start(t, Math.random() * 3)
      src.stop(t + dur + 0.02)
      if (Math.random() < 0.4) {
        const src2 = ctx.createBufferSource()
        src2.buffer = this.sharedBuffer('white')
        const g2 = ctx.createGain()
        const dur2 = 0.005 + Math.random() * 0.02
        const t2 = t + dur + 0.02 + Math.random() * 0.03
        g2.gain.setValueAtTime(0.7, t2)
        g2.gain.exponentialRampToValueAtTime(0.0001, t2 + dur2)
        src2.connect(f)
        f.connect(g2)
        g2.connect(inst.gain)
        src2.start(t2, Math.random() * 3)
        src2.stop(t2 + dur2 + 0.02)
      }
    } else if (def.spawn === 'clink') {
      // 杯盘轻碰（咖啡馆场景）：高频谐振 ping（指数衰减）+ 少量高频噪声瞬态（drip 的金属版）
      const cfg = def.spawnCfg
      const fMin = cfg?.freqMin ?? 2000
      const fMax = cfg?.freqMax ?? 4500
      const dMin = cfg?.durMin ?? 0.1
      const dMax = cfg?.durMax ?? 0.3
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = fMin + Math.random() * (fMax - fMin)
      const g = ctx.createGain()
      const dur = dMin + Math.random() * (dMax - dMin)
      g.gain.setValueAtTime(0.6, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      osc.connect(g)
      g.connect(inst.gain)
      osc.start(t)
      osc.stop(t + dur + 0.02)
      const src = ctx.createBufferSource()
      src.buffer = this.sharedBuffer('white')
      const hf = ctx.createBiquadFilter()
      hf.type = 'highpass'
      hf.frequency.value = 6000
      const tg = ctx.createGain()
      tg.gain.setValueAtTime(0.25, t)
      tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.02)
      src.connect(hf)
      hf.connect(tg)
      tg.connect(inst.gain)
      src.start(t, Math.random() * 3)
      src.stop(t + 0.05)
    } else {
      // tap：bandpass 白噪声短脉冲
      const src = ctx.createBufferSource()
      src.buffer = this.sharedBuffer('white')
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.frequency.value = 500 + Math.random() * 1000
      f.Q.value = 6
      const g = ctx.createGain()
      const dur = 0.02 + Math.random() * 0.06
      g.gain.setValueAtTime(1, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      src.connect(f)
      f.connect(g)
      g.connect(inst.gain)
      src.start(t, Math.random() * 3)
      src.stop(t + dur + 0.02)
    }
  }

  // —— 噪声缓冲 ——

  /** 约 4s 单声道；pink 用 Paul Kellet 近似滤波，brown 用漏积分白噪声 */
  private makeBuffer(color: 'white' | 'pink' | 'brown'): AudioBuffer {
    const ctx = this.ctx!
    const len = Math.floor(ctx.sampleRate * 4)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    if (color === 'white') {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    } else if (color === 'pink') {
      let b0 = 0
      let b1 = 0
      let b2 = 0
      let b3 = 0
      let b4 = 0
      let b5 = 0
      let b6 = 0
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1
        b0 = 0.99886 * b0 + w * 0.0555179
        b1 = 0.99332 * b1 + w * 0.0750759
        b2 = 0.969 * b2 + w * 0.153852
        b3 = 0.8665 * b3 + w * 0.3104856
        b4 = 0.55 * b4 + w * 0.5329522
        b5 = -0.7616 * b5 - w * 0.016898
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
        b6 = w * 0.115926
      }
    } else {
      let last = 0
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1
        last = (last + 0.02 * w) / 1.02
        d[i] = last * 3.5
      }
    }
    return buf
  }

  /** 稳态层专用：每次新生成（层间去相关） */
  private freshBuffer(color: 'white' | 'pink' | 'brown'): AudioBuffer {
    return this.makeBuffer(color)
  }

  /** 事件层共用：同色复用一份 */
  private sharedBuffer(color: 'white' | 'pink' | 'brown'): AudioBuffer {
    let buf = this.sharedBuffers.get(color)
    if (!buf) {
      buf = this.makeBuffer(color)
      this.sharedBuffers.set(color, buf)
    }
    return buf
  }
}

export const noiseEngine = new NoiseEngine()
