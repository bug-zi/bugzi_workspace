// 阅读视图 Ctrl+滚轮字号缩放（信息源 ArticleView 同款逻辑抽出共享）：
// 80%–200% 步进 10，全局记一档（settings feed_reader_zoom——信息源/论文库/科普长文同一偏好）。
// 返回 scrollRef 挂滚动容器、zoom 作用于正文 font-size（%）。
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { SettingsKeys } from '../shared/types'
import { useAppSettings } from '../theme/ThemeProvider'

const ZOOM_MIN = 80
const ZOOM_MAX = 200
const ZOOM_STEP = 10
const ZOOM_DEFAULT = 100

function clampZoom(v: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v))
}

/** settings 原始值解析：非数字/非正/越界回落 100，并对齐 10 步进 */
function parseZoom(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return ZOOM_DEFAULT
  return clampZoom(Math.round(n / ZOOM_STEP) * ZOOM_STEP)
}

export function useReaderZoom(): {
  scrollRef: RefObject<HTMLDivElement | null>
  zoom: number
  zoomBarVisible: boolean
  resetZoom: () => void
} {
  const { settings, setSetting } = useAppSettings()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [zoom, setZoom] = useState<number>(() => parseZoom(settings[SettingsKeys.FeedZoom]))
  const [zoomBarVisible, setZoomBarVisible] = useState(false)

  // Ctrl+滚轮缩放：原生非 passive 监听（React 合成 onWheel 是 passive，preventDefault 无效）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault() // 阻断 Chromium/Electron 默认整页缩放
      setZoom((z) => clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 缩放落库（全局一档记忆；挂载时回写同值无副作用）
  useEffect(() => {
    void setSetting(SettingsKeys.FeedZoom, String(zoom))
  }, [zoom, setSetting])

  // 指示条：变化浮出，1.5s 无变化淡出
  useEffect(() => {
    setZoomBarVisible(true)
    const t = window.setTimeout(() => setZoomBarVisible(false), 1500)
    return () => window.clearTimeout(t)
  }, [zoom])

  return { scrollRef, zoom, zoomBarVisible, resetZoom: () => setZoom(ZOOM_DEFAULT) }
}
