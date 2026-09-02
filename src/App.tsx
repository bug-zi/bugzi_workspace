// 三栏布局 + 模块路由（样式 specs §3）
import { useCallback, useEffect, useState } from 'react'
import { ThemeProvider, useAppSettings } from './theme/ThemeProvider'
import { ToastProvider } from './components/Toast'
import AiSidebar from './components/AiSidebar'
import MottosModule from './modules/mottos/MottosModule'
import WikiModule from './modules/wiki/WikiModule'
import InspirationsModule from './modules/inspirations/InspirationsModule'
import VerifyModule from './modules/verify/VerifyModule'
import RecycleModule from './modules/recycle/RecycleModule'
import ProfileModule from './modules/profile/ProfileModule'
import WelcomeGuide from './modules/profile/WelcomeGuide'
import type { ModuleId } from './shared/types'
import './App.css'

const MODULES: { id: ModuleId; label: string; icon: string }[] = [
  { id: 'mottos', label: '格言库', icon: 'format_quote' },
  { id: 'wiki', label: '万象库', icon: 'public' },
  { id: 'inspirations', label: '灵感泉', icon: 'lightbulb' },
  { id: 'verify', label: '辩真阁', icon: 'fact_check' },
  { id: 'recycle', label: '回收站', icon: 'delete' },
  { id: 'profile', label: '个人中心', icon: 'person' }
]

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </ThemeProvider>
  )
}

function Shell() {
  const { theme, toggleTheme, firstLaunch, setFirstLaunchDone } = useAppSettings()
  const [module, setModule] = useState<ModuleId>('mottos')
  const [aiCollapsed, setAiCollapsed] = useState(false)
  const [aiPendingAsk, setAiPendingAsk] = useState<string | null>(null)
  const [aiVersion, setAiVersion] = useState(0)
  const [aiForceOpen, setAiForceOpen] = useState(false)

  // 万象库/辩真阁请求展开 AI 边栏
  const openAiWith = useCallback((prefill?: string) => {
    setAiCollapsed(false)
    setAiForceOpen((v) => !v)
    if (prefill) setAiPendingAsk(prefill)
  }, [])

  // 问 AI / 验证过程推送 → messagesVersion 递增通知 AiSidebar 重载
  useEffect(() => {
    if (!aiForceOpen) return
  }, [aiForceOpen])

  return (
    <>
      <div className="app-bg" />
      <div className="app-shell">
        {/* 左侧边栏 */}
        <nav className="sidebar">
          {MODULES.map((m) => (
            <button
              key={m.id}
              className={`nav-item${module === m.id ? ' active' : ''}`}
              onClick={() => setModule(m.id)}
              title={m.label}
            >
              <span className="material-symbols-outlined">{m.icon}</span>
              <span className="nav-label">{m.label}</span>
            </button>
          ))}
          <div className="sidebar-spacer" />
          <button className="nav-item" onClick={toggleTheme} title={theme === 'light' ? '切到深色' : '切到浅色'}>
            <span className="material-symbols-outlined">{theme === 'light' ? 'dark_mode' : 'light_mode'}</span>
            <span className="nav-label">主题</span>
          </button>
        </nav>

        {/* 中间主栏 */}
        <main className="main-area">
          {module === 'mottos' && <MottosModule onOpenAi={openAiWith} bumpAi={() => setAiVersion((v) => v + 1)} />}
          {module === 'wiki' && (
            <WikiModule onOpenAi={openAiWith} bumpAi={() => setAiVersion((v) => v + 1)} />
          )}
          {module === 'inspirations' && <InspirationsModule />}
          {module === 'verify' && (
            <VerifyModule onOpenAi={openAiWith} bumpAi={() => setAiVersion((v) => v + 1)} />
          )}
          {module === 'recycle' && <RecycleModule />}
          {module === 'profile' && <ProfileModule />}
        </main>

        {/* 右侧 AI 边栏 */}
        <AiSidebar
          collapsed={aiCollapsed}
          onToggle={() => setAiCollapsed((c) => !c)}
          currentModule={module}
          pendingAsk={aiPendingAsk}
          onPendingAskConsumed={() => setAiPendingAsk(null)}
          messagesVersion={aiVersion}
          onNavigateToProfile={() => setModule('profile')}
        />
      </div>

      {/* 首次启动引导（个人中心 specs §4） */}
      <WelcomeGuide open={firstLaunch} onDone={setFirstLaunchDone} onGoProfile={() => setModule('profile')} />
    </>
  )
}
