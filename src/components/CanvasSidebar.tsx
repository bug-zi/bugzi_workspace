// 画布边栏（新功能开发区 260909）：右缘第三面板，与 debugzi/草稿本互斥展开。
// 多画布管理（镜像草稿本切换条：浮层列表、hover 重命名/删除）+ 内嵌 Excalidraw 舞台
// + 「大窗作画」互斥挂载（大窗打开时右栏舞台卸载显示占位）；删除走回收站。
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { CanvasRow } from '../renderer/api'
import { SettingsKeys } from '../shared/types'
import { useAppSettings } from '../theme/ThemeProvider'
import CanvasDialog from './CanvasDialog'
import CanvasStage, { type CanvasStageHandle } from './CanvasStage'
import ConfirmDialog from './ConfirmDialog'
import { useToast } from './Toast'
import './CanvasSidebar.css'

export interface CanvasSidebarProps {
  onCollapse: () => void
}

/** 面板宽度拖拽范围（px；默认值同 global.css --canvas-width）。
 *  上限比其他面板（280–560）放宽到 900：Excalidraw 在窄栏里画起来挤（设计决策②） */
const CANVAS_WIDTH_MIN = 280
const CANVAS_WIDTH_MAX = 900
const CANVAS_WIDTH_DEFAULT = 360

const clampCanvasWidth = (w: number): number =>
  Math.min(CANVAS_WIDTH_MAX, Math.max(CANVAS_WIDTH_MIN, Math.round(w)))

/** 宽度写 :root 的 --canvas-width（样式即生效） */
function applyCanvasWidth(w: number): void {
  document.documentElement.style.setProperty('--canvas-width', `${w}px`)
}

/** 相对时间（画布列表用，口径同草稿本/AiSidebar） */
function relTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(t).toLocaleDateString('zh-CN')
}

export default function CanvasSidebar(props: CanvasSidebarProps) {
  const { onCollapse } = props
  const { toast } = useToast()
  const { theme } = useAppSettings()
  const [canvases, setCanvases] = useState<CanvasRow[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameText, setRenameText] = useState('')
  const [confirmDel, setConfirmDel] = useState<CanvasRow | null>(null)
  const [bigWindow, setBigWindow] = useState(false)
  const [canvasWidth, setCanvasWidth] = useState(CANVAS_WIDTH_DEFAULT)
  const stageRef = useRef<CanvasStageHandle>(null)
  const activeIdRef = useRef<number | null>(null)
  activeIdRef.current = activeId

  /** 刷新画布列表并恢复激活画布（失效兜底最近一张，无则空态） */
  const loadList = async (): Promise<void> => {
    const list = await window.api.canvas.list()
    setCanvases(list)
    const saved = await window.api.settings.get(SettingsKeys.CanvasActiveId)
    const sid = saved ? Number(saved) : NaN
    let aid = Number.isInteger(sid) && sid > 0 && list.some((c) => c.id === sid) ? sid : null
    if (aid == null && list.length > 0) aid = list[0].id
    if (aid !== activeIdRef.current) {
      activeIdRef.current = aid
      setActiveId(aid)
    }
    await window.api.settings.set(SettingsKeys.CanvasActiveId, aid == null ? '' : String(aid))
  }

  // 初始化：画布列表 + 恢复保存的面板宽度
  useEffect(() => {
    void (async () => {
      await loadList()
      const savedW = await window.api.settings.get(SettingsKeys.CanvasWidth)
      const w = savedW ? Number(savedW) : NaN
      if (Number.isFinite(w) && w >= CANVAS_WIDTH_MIN && w <= CANVAS_WIDTH_MAX) {
        setCanvasWidth(w)
        applyCanvasWidth(w)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 回收站恢复画布 → 刷新列表（恢复的画布回到面板）
  useEffect(() => {
    return window.api.item.onRecycleChanged(() => {
      void loadList()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 切换画布：先落袋防抖窗口内的变动（右栏舞台以 key=activeId 重挂自动重读盘） */
  const switchCanvas = async (id: number): Promise<void> => {
    if (id === activeIdRef.current) {
      setPanelOpen(false)
      return
    }
    await stageRef.current?.flush()
    activeIdRef.current = id
    setActiveId(id)
    setPanelOpen(false)
    setRenamingId(null)
    await window.api.settings.set(SettingsKeys.CanvasActiveId, String(id))
  }

  /** 新建画布：入列表首并被激活 */
  const newCanvas = async (): Promise<void> => {
    const id = await window.api.canvas.create()
    activeIdRef.current = id
    setActiveId(id)
    setPanelOpen(false)
    setRenamingId(null)
    await window.api.settings.set(SettingsKeys.CanvasActiveId, String(id))
    await loadList() // 新画布 updated_at 最新，自然排列表首
  }

  /** 双击改名提交（Enter） */
  const commitRename = async (id: number): Promise<void> => {
    const title = renameText.trim()
    setRenamingId(null)
    if (!title) return
    await window.api.canvas.rename(id, title)
    setCanvases((arr) => arr.map((c) => (c.id === id ? { ...c, title } : c)))
  }

  /** 删除画布 → 回收站（二次确认后） */
  const doDelete = async (): Promise<void> => {
    const target = confirmDel
    if (!target) return
    setConfirmDel(null)
    await window.api.canvas.discard(target.id)
    toast('已移入回收站（3 天后彻底删除）')
    await loadList()
  }

  /** 落盘后刷新列表排序（updated_at bump 浮回列表顶部） */
  const onSaved = (): void => {
    void window.api.canvas.list().then(setCanvases)
  }

  /** 拖拽左缘调宽：移动中实时生效，松手持久化到 settings */
  const startResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = canvasWidth
    const onMove = (ev: MouseEvent): void => {
      const w = clampCanvasWidth(startWidth - (ev.clientX - startX))
      setCanvasWidth(w)
      applyCanvasWidth(w)
    }
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      void window.api.settings.set(
        SettingsKeys.CanvasWidth,
        String(clampCanvasWidth(startWidth - (ev.clientX - startX)))
      )
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
  }

  const activeCanvas = canvases.find((c) => c.id === activeId) ?? null

  return (
    <aside className="canvas-sidebar">
      <div className="canvas-resizer" onMouseDown={startResize} title="拖拽调整宽度" />
      <div className="canvas-header">
        <span className="material-symbols-outlined">draw</span>
        <span className="canvas-title">画布</span>
        <button className="btn btn-ghost" onClick={onCollapse} title="收起">
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      </div>
      {/* 画布切换条：当前画布标题（点开浮层列表）+ 新建 */}
      {activeId != null && (
        <div className="canvas-switchbar">
          <button
            className="canvas-switch-trigger"
            onClick={() => setPanelOpen((v) => !v)}
            title="画布列表"
          >
            <span className="canvas-switch-title">{activeCanvas?.title ?? '未命名画布'}</span>
            <span className="material-symbols-outlined">{panelOpen ? 'expand_less' : 'expand_more'}</span>
          </button>
          <button className="btn btn-ghost" onClick={() => void newCanvas()} title="新建画布">
            <span className="material-symbols-outlined">add</span>
          </button>
        </div>
      )}
      <div className="canvas-body">
        {activeId != null && panelOpen && (
          <>
            <div className="canvas-panel-backdrop" onClick={() => setPanelOpen(false)} />
            <div className="canvas-panel">
              <div className="canvas-panel-head">
                <span>画布</span>
                <button className="btn btn-ghost" onClick={() => void newCanvas()} title="新建画布">
                  <span className="material-symbols-outlined">add</span>
                </button>
              </div>
              <div className="canvas-list">
                {canvases.length === 0 && (
                  <div className="canvas-panel-empty">暂无画布，点右上角「+」新建</div>
                )}
                {canvases.map((c) => (
                  <div
                    key={c.id}
                    className={`canvas-item${c.id === activeId ? ' active' : ''}`}
                    onClick={() => void switchCanvas(c.id)}
                    title="单击切换画布"
                  >
                    {renamingId === c.id ? (
                      <input
                        className="canvas-item-rename"
                        value={renameText}
                        autoFocus
                        maxLength={50}
                        onChange={(e) => setRenameText(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void commitRename(c.id)
                          }
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        onBlur={() => setRenamingId(null)}
                      />
                    ) : (
                      <>
                        <div className="canvas-item-title">{c.title}</div>
                        <div className="canvas-item-time">{relTime(c.updated_at)}</div>
                        <button
                          className="canvas-item-act"
                          title="重命名画布"
                          onClick={(e) => {
                            e.stopPropagation()
                            setRenamingId(c.id)
                            setRenameText(c.title)
                          }}
                        >
                          <span className="material-symbols-outlined">edit</span>
                        </button>
                      </>
                    )}
                    <button
                      className="canvas-item-act canvas-item-del"
                      title="移入回收站"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmDel(c)
                      }}
                    >
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        {/* 画布区：Excalidraw 舞台 / 大窗让位占位 / 空态 */}
        {activeId == null ? (
          <div className="canvas-empty">
            还没有画布
            <button className="btn btn-primary canvas-empty-new" onClick={() => void newCanvas()}>
              <span className="material-symbols-outlined">add</span>
              新建画布
            </button>
          </div>
        ) : bigWindow ? (
          // 大窗打开：右栏舞台卸载让位（Excalidraw 同画布双实例场景分离，互斥挂载）
          <div className="canvas-bigwin-placeholder">
            <span className="material-symbols-outlined">open_in_full</span>
            已在大窗中打开，关闭大窗后回到边栏
          </div>
        ) : (
          <CanvasStage
            key={activeId}
            ref={stageRef}
            id={activeId}
            path={activeCanvas?.path ?? `canvas/${activeId}.excalidraw`}
            title={activeCanvas?.title ?? '未命名画布'}
            theme={theme}
            onSaved={onSaved}
          />
        )}
      </div>
      {/* 底部动作条 */}
      {activeId != null && (
        <div className="canvas-actions">
          <span className="canvas-actions-hint">停笔自动保存</span>
          <button
            className="btn btn-ghost"
            onClick={() => setBigWindow(true)}
            title="用大弹窗作画（空间更大）"
          >
            <span className="material-symbols-outlined">open_in_full</span>
            大窗作画
          </button>
        </div>
      )}
      {/* 大窗作画：关闭时舞台已先落袋，重挂右栏即读回最新（数据同源） */}
      {activeCanvas && (
        <CanvasDialog
          open={bigWindow}
          title={activeCanvas.title}
          id={activeCanvas.id}
          path={activeCanvas.path}
          theme={theme}
          onClose={() => {
            setBigWindow(false)
            onSaved() // 大窗落袋后刷新列表排序
          }}
          onSaved={onSaved}
        />
      )}
      <ConfirmDialog
        open={confirmDel != null}
        title="删除画布"
        confirmText="移入回收站"
        danger
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDel(null)}
      >
        {confirmDel ? `画布「${confirmDel.title}」将移入回收站，3 天后自动彻底删除。` : ''}
      </ConfirmDialog>
    </aside>
  )
}
