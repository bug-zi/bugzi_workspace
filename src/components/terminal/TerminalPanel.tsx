// 内置终端底部面板（260912 设计 §三/§四）：标签栏 + 多标签（上限 6）+ 可拖拽高度（记忆）+
// 问 AI 按钮（选中输出 → 右栏助手频道）；open=false 仅 display:none，进程不死
import '@xterm/xterm/css/xterm.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import TerminalTab, { type TerminalTabData } from './TerminalTab'
import ConfirmDialog from '../ConfirmDialog'
import { useToast } from '../Toast'
import { SettingsKeys, TERMINAL_DEFAULTS, parseTerminalSettings } from '../../shared/types'
import type { TerminalShell, TerminalSettings } from '../../shared/types'

const MAX_TABS = 6
const MIN_HEIGHT = 200
const HEIGHT_RATIO_MAX = 0.6
const ASK_AI_MAX_CHARS = 8000

const SHELL_LABEL: Record<TerminalShell, string> = {
  powershell: 'PowerShell',
  pwsh: 'pwsh',
  cmd: 'cmd'
}

/** 选中文本 → AI 预填引用块（设计 §五：不自动发送，超长截断） */
export function buildAskAiPrefill(selection: string): string {
  const text =
    selection.length > ASK_AI_MAX_CHARS
      ? selection.slice(0, ASK_AI_MAX_CHARS) + '\n…（已截断）'
      : selection
  return `我在 App 内置终端选中了以下内容，请帮我解释或排查：\n\n\`\`\`\n${text}\n\`\`\``
}

interface Props {
  open: boolean
  theme: 'light' | 'dark'
  fontSize: number
  /** App 层 Ctrl+Shift+J 信号：值变更即新建标签 */
  newTabSignal: number
  onClose: () => void
  /** 预填文本送右栏助手频道（App 层 openAiWith 钉 channel: 'assistant'） */
  onAskAi: (prefill: string) => void
}

let tabSeq = 0

export default function TerminalPanel(props: Props) {
  const { open, theme, fontSize, newTabSignal, onClose, onAskAi } = props
  const [tabs, setTabs] = useState<TerminalTabData[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [height, setHeight] = useState(TERMINAL_DEFAULTS.height)
  const [closeAsk, setCloseAsk] = useState<TerminalTabData | null>(null)
  const termsRef = useRef(new Map<string, Terminal>())
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const { toast } = useToast()

  // 启动读高度记忆
  useEffect(() => {
    void window.api.settings.get(SettingsKeys.Terminal).then((raw) => {
      setHeight(parseTerminalSettings(raw).height)
    })
  }, [])

  const readCfg = useCallback(async (): Promise<TerminalSettings> => {
    const raw = await window.api.settings.get(SettingsKeys.Terminal)
    return parseTerminalSettings(raw)
  }, [])

  const createTab = useCallback(
    async (currentCount: number): Promise<void> => {
      if (currentCount >= MAX_TABS) {
        toast(`最多 ${MAX_TABS} 个终端标签`)
        return
      }
      const cfg = await readCfg()
      tabSeq += 1
      const sameShell = tabs.filter((t) => t.shell === cfg.shell).length
      const tab: TerminalTabData = {
        id: `t${Date.now()}_${tabSeq}`,
        label: `${SHELL_LABEL[cfg.shell]} ${sameShell + 1}`,
        shell: cfg.shell,
        cwd: cfg.cwd,
        exited: null,
        spawnEpoch: 0
      }
      setTabs((prev) => [...prev, tab])
      setActiveId(tab.id)
    },
    [tabs, readCfg, toast]
  )

  // Ctrl+Shift+J 信号 → 新建（面板展开由 App 层负责）
  useEffect(() => {
    if (newTabSignal > 0) void createTab(tabs.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newTabSignal])

  const patchTab = useCallback((id: string, patch: Partial<TerminalTabData>): void => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  const onExitedCb = useCallback(
    (id: string, code: number): void => {
      patchTab(id, { exited: code })
    },
    [patchTab]
  )

  const restartTab = useCallback((id: string): void => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exited: null, spawnEpoch: t.spawnEpoch + 1 } : t))
    )
  }, [])

  // 重新打开事件（TerminalTab 上抛）
  useEffect(() => {
    const onRestart = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail
      restartTab(id)
    }
    window.addEventListener('bugzi:terminal-restart', onRestart)
    return () => window.removeEventListener('bugzi:terminal-restart', onRestart)
  }, [restartTab])

  const closeTab = useCallback(
    (tab: TerminalTabData, force: boolean): void => {
      const doClose = (): void => {
        void window.api.terminal.kill(tab.id)
        setTabs((prev) => {
          const next = prev.filter((t) => t.id !== tab.id)
          if (next.length === 0) onClose()
          else if (activeId === tab.id) setActiveId(next[next.length - 1].id)
          return next
        })
      }
      // 进程在跑：二次确认（全局删除纪律）；已退出直接关
      if (tab.exited === null && !force) setCloseAsk(tab)
      else doClose()
    },
    [activeId, onClose]
  )

  // 拖拽高度：mouseup 持久化
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      const max = Math.floor(window.innerHeight * HEIGHT_RATIO_MAX)
      setHeight(Math.min(max, Math.max(MIN_HEIGHT, d.startH + (d.startY - e.clientY))))
    }
    const onUp = (): void => {
      if (!dragRef.current) return
      dragRef.current = null
      document.body.style.cursor = ''
      void window.api.settings.get(SettingsKeys.Terminal).then((raw) => {
        const cfg = parseTerminalSettings(raw)
        setHeight((h) => {
          void window.api.settings.set(
            SettingsKeys.Terminal,
            JSON.stringify({ ...cfg, height: h })
          )
          return h
        })
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const askAiFromButton = (): void => {
    const term = activeId ? termsRef.current.get(activeId) : null
    const sel = term?.getSelection()
    if (!sel) {
      toast('请先在终端中选中要问的内容')
      return
    }
    onAskAi(buildAskAiPrefill(sel))
  }

  const registerTerm = useCallback((id: string, term: Terminal | null): void => {
    if (term) termsRef.current.set(id, term)
    else termsRef.current.delete(id)
  }, [])

  const activeTab = tabs.find((t) => t.id === activeId) ?? null
  // 问 AI 点亮态粗化为「面板开 + 有激活标签」（selection 变化不触发渲染，点击时再校验引导）
  const askAiLit = open && activeTab !== null

  return (
    <div
      className="terminal-panel"
      style={{ height: open ? height : 0, display: open ? 'flex' : 'none' }}
    >
      <div className="terminal-tabs-bar">
        <div className="terminal-tabs">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`terminal-tab${t.id === activeId ? ' active' : ''}${t.exited !== null ? ' exited' : ''}`}
              onMouseDown={() => setActiveId(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(t, false)
              }}
              title={t.cwd}
            >
              <span className="terminal-tab-label">{t.label}</span>
              <button
                className="terminal-tab-close"
                title="关闭标签"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t, false)
                }}
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-actions">
          <button
            className={`terminal-action-btn${askAiLit ? ' lit' : ''}`}
            onClick={askAiFromButton}
            title="选中输出发给 AI（选中后点此或右键→问 AI）"
          >
            <span className="material-symbols-outlined">forum</span>
          </button>
          <button
            className="terminal-action-btn"
            onClick={() => void createTab(tabs.length)}
            title="新建终端标签 (Ctrl+Shift+J)"
          >
            <span className="material-symbols-outlined">add</span>
          </button>
          <button className="terminal-action-btn" onClick={onClose} title="收起 (Ctrl+J)">
            <span className="material-symbols-outlined">keyboard_arrow_down</span>
          </button>
        </div>
      </div>
      <div className="terminal-tab-area">
        {tabs.map((t) => (
          <TerminalTab
            key={`${t.id}_${t.spawnEpoch}`}
            tab={t}
            active={t.id === activeId && t.exited === null}
            theme={theme}
            fontSize={fontSize}
            registerTerm={registerTerm}
            onExited={onExitedCb}
            onAskAi={(sel) => onAskAi(buildAskAiPrefill(sel))}
          />
        ))}
        {tabs.length === 0 && (
          <div className="terminal-empty">按 Ctrl+Shift+J 或点 + 新建终端</div>
        )}
      </div>
      <div
        className="terminal-resize-handle"
        onMouseDown={(e) => {
          dragRef.current = { startY: e.clientY, startH: height }
          document.body.style.cursor = 'ns-resize'
        }}
        title="拖拽调整高度"
      />

      <ConfirmDialog
        open={closeAsk !== null}
        title="关闭终端标签"
        confirmText="关闭"
        danger
        onConfirm={() => {
          if (closeAsk) closeTab(closeAsk, true)
          setCloseAsk(null)
        }}
        onCancel={() => setCloseAsk(null)}
      >
        「{closeAsk?.label}」中仍有进程在运行（可能包括 Claude Code 会话），关闭将结束它们。
      </ConfirmDialog>
    </div>
  )
}
