// 内置触发音合成器（2026-09-21-触发音与白噪音体验升级-design.md §三）：与 noiseScenes.BUILTIN_TRIGGERS 同 id 一一对应。
// 每个 spawn 一次性建节点 → 连 dest → 自行 stop；参数随机微变防机械感。调用方（noiseEngine）按 2–8s 随机间隔调度。
function noise(ctx: BaseAudioContext, sec: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * sec))
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  return buf
}

export function spawnTrigger(ctx: BaseAudioContext, dest: AudioNode, id: string, t: number): void {
  switch (id) {
    case 'tap_wood': {
      // 指叩木桌：低频带通短脉冲，木腔谐振区随机音高/力度
      const src = ctx.createBufferSource()
      src.buffer = noise(ctx, 0.08)
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.frequency.value = 160 + Math.random() * 180
      f.Q.value = 2.5
      const g = ctx.createGain()
      const dur = 0.04 + Math.random() * 0.06
      g.gain.setValueAtTime(0.9 + Math.random() * 0.1, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      src.connect(f)
      f.connect(g)
      g.connect(dest)
      src.start(t, Math.random() * 0.01)
      src.stop(t + dur + 0.02)
      break
    }
    case 'tap_glass': {
      // 玻璃轻敲：基音 + 非谐泛音（2.76x）指数衰减，金属感
      const f1 = 1800 + Math.random() * 1400
      const dur = 0.15 + Math.random() * 0.25
      const g = ctx.createGain()
      const v = 0.25 + Math.random() * 0.2
      g.gain.setValueAtTime(v, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      for (const mult of [1, 2.76]) {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = f1 * mult
        osc.connect(g)
        osc.start(t)
        osc.stop(t + dur + 0.02)
      }
      g.connect(dest)
      break
    }
    case 'page': {
      // 翻书页：带通噪声 swish，中心频率快扫（纸摩擦）
      const src = ctx.createBufferSource()
      src.buffer = noise(ctx, 0.5)
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.Q.value = 0.8
      f.frequency.setValueAtTime(900 + Math.random() * 500, t)
      f.frequency.exponentialRampToValueAtTime(2200 + Math.random() * 1200, t + 0.12)
      const g = ctx.createGain()
      const dur = 0.14 + Math.random() * 0.14
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.5, t + dur * 0.4)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      src.connect(f)
      f.connect(g)
      g.connect(dest)
      src.start(t, Math.random() * 0.1)
      src.stop(t + dur + 0.02)
      break
    }
    case 'keyboard': {
      // 机械键盘簇：3~6 连 click（带通短脉冲），间隔随机
      const n = 3 + Math.floor(Math.random() * 4)
      let t0 = t
      for (let i = 0; i < n; i++) {
        const src = ctx.createBufferSource()
        src.buffer = noise(ctx, 0.03)
        const f = ctx.createBiquadFilter()
        f.type = 'bandpass'
        f.frequency.value = 1200 + Math.random() * 1800
        f.Q.value = 1.5
        const g = ctx.createGain()
        const dur = 0.015 + Math.random() * 0.02
        g.gain.setValueAtTime(0.7, t0)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
        src.connect(f)
        f.connect(g)
        g.connect(dest)
        src.start(t0)
        src.stop(t0 + dur + 0.01)
        t0 += 0.04 + Math.random() * 0.06
      }
      break
    }
    case 'scissors': {
      // 剪刀开合：两次金属 snip（高频带通短脉冲）
      const snip = (t0: number): void => {
        const src = ctx.createBufferSource()
        src.buffer = noise(ctx, 0.08)
        const f = ctx.createBiquadFilter()
        f.type = 'bandpass'
        f.frequency.value = 3600 + Math.random() * 1800
        f.Q.value = 3
        const g = ctx.createGain()
        const dur = 0.03 + Math.random() * 0.03
        g.gain.setValueAtTime(0.6, t0)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
        src.connect(f)
        f.connect(g)
        g.connect(dest)
        src.start(t0)
        src.stop(t0 + dur + 0.01)
      }
      snip(t)
      snip(t + 0.09 + Math.random() * 0.06)
      break
    }
    case 'bubble': {
      // 泡泡纸：爆破下滑 ping，偶发连爆
      const pops = 1 + (Math.random() < 0.35 ? 1 : 0)
      let t0 = t
      for (let i = 0; i < pops; i++) {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        const f1 = 600 + Math.random() * 500
        osc.frequency.setValueAtTime(f1 * 2.2, t0)
        osc.frequency.exponentialRampToValueAtTime(f1, t0 + 0.02)
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.8, t0)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.03)
        osc.connect(g)
        g.connect(dest)
        osc.start(t0)
        osc.stop(t0 + 0.05)
        t0 += 0.05 + Math.random() * 0.06
      }
      break
    }
    case 'crinkle': {
      // 塑料袋窸窣：6~12 个高频碎脉冲簇，幅度随机
      const n = 6 + Math.floor(Math.random() * 7)
      let t0 = t
      for (let i = 0; i < n; i++) {
        const src = ctx.createBufferSource()
        src.buffer = noise(ctx, 0.04)
        const f = ctx.createBiquadFilter()
        f.type = 'highpass'
        f.frequency.value = 2600 + Math.random() * 2000
        const g = ctx.createGain()
        const dur = 0.008 + Math.random() * 0.02
        g.gain.setValueAtTime(0.25 + Math.random() * 0.4, t0)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
        src.connect(f)
        f.connect(g)
        g.connect(dest)
        src.start(t0)
        src.stop(t0 + dur + 0.01)
        t0 += 0.02 + Math.random() * 0.07
      }
      break
    }
    case 'chime': {
      // 风铃：2~4 音错落（五声邻音集），基音 + 泛音长衰减
      const scale = [1318, 1568, 1976, 2349, 2637]
      const n = 2 + Math.floor(Math.random() * 3)
      let t0 = t
      for (let i = 0; i < n; i++) {
        const f0 = scale[Math.floor(Math.random() * scale.length)]
        const dur = 1.2 + Math.random() * 1.4
        for (const [mult, amp] of [
          [1, 0.35],
          [2.76, 0.12]
        ] as const) {
          const osc = ctx.createOscillator()
          osc.type = 'sine'
          osc.frequency.value = f0 * mult
          const g = ctx.createGain()
          g.gain.setValueAtTime(0.0001, t0)
          g.gain.exponentialRampToValueAtTime(amp, t0 + 0.015)
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
          osc.connect(g)
          g.connect(dest)
          osc.start(t0)
          osc.stop(t0 + dur + 0.05)
        }
        t0 += 0.08 + Math.random() * 0.18
      }
      break
    }
    case 'bowl': {
      // 颂钵：基音 + 非谐泛音列，慢起长衰减嗡鸣（助眠向）
      const f0 = 170 + Math.random() * 90
      const dur = 4.5 + Math.random() * 2.5
      for (const [mult, amp] of [
        [1, 0.5],
        [2.71, 0.18],
        [4.9, 0.06]
      ] as const) {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = f0 * mult
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(amp, t + 0.25 + Math.random() * 0.2)
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
        osc.connect(g)
        g.connect(dest)
        osc.start(t)
        osc.stop(t + dur + 0.1)
      }
      break
    }
    default:
      break
  }
}
