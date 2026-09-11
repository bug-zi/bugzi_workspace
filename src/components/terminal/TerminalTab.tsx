// 终端单标签（260912）：一个 xterm 实例 ↔ 一条 pty；常驻挂载，非活动仅 display:none；
// WebGL 渲染（context loss 自动降级 DOM renderer）+ 自定义右键菜单 + Ctrl+Shift+C/V
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { terminalTheme } from './terminalTheme'
import { useToast } from '../Toast'
import type { TerminalShell } from '../../shared/types'

export interface TerminalTabData {
  id: string
  label: string
  shell: TerminalShell
  cwd: string
  /** null=进程在跑；数字=已退出（code N）。重开 = spawnEpoch++ 后置回 null */
  exited: number | null
  /** 重开计数：变更后整只 xterm 销毁重建（旧进程已死不复用） */
  spawnEpoch: number
}

interface TerminalCtxMenu {
  x: number
  y: number
}

interface Props {
  tab: TerminalTabData
  active: boolean
  theme: 'light' | 'dark'
  fontSize: number
  /** 注册/注销 xterm 实例到面板（问 AI 按钮按 id 取 selection 用） */
  registerTerm: (id: string, term: Terminal | null) => void
  onExited: (id: string, code: number) => void
  /** 原样传选中文本，预填包装由面板统一做 */
  onAskAi: (selection: string) => void
}

export default function TerminalTab(props: Props) {
  const { tab, active, theme, fontSize, registerTerm, onExited, onAskAi } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // 最近一次已同步给 pty 的尺寸（不变则跳过，防多余 ConPTY 重绘）
  const sentSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const [menu, setMenu] = useState<TerminalCtxMenu | null>(null)
  const { toast } = useToast()

  // 挂载/重开：建 xterm ↔ 接 pty（dispose 走 cleanup）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize,
      scrollback: 5000,
      cursorBlink: true,
      theme: terminalTheme(theme),
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose()) // 老显卡降级 DOM renderer
      term.loadAddon(webgl)
    } catch {
      /* WebGL 不可用则保持 DOM renderer */
    }
    termRef.current = term
    fitRef.current = fit
    sentSizeRef.current = null
    registerTerm(tab.id, term)

    const tryFit = (): void => {
      // 容器无真实尺寸（面板收起 display:none）时绝不 fit——FitAddon 此时不抛错而是把
      // 终端缩到最小 2x2 并同步给 pty，ConPTY 控制台被压缩再还原后光标失同步，
      // 表现为重开面板后输入回显向下偏移（260912 冒烟 bug）
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      try {
        fit.fit()
        const dims = { cols: term.cols, rows: term.rows }
        if (
          sentSizeRef.current?.cols !== dims.cols ||
          sentSizeRef.current?.rows !== dims.rows
        ) {
          sentSizeRef.current = dims
          void window.api.terminal.resize(tab.id, dims.cols, dims.rows)
        }
      } catch {
        /* 尺寸异常时 fit 可能抛错，忽略 */
      }
    }
    tryFit()

    term.onData((data) => void window.api.terminal.write(tab.id, data))
    // xterm 内快捷键：Ctrl+Shift+C 复制选中 / Ctrl+Shift+V 粘贴
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        const sel = term.getSelection()
        if (sel) void navigator.clipboard.writeText(sel)
        return false
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        void navigator.clipboard.readText().then((t) => {
          if (t) void window.api.terminal.write(tab.id, t)
        })
        return false
      }
      return true
    })

    const offData = window.api.terminal.onData(({ id, data }) => {
      if (id === tab.id) term.write(data)
    })
    const offExit = window.api.terminal.onExit(({ id, exitCode }) => {
      if (id === tab.id) onExited(id, exitCode)
    })

    const ro = new ResizeObserver(tryFit)
    ro.observe(container)

    // 建 pty：pwsh 未装等失败回落 powershell（同一 id，此时 pty 不存在无残留）
    void (async () => {
      let r = await window.api.terminal.create(tab.id, { cwd: tab.cwd, shell: tab.shell })
      if (!r.ok && tab.shell !== 'powershell') {
        toast(`${tab.shell} 启动失败，已回落 PowerShell`)
        r = await window.api.terminal.create(tab.id, { cwd: tab.cwd, shell: 'powershell' })
      }
      if (!r.ok) toast(`终端启动失败：${r.error ?? '未知错误'}`)
    })()

    return () => {
      ro.disconnect()
      offData()
      offExit()
      registerTerm(tab.id, null)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.spawnEpoch])

  // 主题即时切换
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(theme)
  }, [theme])

  // 激活态：聚焦 + 补一次 fit（从隐藏态回来尺寸才正确）
  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* 同上忽略 */
      }
      termRef.current?.focus()
    })
  }, [active])

  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const menuAct = (fn: () => void): void => {
    setMenu(null)
    fn()
  }

  return (
    <div
      className={`terminal-tab-body${active ? '' : ' terminal-tab-hidden'}`}
      aria-hidden={!active}
    >
      {tab.exited !== null && (
        <div className="terminal-exited-bar">
          <span>进程已退出（code {tab.exited}）</span>
          <div className="terminal-exited-actions">
            <button
              className="btn"
              onClick={() =>
                window.dispatchEvent(new CustomEvent('bugzi:terminal-restart', { detail: tab.id }))
              }
            >
              <span className="material-symbols-outlined">refresh</span>
              重新打开
            </button>
          </div>
        </div>
      )}
      <div ref={containerRef} className="terminal-xterm-host" onContextMenu={openMenu} />
      {menu && (
        <>
          <div className="terminal-ctx-backdrop" onMouseDown={() => setMenu(null)} />
          <div className="terminal-ctx-menu" style={{ left: menu.x, top: menu.y }}>
            <button
              disabled={!termRef.current?.hasSelection()}
              onClick={() =>
                menuAct(() => {
                  const sel = termRef.current?.getSelection()
                  if (sel) void navigator.clipboard.writeText(sel)
                })
              }
            >
              复制
            </button>
            <button
              onClick={() =>
                menuAct(() => {
                  void navigator.clipboard.readText().then((t) => {
                    if (t && termRef.current) {
                      void window.api.terminal.write(tab.id, t)
                      termRef.current.focus()
                    }
                  })
                })
              }
            >
              粘贴
            </button>
            <button onClick={() => menuAct(() => termRef.current?.selectAll())}>全选</button>
            <button onClick={() => menuAct(() => termRef.current?.clear())}>清屏</button>
            <button
              disabled={!termRef.current?.hasSelection()}
              onClick={() =>
                menuAct(() => {
                  const sel = termRef.current?.getSelection()
                  if (sel) onAskAi(sel)
                })
              }
            >
              问 AI
            </button>
          </div>
        </>
      )}
    </div>
  )
}
