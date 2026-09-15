// 音源互斥协调（音乐吧设计 §二/§五）：两引擎各注册自己的 stop；任一方开播前 stopOthers 互停。
// lastActive 记最近开播的音源——快捷控件「都暂停时控上次音源」口径，进程内从未播过默认白噪音。
export type AudioKind = 'noise' | 'music'

const stoppers = new Map<AudioKind, () => void>()
let lastActive: AudioKind = 'noise'

export function registerAudioStopper(kind: AudioKind, stop: () => void): void {
  stoppers.set(kind, stop)
}

export function stopOthers(kind: AudioKind): void {
  for (const [k, stop] of stoppers) {
    if (k !== kind) stop()
  }
}

export function markAudioActive(kind: AudioKind): void {
  lastActive = kind
}

export function activeAudioKind(): AudioKind {
  return lastActive
}
