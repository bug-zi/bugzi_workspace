// 三栏布局 + 模块路由（样式 specs §3）
import { useCallback, useEffect, useState } from 'react'
import { ThemeProvider, useAppSettings } from './theme/ThemeProvider'
import { ToastProvider } from './components/Toast'
import AiSidebar from './components/AiSidebar'
import MottosModule from './modules/mottos/MottosModule'
import WikiModule from './modules/wiki/WikiModule'
import InspirationsModule from './modules/inspirations/InspirationsModule'
import VerifyModule from './modules/verify/VerifyModule'
import ZhijijiModule from './modules/zhijiji/ZhijijiModule'
import ReasoningModule from './modules/reasoning/ReasoningModule'
import RecycleModule from './modules/recycle/RecycleModule'
import ProfileModule from './modules/profile/ProfileModule'
import WelcomeGuide from './modules/profile/WelcomeGuide'
import type { AiChannel, ModuleId } from './shared/types'
import './App.css'

const MODULES: { id: ModuleId; label: string; icon: string }[] = [
  { id: 'mottos', label: '格言库', icon: 'format_quote' },
  { id: 'wiki', label: '万象库', icon: 'public' },
  { id: 'inspirations', label: '灵感泉', icon: 'lightbulb' },
  { id: 'verify', label: '辩真阁', icon: 'fact_check' },
  { id: 'zhijiji', label: '致知己', icon: 'self_improvement' },
  { id: 'reasoning', label: '推理角', icon: 'psychology' },
  { id: 'recycle', label: '回收站', icon: 'delete' },
  { id: 'profile', label: '个人中心', icon: 'person' }
]

/** 模块 → AI 边栏频道映射（频道制，致知己 specs §4）：其余模块默认助手频道 */
const CHANNEL_BY_MODULE: Partial<Record<ModuleId, AiChannel>> = {
  mottos: 'motto',
  wiki: 'wiki',
  verify: 'verify',
  zhijiji: 'zhijiji'
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </ThemeProvider>
  )
}

// 模块激活自定义事件（keep-alive 下切回模块时通知其刷新数据——替代卸载重挂的隐式刷新）
export const MODULE_ACTIVATED_EVENT = 'bugzi:module-activated'

function Shell() {
  const { theme, toggleTheme, firstLaunch, setFirstLaunchDone } = useAppSettings()
  const [module, setModule] = useState<ModuleId>('mottos')
  const [aiCollapsed, setAiCollapsed] = useState(false)
  const [aiPending, setAiPending] = useState<{ text: string; channel: AiChannel; auto: boolean } | null>(null)
  const [aiVersion, setAiVersion] = useState(0)
  const [aiForceOpen, setAiForceOpen] = useState(false)

  // 切换模块 = 激活目标模块（常驻组件监听此事件自行刷新）
  const activateModule = useCallback((id: ModuleId) => {
    setModule(id)
    window.dispatchEvent(new CustomEvent(MODULE_ACTIVATED_EVENT, { detail: id }))
  }, [])

  // 模块请求展开 AI 边栏（频道制：按当前模块映射频道；opts.auto 时切频道后自动发送）
  const openAiWith = useCallback(
    (prefill?: string, opts?: { auto?: boolean }) => {
      setAiCollapsed(false)
      setAiForceOpen((v) => !v)
      setAiPending({
        text: prefill ?? '',
        channel: CHANNEL_BY_MODULE[module] ?? 'assistant',
        auto: opts?.auto ?? false
      })
    },
    [module]
  )

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
              onClick={() => activateModule(m.id)}
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

        {/* 中间主栏（keep-alive：模块切换仅隐藏不卸载，AI 生成任务不因切页中断——问题疑惑区万象库#A） */}
        <main className="main-area">
          {MODULES.map((m) => (
            <div
              key={m.id}
              className={m.id === module ? 'module-live' : 'module-live module-hidden'}
              aria-hidden={m.id !== module}
            >
              {m.id === 'mottos' && <MottosModule onOpenAi={openAiWith} bumpAi={() => setAiVersion((v) => v + 1)} />}
              {m.id === 'wiki' && (
                <WikiModule onOpenAi={openAiWith} bumpAi={() => setAiVersion((v) => v + 1)} />
              )}
              {m.id === 'inspirations' && <InspirationsModule onOpenAi={openAiWith} />}
              {m.id === 'verify' && (
                <VerifyModule onOpenAi={openAiWith} bumpAi={() => setAiVersion((v) => v + 1)} />
              )}
              {m.id === 'zhijiji' && (
                <ZhijijiModule onNavigateToProfile={() => activateModule('profile')} />
              )}
              {m.id === 'reasoning' && <ReasoningModule />}
              {m.id === 'recycle' && <RecycleModule />}
              {m.id === 'profile' && <ProfileModule />}
            </div>
          ))}
        </main>

        {/* 右侧 AI 边栏（频道制） */}
        <AiSidebar
          collapsed={aiCollapsed}
          onToggle={() => setAiCollapsed((c) => !c)}
          currentModule={module}
          pending={aiPending}
          onPendingConsumed={() => setAiPending(null)}
          messagesVersion={aiVersion}
          onNavigateToProfile={() => activateModule('profile')}
        />
      </div>

      {/* 首次启动引导（个人中心 specs §4） */}
      <WelcomeGuide open={firstLaunch} onDone={setFirstLaunchDone} onGoProfile={() => activateModule('profile')} />
    </>
  )
}
