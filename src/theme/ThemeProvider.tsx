// 主题与全局设置 Provider（样式 specs §1.2 / 个人中心 specs §3.1）
// 启动读 settings → 设置 data-theme / CSS 变量；切主题/换背景即时生效并写库
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { SettingsKeys, type Theme } from '../shared/types'

interface ThemeCtx {
  theme: Theme
  toggleTheme: () => void
  setTheme: (t: Theme) => void
  bgLightUrl: string
  bgDarkUrl: string
  /** 个人中心换背景后调用：刷新当前 --bg-image */
  refreshBg: () => Promise<void>
  settings: Record<string, string>
  setSetting: (key: string, value: string) => Promise<void>
  reloadSettings: () => Promise<void>
  firstLaunch: boolean
  setFirstLaunchDone: () => void
}

const Ctx = createContext<ThemeCtx>(null as unknown as ThemeCtx)

export function useAppSettings(): ThemeCtx {
  return useContext(Ctx)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light')
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [bgLightUrl, setBgLightUrl] = useState('')
  const [bgDarkUrl, setBgDarkUrl] = useState('')
  const [firstLaunch, setFirstLaunch] = useState(false)

  // 启动：读全部设置并应用
  useEffect(() => {
    void (async () => {
      const all = await window.api.settings.getAll()
      setSettings(all)
      const t = all[SettingsKeys.Theme] === 'dark' ? 'dark' : 'light'
      setThemeState(t)
      // 无 user_name → 首次启动引导（个人中心 specs §4）
      setFirstLaunch(!all[SettingsKeys.UserName])
      applyFontVars(all)
      await applyBg(t, all)
    })()
  }, [])

  const applyFontVars = (all: Record<string, string>): void => {
    const root = document.documentElement
    if (all[SettingsKeys.FontSize]) root.style.setProperty('--font-size', `${all[SettingsKeys.FontSize]}px`)
    if (all[SettingsKeys.FontFamily]) root.style.setProperty('--font-family', all[SettingsKeys.FontFamily])
    if (all[SettingsKeys.FontWeight]) root.style.setProperty('--font-weight', all[SettingsKeys.FontWeight])
  }

  /** 背景图：settings 存各组文件名（素材库 260911：文件在 bg/<group>/ 子目录），bzres:// 协议引用 */
  const applyBg = async (t: Theme, all: Record<string, string>): Promise<void> => {
    const key = t === 'light' ? 'bg_bg-light' : 'bg_bg-dark'
    const file = all[key]
    let url = ''
    if (file) {
      // 组目录路径在前；bg/ 根旧路径兜底（迁移失败静默时旧图仍在原地，行为不回退）
      for (const u of [`bzres://bg/${t}/${file}`, `bzres://bg/${file}`]) {
        url = u
        // 探测 404 回退纯色/下一候选；fetch 异常（网络层拦截等）不视为文件缺失——
        // CSS url() 加载不受 CORS 限制，保留 url 让样式层自行决定
        try {
          const probe = await fetch(u)
          if (probe.ok) break
          url = ''
        } catch {
          break
        }
      }
    }
    document.documentElement.style.setProperty(
      '--bg-image',
      url ? `url("${url}")` : 'none'
    )
    if (t === 'light') setBgLightUrl(url)
    else setBgDarkUrl(url)
  }

  const setTheme = useCallback(
    (t: Theme) => {
      setThemeState(t)
      document.documentElement.setAttribute('data-theme', t)
      void window.api.settings.set(SettingsKeys.Theme, t)
      setSettings((s) => ({ ...s, [SettingsKeys.Theme]: t }))
      void applyBg(t, settings)
    },
    [settings]
  )

  const toggleTheme = useCallback(() => {
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark')
  }, [setTheme])

  const refreshBg = useCallback(async () => {
    const all = await window.api.settings.getAll()
    setSettings(all)
    await applyBg(theme, all)
  }, [theme])

  const setSetting = useCallback(async (key: string, value: string) => {
    await window.api.settings.set(key, value)
    setSettings((s) => ({ ...s, [key]: value }))
  }, [])

  const reloadSettings = useCallback(async () => {
    const all = await window.api.settings.getAll()
    setSettings(all)
    applyFontVars(all)
  }, [])

  // data-theme 同步（首帧）
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const value: ThemeCtx = {
    theme,
    toggleTheme,
    setTheme,
    bgLightUrl,
    bgDarkUrl,
    refreshBg,
    settings,
    setSetting,
    reloadSettings,
    firstLaunch,
    setFirstLaunchDone: () => setFirstLaunch(false)
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
