// 模块深链导航监听 hook（配合 App.tsx 的 MODULE_NAVIGATE_EVENT，与 useModuleActivated 对称）
// 用法：useModuleNavigate('wiki', (target) => { if (target === 'learn-zone') setView({ kind: 'learn' }) })
// keep-alive 下组件常驻，藏于后台也接得住；onNavigate 内联箭头每渲染重订阅（useModuleActivated 同款，开销可忽略）
import { useEffect } from 'react'
import { MODULE_NAVIGATE_EVENT } from '../App'
import type { ModuleNavDetail } from '../shared/types'

export function useModuleNavigate(
  moduleId: string,
  onNavigate: (target: string, payload: Record<string, unknown> | undefined) => void
): void {
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<ModuleNavDetail>).detail
      if (detail && detail.module === moduleId) onNavigate(detail.target, detail.payload)
    }
    window.addEventListener(MODULE_NAVIGATE_EVENT, handler)
    return () => window.removeEventListener(MODULE_NAVIGATE_EVENT, handler)
  }, [moduleId, onNavigate])
}
