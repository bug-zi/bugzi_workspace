// keep-alive 模块激活刷新 hook（配合 App.tsx 的 MODULE_ACTIVATED_EVENT）
// 用法：useModuleActivated('wiki', load) —— 每次切回该模块时调用 load 刷新数据
import { useEffect } from 'react'
import { MODULE_ACTIVATED_EVENT } from '../App'

export function useModuleActivated(moduleId: string, onActivated: () => void): void {
  useEffect(() => {
    const handler = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === moduleId) onActivated()
    }
    window.addEventListener(MODULE_ACTIVATED_EVENT, handler)
    return () => window.removeEventListener(MODULE_ACTIVATED_EVENT, handler)
  }, [moduleId, onActivated])
}
