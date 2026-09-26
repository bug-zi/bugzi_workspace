// 日志库侧边栏（新功能开发区 260927）：右栏第五面板，主进程运行日志显性查看。
// 混合跟随模式：默认实时滚底（列表旧→新自上而下，同终端），上翻离底 >80px 或搜索/筛选
// 自动切手动态（底部浮「回到底部」，带未读 +N），点按恢复跟随；游标向上翻页加载更早。
// 纯只读零 AI 不入回收站；清空走全局二次确认。
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import ActionMenu, { type ActionMenuItem } from './ActionMenu'
import ConfirmDialog from './ConfirmDialog'
import { SettingsKeys, type AppLogRow, type LogScope } from '../shared/types'
import './LogSidebar.css'

export interface LogSidebarProps {
  onCollapse: () => void
}

/** 面板宽度拖拽范围（px；默认值同 global.css --logs-width），口径同资源管理器 280–560 */
const LOGS_WIDTH_MIN = 280
const LOGS_WIDTH_MAX = 560
const LOGS_WIDTH_DEFAULT = 320
/** 离底超过该距离（px）判定离开跟随 */
const FOLLOW_THRESHOLD = 80
/** 触顶预加载更早的阈值（px） */
const LOAD_OLDER_AT = 40
/** 单页条数（同设计 §IPC 默认） */
const PAGE = 200

const clampLogsWidth = (w: number): number =>
  Math.min(LOGS_WIDTH_MAX, Math.max(LOGS_WIDTH_MIN, Math.round(w)))

function applyLogsWidth(w: number): void {
  document.documentElement.style.setProperty('--logs-width', `${w}px`)
}

/** scope 中文名（筛选顺序即此） */
const SCOPES: { id: LogScope; label: string }[] = [
  { id: 'system', label: '系统' },
  { id: 'agent', label: '超级工作台' },
  { id: 'scheduler', label: '定时任务' },
  { id: 'stock', label: '补库泵' },
  { id: 'llm', label: 'LLM 调用' },
  { id: 'podcast', label: '播客台' },
  { id: 'library', label: '图书馆' },
  { id: 'whoami', label: '我是谁' }
]
const scopeLabel = (s: LogScope): string => SCOPES.find((x) => x.id === s)?.label ?? s

/** 行时间：同日 HH:MM:SS，跨日 MM-DD HH:MM:SS（解析失败原样回显） */
function fmtTs(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const pad = (n: number): string => String(n).padStart(2, '0')
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay ? hms : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`
}

export default function LogSidebar(props: LogSidebarProps) {
  const { onCollapse } = props
  const [rows, setRows] = useState<AppLogRow[]>([]) // 旧→新（渲染自上而下，同终端）
  const [following, setFollowing] = useState(true)
  const [newCount, setNewCount] = useState(0) // 手动态期间到底的新增
  const [hasMore, setHasMore] = useState(false)
  const [keywordInput, setKeywordInput] = useState('')
  const [filter, setFilter] = useState<LogScope | 'all'>('all')
  const [counts, setCounts] = useState<Record<LogScope, number> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [logsWidth, setLogsWidth] = useState(LOGS_WIDTH_DEFAULT)

  const listRef = useRef<HTMLDivElement>(null)
  const filterBtnRef = useRef<HTMLButtonElement>(null)
  // 回调里读最新值的 ref 组（同 AiSidebar 口径）
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const followingRef = useRef(following)
  followingRef.current = following
  const filterRef = useRef(filter)
  filterRef.current = filter
  const keywordRef = useRef('')
  const loadingOlderRef = useRef(false)

  /** 当前查询条件（filter + keyword） */
  const queryOf = (): { scope?: LogScope; keyword?: string } => ({
    scope: filterRef.current === 'all' ? undefined : filterRef.current,
    keyword: keywordRef.current || undefined
  })

  /** 拉首页（新→旧取回后翻转为旧→新）；跟随态滚底 */
  const fetchFirst = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const list = await window.api.logs.list({ ...queryOf(), limit: PAGE })
      setRows(list.slice().reverse())
      setHasMore(list.length >= PAGE)
      requestAnimationFrame(() => {
        const el = listRef.current
        if (el && followingRef.current) el.scrollTop = el.scrollHeight
      })
    } catch {
      setError('日志读取失败')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 触顶加载更早（游标 = 当前最旧 id）；保持视口停在同一行 */
  const loadOlder = useCallback(
    async (more: boolean): Promise<void> => {
      const oldest = rowsRef.current[0]
      if (!oldest || loadingOlderRef.current || !more) return
      loadingOlderRef.current = true
      try {
        const older = await window.api.logs.list({ ...queryOf(), beforeId: oldest.id, limit: PAGE })
        if (older.length) {
          const el = listRef.current
          const prevH = el?.scrollHeight ?? 0
          setRows((prev) => [...older.slice().reverse(), ...prev])
          requestAnimationFrame(() => {
            if (el) el.scrollTop = el.scrollHeight - prevH
          })
        }
        setHasMore(older.length >= PAGE)
      } catch {
        /* 加载更早失败静默，下次触顶重试 */
      } finally {
        loadingOlderRef.current = false
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const refreshCounts = useCallback(async (): Promise<void> => {
    try {
      setCounts(await window.api.logs.scopes())
    } catch {
      /* 计数失败静默（下拉显示 0） */
    }
  }, [])

  // 初始化：宽度恢复 + 首页 + 计数 + 订阅推送（卸载即退订）
  useEffect(() => {
    void (async () => {
      const savedW = await window.api.settings.get(SettingsKeys.LogsWidth)
      const w = savedW ? Number(savedW) : NaN
      if (Number.isFinite(w) && w >= LOGS_WIDTH_MIN && w <= LOGS_WIDTH_MAX) {
        setLogsWidth(w)
        applyLogsWidth(w)
      }
      await fetchFirst()
      void refreshCounts()
    })()
    const off = window.api.logs.onAppended((appended) => {
      if (!appended.length) return
      setRows((prev) => [...prev, ...appended]) // appended 为时间序（旧→新）
      if (followingRef.current) {
        requestAnimationFrame(() => {
          const el = listRef.current
          if (el) el.scrollTop = el.scrollHeight
        })
      } else {
        setNewCount((n) => n + appended.length)
      }
      void refreshCounts()
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 滚动：离底 >80px 切手动态；触顶预加载更早 */
  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distFromBottom > FOLLOW_THRESHOLD && followingRef.current) setFollowing(false)
    void loadOlder(hasMore)
  }

  /** 回到底部：恢复跟随（新计数清零） */
  const backToBottom = (): void => {
    setNewCount(0)
    setFollowing(true)
    requestAnimationFrame(() => {
      const el = listRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  /** 搜索防抖 300ms：变更即切手动态重查首页 */
  useEffect(() => {
    const t = setTimeout(() => {
      if (keywordRef.current === keywordInput.trim()) return
      keywordRef.current = keywordInput.trim()
      setFollowing(false)
      setNewCount(0)
      void fetchFirst()
    }, 300)
    return () => clearTimeout(t)
  }, [keywordInput, fetchFirst])

  /** 切筛选：重查首页（手动态） */
  const pickFilter = (f: LogScope | 'all'): void => {
    setMenuOpen(false)
    if (f === filterRef.current) return
    setFilter(f)
    filterRef.current = f
    setFollowing(false)
    setNewCount(0)
    void fetchFirst()
  }

  /** 清空（二次确认后） */
  const doClear = async (): Promise<void> => {
    setConfirmClear(false)
    try {
      await window.api.logs.clear()
    } catch {
      /* 清空失败静默，列表按现状保留 */
    }
    await fetchFirst()
    void refreshCounts()
  }

  /** 拖拽左缘调宽（口径同资源管理器：移动实时生效、松手持久化） */
  const startResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = logsWidth
    const onMove = (ev: MouseEvent): void => {
      const w = clampLogsWidth(startWidth - (ev.clientX - startX))
      setLogsWidth(w)
      applyLogsWidth(w)
    }
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      void window.api.settings.set(
        SettingsKeys.LogsWidth,
        String(clampLogsWidth(startWidth - (ev.clientX - startX)))
      )
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
  }

  /** 筛选下拉项：全部 + 8 scope 各带计数，当前打勾 */
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0
  const menuItems: ActionMenuItem[] = [
    {
      key: 'all',
      icon: filter === 'all' ? 'check' : undefined,
      label: `全部来源（${total}）`,
      onClick: () => pickFilter('all')
    },
    ...SCOPES.map((s) => ({
      key: s.id,
      icon: filter === s.id ? 'check' : undefined,
      label: `${s.label}（${counts?.[s.id] ?? 0}）`,
      onClick: () => pickFilter(s.id)
    }))
  ]

  return (
    <aside className="log-sidebar" style={{ width: 'var(--logs-width)' }}>
      <div className="logx-resizer" onMouseDown={startResize} title="拖拽调整宽度" />
      <div className="logx-header">
        <span className="material-symbols-outlined">receipt_long</span>
        <span className="logx-title">日志库</span>
        <span className="logx-flex" />
        <button className="logx-icon-btn" title="清空日志" onClick={() => setConfirmClear(true)}>
          <span className="material-symbols-outlined">delete_sweep</span>
        </button>
        <button className="logx-icon-btn" title="收起" onClick={onCollapse}>
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      </div>
      <div className="logx-toolbar">
        <div className="logx-search">
          <span className="material-symbols-outlined">search</span>
          <input
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            placeholder="搜索日志内容"
          />
          {keywordInput && (
            <button className="logx-icon-btn" title="清空搜索" onClick={() => setKeywordInput('')}>
              <span className="material-symbols-outlined">close</span>
            </button>
          )}
        </div>
        <button
          ref={filterBtnRef}
          className={`logx-filter-btn ${filter !== 'all' ? 'active' : ''}`}
          onClick={() => setMenuOpen((v) => !v)}
          title="按来源筛选"
        >
          <span className="material-symbols-outlined">filter_list</span>
          {filter !== 'all' && <span className="logx-filter-label">{scopeLabel(filter)}</span>}
        </button>
      </div>
      {menuOpen && (
        <ActionMenu
          anchorEl={filterBtnRef.current ?? undefined}
          items={menuItems}
          onClose={() => setMenuOpen(false)}
        />
      )}
      <div className="logx-list" ref={listRef} onScroll={onScroll}>
        {error ? (
          <div className="logx-empty">
            {error}
            <button className="logx-retry" onClick={() => void fetchFirst()}>
              重试
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="logx-empty">
            {keywordRef.current || filter !== 'all' ? '无匹配日志' : '暂无日志'}
          </div>
        ) : (
          rows.map((row) => (
            <div key={row.id} className={`logx-row logx-${row.level}`}>
              <span className="logx-time">{fmtTs(row.ts)}</span>
              <span className="logx-scope">{scopeLabel(row.scope)}</span>
              <span className="logx-msg">{row.message}</span>
            </div>
          ))
        )}
        {hasMore && rows.length > 0 && <div className="logx-older-hint">上滚加载更早…</div>}
      </div>
      {!following && (
        <button className="logx-bottom-btn" onClick={backToBottom}>
          回到底部{newCount > 0 ? ` (+${newCount})` : ''}
        </button>
      )}
      <ConfirmDialog
        open={confirmClear}
        title="清空日志"
        danger
        confirmText="清空"
        onConfirm={() => void doClear()}
        onCancel={() => setConfirmClear(false)}
      >
        确定清空全部日志？该操作不可恢复（此后新日志照常记录）。
      </ConfirmDialog>
    </aside>
  )
}
