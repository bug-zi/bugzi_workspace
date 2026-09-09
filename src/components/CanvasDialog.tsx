// 画布大窗弹窗（画布侧边栏「大窗作画」）：复用全局 .dialog 弹窗骨架，内容区换 Excalidraw
// 舞台；关闭前强制落袋再关（防抖窗口内最后变动不丢）。与右栏内嵌舞台互斥挂载由父级控制。
import { useCallback, useEffect, useRef } from 'react'
import type { Theme } from '../shared/types'
import CanvasStage, { type CanvasStageHandle } from './CanvasStage'
import './CanvasSidebar.css'

export interface CanvasDialogProps {
  open: boolean
  title: string
  id: number | null
  path: string
  theme: Theme
  onClose: () => void
  /** 落盘成功回调（父级刷新列表排序） */
  onSaved?: () => void
}

export default function CanvasDialog(props: CanvasDialogProps) {
  const { open, title, id, path, theme, onClose, onSaved } = props
  const stageRef = useRef<CanvasStageHandle>(null)

  /** 关闭 = 先落袋（等待写盘完成）再回调（父级重挂右栏舞台时盘上已是最新） */
  const close = useCallback(async (): Promise<void> => {
    await stageRef.current?.flush()
    onClose()
  }, [onClose])

  // Esc 关闭（编辑内容先落袋）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open || id == null) return null

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void close()
      }}
    >
      <div className="dialog canvas-dialog">
        <div className="dialog-header">
          <span className="dialog-title" title={title}>
            {title}
          </span>
          <button className="btn btn-ghost" onClick={() => void close()} title="关闭（Esc）">
            关闭
          </button>
        </div>
        <div className="dialog-body canvas-dialog-body">
          <CanvasStage ref={stageRef} id={id} path={path} title={title} theme={theme} onSaved={onSaved} />
        </div>
      </div>
    </div>
  )
}
