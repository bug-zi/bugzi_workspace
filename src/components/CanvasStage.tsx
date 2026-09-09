// 画布舞台（画布侧边栏）：Excalidraw 实例封装——按 path 加载 .excalidraw、
// onChange 停止变动 800ms 静默落盘（serializeAsJSON 标准格式）+ bump updated_at、
// 卸载时强制落袋（flush 兜住防抖窗口）。同一画布右栏与大窗互斥挂载，数据同源。
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import type { AppState } from '@excalidraw/excalidraw/types'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import { useToast } from './Toast'
import './CanvasSidebar.css'

export interface CanvasStageHandle {
  /** 强制落袋：把未保存的最新场景立即写盘（大窗关闭/切换画布前调用） */
  flush(): Promise<void>
}

export interface CanvasStageProps {
  /** 画布 id（保存走 canvas:save） */
  id: number
  /** .excalidraw 文件相对路径（userData 下，正斜杠） */
  path: string
  /** 画布名（Excalidraw 导出图片默认文件名） */
  title: string
  theme: 'light' | 'dark'
  /** 每次成功落盘后回调（父级刷新列表排序） */
  onSaved?: () => void
}

/** 停笔即存的静默窗口（口径同草稿本 800ms） */
const SAVE_DEBOUNCE_MS = 800

const CanvasStage = forwardRef<CanvasStageHandle, CanvasStageProps>(function CanvasStage(
  { id, path, title, theme, onSaved },
  ref
) {
  const { toast } = useToast()
  // initialData：加载完成前为 null（渲染 loading，避免空场景闪一下清掉画布）
  const [scene, setScene] = useState<{
    elements: readonly OrderedExcalidrawElement[]
    appState: Partial<AppState>
  } | null>(null)
  // 最新场景引用（防抖保存与卸载落袋读它，避免闭包旧值）
  const latestRef = useRef<{ elements: readonly OrderedExcalidrawElement[]; appState: AppState } | null>(null)
  const loadedJsonRef = useRef('')
  const dirtyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedRef = useRef(onSaved)
  savedRef.current = onSaved

  // 加载 .excalidraw：缺失/损坏按空白画布打开（toast 提示一次），不崩不阻塞
  useEffect(() => {
    let cancelled = false
    setScene(null)
    latestRef.current = null
    dirtyRef.current = false
    void window.api.md
      .read(path)
      .then((raw) => {
        if (cancelled) return
        loadedJsonRef.current = raw
        try {
          const parsed = JSON.parse(raw) as { elements?: unknown; appState?: Record<string, unknown> }
          setScene({
            elements: Array.isArray(parsed.elements)
              ? (parsed.elements as OrderedExcalidrawElement[])
              : [],
            appState: pickAppState(parsed.appState)
          })
        } catch {
          loadedJsonRef.current = ''
          setScene({ elements: [], appState: {} })
          toast('画布文件已损坏，按空白画布打开')
        }
      })
      .catch(() => {
        if (cancelled) return
        loadedJsonRef.current = ''
        setScene({ elements: [], appState: {} })
        toast('画布文件缺失，按空白画布打开')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  /** 立即写盘（脏检查 + 与盘上内容比对，一致不写不 bump） */
  const doSave = async (): Promise<void> => {
    const latest = latestRef.current
    if (!latest || !dirtyRef.current) return
    dirtyRef.current = false
    try {
      // serializeAsJSON(elements, appState, files, type)：0.18.1 为四参数位置式；
      // files 传空（v1 不落盘位图资产），type 'local' 导出标准 .excalidraw 内容
      const json = serializeAsJSON(latest.elements, latest.appState, {}, 'local')
      if (json === loadedJsonRef.current) return
      loadedJsonRef.current = json
      await window.api.canvas.save(id, json)
      savedRef.current?.()
    } catch {
      dirtyRef.current = true // 保留脏标记，下次变动/落袋重试
      toast('画布保存失败，稍后重试')
    }
  }

  const scheduleSave = (): void => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void doSave()
    }, SAVE_DEBOUNCE_MS)
  }

  // 卸载落袋：面板收起/切画布/关大窗时未保存的改动先写盘（纯 IPC，不依赖组件存活）
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (dirtyRef.current) void doSave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useImperativeHandle(ref, () => ({ flush: doSave }), [])

  return (
    <div className="canvas-stage">
      {scene ? (
        <Excalidraw
          initialData={{ elements: scene.elements, appState: scene.appState }}
          onChange={(elements, appState) => {
            latestRef.current = { elements, appState }
            dirtyRef.current = true
            scheduleSave()
          }}
          theme={theme}
          langCode="zh-CN"
          name={title}
          UIOptions={{
            canvasActions: {
              // 画布文件由本 App 管理：关「打开文件」与「保存到当前文件」，防旁路写
              loadScene: false,
              saveToActiveFile: false
            }
          }}
        />
      ) : (
        <div className="canvas-stage-loading">加载中…</div>
      )}
    </div>
  )
})

/** 只回灌影响画面呈现的 appState 字段（缩放/滚动等视口态不还原，重开画布居中起步） */
function pickAppState(raw: Record<string, unknown> | undefined): Partial<AppState> {
  if (!raw) return {}
  const out: Record<string, unknown> = {}
  if (typeof raw.viewBackgroundColor === 'string') out.viewBackgroundColor = raw.viewBackgroundColor
  if (raw.gridSize === null || typeof raw.gridSize === 'number') out.gridSize = raw.gridSize
  return out as Partial<AppState>
}

export default CanvasStage
