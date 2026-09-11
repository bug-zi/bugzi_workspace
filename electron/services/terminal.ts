// 内置终端服务（260912 新功能开发区）：node-pty 按 id 管理真实 shell 进程；
// data 合帧推送防刷屏洪峰；App 退出 killAll 兜底不留僵尸 shell
import { BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as nodePty from 'node-pty'
import type { IPty } from 'node-pty'

export type TerminalShellKind = 'powershell' | 'pwsh' | 'cmd'

export interface TerminalCreateOpts {
  id: string
  cwd: string
  shell: TerminalShellKind
}

export interface TerminalCreateResult {
  ok: boolean
  error?: string
}

const terms = new Map<string, IPty>()
// 合帧缓冲：每终端待发 chunk 列表 + 定时器（毫秒级窗口批量发，防 dev server 刷屏时 IPC 洪峰）
const buffers = new Map<string, string[]>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function win(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

function shellFile(shell: TerminalShellKind): string {
  if (shell === 'pwsh') return 'pwsh.exe'
  if (shell === 'cmd') return 'cmd.exe'
  return 'powershell.exe'
}

function shellArgs(shell: TerminalShellKind): string[] {
  return shell === 'cmd' ? [] : ['-NoLogo']
}

function flush(id: string): void {
  const chunks = buffers.get(id)
  if (!chunks || chunks.length === 0) return
  buffers.set(id, [])
  win()?.webContents.send('terminal:data', { id, data: chunks.join('') })
}

function cleanup(id: string): void {
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
  buffers.delete(id)
  terms.delete(id)
}

export function createTerminal(opts: TerminalCreateOpts): TerminalCreateResult {
  if (terms.has(opts.id)) return { ok: true } // 幂等：同 id 已在跑
  try {
    // cwd 失效（被删/改名）回落用户主目录，不让新建标签直接失败
    const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir()
    const p = nodePty.spawn(shellFile(opts.shell), shellArgs(opts.shell), {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env as Record<string, string>
    })
    terms.set(opts.id, p)
    buffers.set(opts.id, [])
    p.onData((data) => {
      const arr = buffers.get(opts.id)
      if (!arr) return
      arr.push(data)
      if (!timers.has(opts.id)) {
        timers.set(
          opts.id,
          setTimeout(() => {
            timers.delete(opts.id)
            flush(opts.id)
          }, 10)
        )
      }
    })
    p.onExit(({ exitCode }) => {
      flush(opts.id)
      cleanup(opts.id)
      win()?.webContents.send('terminal:exit', { id: opts.id, exitCode })
    })
    return { ok: true }
  } catch (e) {
    cleanup(opts.id)
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function writeTerminal(id: string, data: string): void {
  terms.get(id)?.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  try {
    terms.get(id)?.resize(cols, rows)
  } catch {
    /* 进程已在退出边缘时 resize 可能抛错，忽略 */
  }
}

export function killTerminal(id: string): void {
  const p = terms.get(id)
  if (!p) return
  cleanup(id) // 先摘 Map，onExit 再触发也不重复推事件对不上账
  try {
    p.kill()
  } catch {
    /* 已退出时 kill 抛错，忽略 */
  }
}

export function killAllTerminals(): void {
  for (const id of [...terms.keys()]) killTerminal(id)
}
