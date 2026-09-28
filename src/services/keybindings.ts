// 应用内快捷键注册表（260929 新功能开发区）：动作元信息 + 默认组合 + settings 覆盖存取 +
// KeyboardEvent 匹配与录入捕获标志。个人档「快捷键」栏重设后派发 bugzi:keybindings-changed，
// App Shell 与各处 useShortcutLabel 监听重载，零轮询。
import { useEffect, useState } from 'react'
import { SettingsKeys } from '../shared/types'

export type ShortcutActionId =
  | 'terminal.toggle'
  | 'terminal.newTab'
  | 'logs.toggle'
  | 'theme.toggle'
  | 'mode.toggle'
  | 'audio.toggle'

export interface ShortcutActionMeta {
  id: ShortcutActionId
  label: string
  /** 焦点在终端面板内仍触发（面板级控制，同 VS Code commandsToSkipShell 口径）；其余交还 shell */
  firesInTerminal: boolean
}

export const SHORTCUT_ACTIONS: ShortcutActionMeta[] = [
  { id: 'terminal.toggle', label: '打开 / 关闭终端', firesInTerminal: true },
  { id: 'terminal.newTab', label: '新建终端标签', firesInTerminal: true },
  { id: 'logs.toggle', label: '打开 / 关闭日志库', firesInTerminal: false },
  { id: 'theme.toggle', label: '切换深色 / 浅色模式', firesInTerminal: false },
  { id: 'mode.toggle', label: '切换学习 / 生活模式', firesInTerminal: false },
  { id: 'audio.toggle', label: '播放 / 暂停音乐', firesInTerminal: false }
]

export const DEFAULT_BINDINGS: Record<ShortcutActionId, string> = {
  'terminal.toggle': 'Ctrl+J',
  'terminal.newTab': 'Ctrl+Shift+J',
  // 日志库默认 Ctrl+E（260929 开发者定档：Ctrl+A 让位给模式切换；存量覆盖项与之相同无感）
  'logs.toggle': 'Ctrl+E',
  'theme.toggle': 'Ctrl+Space',
  'mode.toggle': 'Ctrl+A',
  'audio.toggle': 'Ctrl+Q'
}

export type BindingOverrides = Partial<Record<ShortcutActionId, string>>

export const KEYBINDINGS_CHANGED_EVENT = 'bugzi:keybindings-changed'

// —— 录入捕获标志：录入期间全局分发器静默（capture 阶段监听之外的保险） ——

let capturing = false

export function setCapturing(v: boolean): void {
  capturing = v
}

export function isCapturing(): boolean {
  return capturing
}

// —— 加速器解析 / 匹配 ——

/** 规范键名：字母大写、空格→Space、其余取 e.key；修饰键本身与不可作快捷键的键返回 null（继续等待） */
function normalizeKey(e: KeyboardEvent): string | null {
  const k = e.key
  if (k === ' ' || k === 'Spacebar') return 'Space'
  if (/^[a-z]$/i.test(k)) return k.toUpperCase()
  if (/^[0-9]$/.test(k)) return k
  if (/^F([1-9]|1[0-2])$/.test(k)) return k
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(k)) {
    return k.replace('Arrow', '')
  }
  // 可显示的单字符标点（Ctrl+按下时 e.key 仍为原字符），排除 Dead/Process 等 IME 中间态
  if (k.length === 1 && k.charCodeAt(0) > 0x20) return k
  return null
}

/** KeyboardEvent → 规范组合串（Ctrl > Shift > Alt > 键名）；须含 Ctrl/Alt/Meta 修饰，不足或纯修饰键返回 null */
export function acceleratorFromEvent(e: KeyboardEvent): string | null {
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null
  const key = normalizeKey(e)
  if (!key) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  parts.push(key)
  return parts.join('+')
}

export function eventMatchesShortcut(e: KeyboardEvent, acc: string): boolean {
  const parts = acc.split('+')
  if (e.ctrlKey !== parts.includes('Ctrl')) return false
  if (e.shiftKey !== parts.includes('Shift')) return false
  if (e.altKey !== parts.includes('Alt')) return false
  if (e.metaKey) return false
  return normalizeKey(e) === parts[parts.length - 1]
}

// —— 目标判定（抑制规则见 design §三） ——

export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

export function isTerminalTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!(el && el.closest && el.closest('.terminal-panel'))
}

// —— 存取 ——

export function resolveBindings(overrides: BindingOverrides): Record<ShortcutActionId, string> {
  const out = { ...DEFAULT_BINDINGS }
  for (const m of SHORTCUT_ACTIONS) {
    const v = overrides[m.id]
    if (typeof v === 'string' && v) out[m.id] = v
  }
  return out
}

export async function loadOverrides(): Promise<BindingOverrides> {
  const raw = await window.api.settings.get(SettingsKeys.Keybindings)
  if (!raw) return {}
  try {
    const obj = JSON.parse(raw) as BindingOverrides
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

export async function saveBindings(overrides: BindingOverrides): Promise<void> {
  await window.api.settings.set(SettingsKeys.Keybindings, JSON.stringify(overrides))
  window.dispatchEvent(new CustomEvent(KEYBINDINGS_CHANGED_EVENT))
}

/** 展示文案：Ctrl+Shift+J → Ctrl + Shift + J */
export function formatAccelerator(acc: string): string {
  return acc.split('+').join(' + ')
}

/** 单条快捷键当前组合（订阅重设事件；按钮 title、空态提示等处动态显示） */
export function useShortcutLabel(id: ShortcutActionId): string {
  const [acc, setAcc] = useState(DEFAULT_BINDINGS[id])
  useEffect(() => {
    let alive = true
    const reload = (): void => {
      void loadOverrides().then((ov) => {
        if (alive) setAcc(resolveBindings(ov)[id])
      })
    }
    reload()
    window.addEventListener(KEYBINDINGS_CHANGED_EVENT, reload)
    return () => {
      alive = false
      window.removeEventListener(KEYBINDINGS_CHANGED_EVENT, reload)
    }
  }, [id])
  return acc
}
