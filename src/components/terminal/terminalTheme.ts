// 终端双主题色板（260912 设计 §四）：浅色粉调底深字、深色深蓝底浅字，ANSI 16 色各调一版；
// 深色优先保证 claude TUI 长时间使用可读
import type { ITheme } from '@xterm/xterm'

const LIGHT: ITheme = {
  background: '#fff6f8',
  foreground: '#3d2b31',
  cursor: '#d16a86',
  cursorAccent: '#fff6f8',
  selectionBackground: '#f3c9d4',
  black: '#4a3a3f',
  red: '#c2434a',
  green: '#2e7d4f',
  yellow: '#a06a1f',
  blue: '#3b5fc0',
  magenta: '#a84a8c',
  cyan: '#22767f',
  white: '#e8dcdfe2',
  brightBlack: '#8a757c',
  brightRed: '#e05a61',
  brightGreen: '#43996a',
  brightYellow: '#c08a3e',
  brightBlue: '#5a7cd8',
  brightMagenta: '#c466ab',
  brightCyan: '#3d949e',
  brightWhite: '#ffffff'
}

const DARK: ITheme = {
  background: '#0d1830',
  foreground: '#e6ecfa',
  cursor: '#7ea6ff',
  cursorAccent: '#0d1830',
  selectionBackground: '#2b4a7a',
  black: '#25314d',
  red: '#ff6b70',
  green: '#5fd08a',
  yellow: '#e8c46b',
  blue: '#7ea6ff',
  magenta: '#d98fd4',
  cyan: '#6cc7d4',
  white: '#dde5f2',
  brightBlack: '#5d6d8e',
  brightRed: '#ff9094',
  brightGreen: '#83e0a6',
  brightYellow: '#f2d68d',
  brightBlue: '#a3c0ff',
  brightMagenta: '#e8ade4',
  brightCyan: '#93dbe6',
  brightWhite: '#ffffff'
}

export function terminalTheme(theme: 'light' | 'dark'): ITheme {
  return theme === 'dark' ? DARK : LIGHT
}
