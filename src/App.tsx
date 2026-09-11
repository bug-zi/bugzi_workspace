// 三栏布局 + 模块路由（样式 specs §3）
import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ThemeProvider, useAppSettings } from './theme/ThemeProvider'
import { ToastProvider } from './components/Toast'
import AiSidebar from './components/AiSidebar'
import DraftSidebar from './components/DraftSidebar'
import CanvasSidebar from './components/CanvasSidebar'
import LearnModule from './modules/learn/LearnModule'
import WikiModule from './modules/wiki/WikiModule'
import InspirationsModule from './modules/inspirations/InspirationsModule'
import ZhijijiModule from './modules/zhijiji/ZhijijiModule'
import ReasoningModule from './modules/reasoning/ReasoningModule'
import WenbiModule from './modules/wenbi/WenbiModule'
import BookshelfModule from './modules/bookshelf/BookshelfModule'
import FavoritesModule from './modules/favorites/FavoritesModule'
import FeedModule from './modules/feed/FeedModule'
import LedgerModule from './modules/ledger/LedgerModule'
import RecycleModule from './modules/recycle/RecycleModule'
import ProfileModule from './modules/profile/ProfileModule'
import WelcomeGuide from './modules/profile/WelcomeGuide'
import NoisePage from './modules/noise/NoisePage'
import LlmActivity from './components/LlmActivity'
import TerminalPanel from './components/terminal/TerminalPanel'
import { noiseEngine } from './services/noiseEngine'
import { sceneById } from './services/noiseScenes'
import { useToast } from './components/Toast'
import { SettingsKeys, TURTLE_GAME_EVENT } from './shared/types'
import type { AiChannel, ModuleId } from './shared/types'
import './App.css'

// 左栏模块顺序（260908 重排；260911 格言库并入文笔坊 12→11 项；260911 学习库置顶 11→12 项）
const MODULES: { id: ModuleId; label: string; icon: string }[] = [
  { id: 'learn', label: '学习库', icon: 'school' },
  { id: 'wiki', label: '万象库', icon: 'public' },
  { id: 'bookshelf', label: '藏书架', icon: 'auto_stories' },
  { id: 'favorites', label: '收藏夹', icon: 'bookmark' },
  { id: 'feed', label: '信息源', icon: 'rss_feed' },
  { id: 'wenbi', label: '文笔坊', icon: 'history_edu' },
  { id: 'zhijiji', label: '致知己', icon: 'self_improvement' },
  { id: 'inspirations', label: '灵感泉', icon: 'lightbulb' },
  { id: 'reasoning', label: '推理角', icon: 'psychology' },
  { id: 'ledger', label: '记账本', icon: 'account_balance_wallet' },
  { id: 'recycle', label: '回收站', icon: 'delete' },
  { id: 'profile', label: '个人档', icon: 'person' }
]

/** 模块 → AI 边栏频道映射（频道制，致知己 specs §4）：其余模块默认助手频道；
 *  辩真阁已并入万象库，'verify' 频道由万象库辩真板块经 openAiWith 的 channel 覆盖直达；
 *  格言库已并入文笔坊，'motto' 频道由文笔坊格言面板显式传 channel 覆盖直达 */
const CHANNEL_BY_MODULE: Partial<Record<ModuleId, AiChannel>> = {
  learn: 'learn',
  wiki: 'wiki',
  zhijiji: 'zhijiji'
}

/** 主栏视图：十三模块 + 白噪音混音器页（不进左栏模块列表，入口在左栏底部控件；specs §5.1） */
type MainView = ModuleId | 'noise'

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
// 模块失活事件（优化建议区第26轮：海龟汤净用时——切走模块暂停计时）
export const MODULE_DEACTIVATED_EVENT = 'bugzi:module-deactivated'

function Shell() {
  const { theme, toggleTheme, firstLaunch, setFirstLaunchDone, settings } = useAppSettings()
  const { toast } = useToast()
  const [module, setModule] = useState<MainView>('wiki')
  // 当前模块 ref（失活事件需捕获旧模块 id；ref 方案防 strict-mode 双触发）
  const moduleRef = useRef<MainView>('wiki')
  useEffect(() => {
    moduleRef.current = module
  }, [module])
  // 右缘三面板互斥展开（260909 画布加入）：'ai'=debugzi | 'draft'=草稿本 | 'canvas'=画布 | null=都收起（右缘细条三图标入口）
  const [rightPanel, setRightPanel] = useState<'ai' | 'draft' | 'canvas' | null>('ai')
  const [aiPending, setAiPending] = useState<{ text: string; channel: AiChannel; auto: boolean } | null>(null)
  const [aiVersion, setAiVersion] = useState(0)
  const [aiForceOpen, setAiForceOpen] = useState(false)
  // 海龟汤对局上下文（TurtlePanel 进出对局派发；草稿本据此切频道 + 新建以汤名命名，App 持有保证面板收起时不丢）
  const [turtleGame, setTurtleGame] = useState<{ title: string } | null>(null)
  // 内置终端（260912）：open 默认收起（pty 不跨重启）；Ctrl+J 呼出/收起、Ctrl+Shift+J 新建标签
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalNewTabSignal, setTerminalNewTabSignal] = useState(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase()
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'j') {
        e.preventDefault()
        setTerminalOpen((o) => !o)
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && k === 'j') {
        e.preventDefault()
        setTerminalOpen(true)
        setTerminalNewTabSignal((v) => v + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onTurtleGame = (e: Event): void => {
      const detail = (e as CustomEvent<{ title: string } | null>).detail
      setTurtleGame(detail && typeof detail === 'object' ? detail : null)
    }
    window.addEventListener(TURTLE_GAME_EVENT, onTurtleGame)
    return () => window.removeEventListener(TURTLE_GAME_EVENT, onTurtleGame)
  }, [])

  // 启动恢复上次展开的面板（默认 debugzi，与既有行为一致）
  useEffect(() => {
    void window.api.settings.get(SettingsKeys.RightPanelExpanded).then((v) => {
      if (v === 'draft') setRightPanel('draft')
      else if (v === 'canvas') setRightPanel('canvas')
      else if (v === '') setRightPanel(null)
      else setRightPanel('ai')
    })
  }, [])

  // 白噪音启动恢复（specs §4）：只灌参数不播放——重启默认暂停，手动点播放
  useEffect(() => {
    void window.api.settings.get(SettingsKeys.NoiseState).then((raw) => {
      if (!raw) return
      try {
        noiseEngine.loadState(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        /* 坏数据静默容错，引擎内回退场景 defaults */
      }
    })
  }, [])

  // 白噪音队列配置恢复（播放队列轮）：只灌配置不运行——重启默认暂停、从头开始
  useEffect(() => {
    void window.api.settings.get(SettingsKeys.NoisePlayQueue).then((raw) => {
      if (!raw) return
      try {
        noiseEngine.loadQueue(JSON.parse(raw))
      } catch {
        /* 坏数据静默容错，loadQueue 内部逐条防线 */
      }
    })
  }, [])

  const switchRightPanel = useCallback((p: 'ai' | 'draft' | 'canvas' | null): void => {
    setRightPanel(p)
    void window.api.settings.set(SettingsKeys.RightPanelExpanded, p ?? '')
  }, [])

  // 切换模块 = 激活目标模块（常驻组件监听此事件自行刷新/启停计时）
  const activateModule = useCallback((id: MainView) => {
    const prev = moduleRef.current
    setModule(id)
    moduleRef.current = id
    if (prev !== id) {
      window.dispatchEvent(new CustomEvent(MODULE_DEACTIVATED_EVENT, { detail: prev }))
    }
    window.dispatchEvent(new CustomEvent(MODULE_ACTIVATED_EVENT, { detail: id }))
  }, [])

  // 模块请求展开 AI 边栏（频道制：按当前模块映射频道；opts.channel 显式覆盖——万象库辩真板块直连核查频道；
  // opts.auto 时切频道后自动发送）
  const openAiWith = useCallback(
    (prefill?: string, opts?: { auto?: boolean; channel?: AiChannel }) => {
      switchRightPanel('ai')
      setAiForceOpen((v) => !v)
      setAiPending({
        text: prefill ?? '',
        channel:
          opts?.channel ?? (module !== 'noise' ? CHANNEL_BY_MODULE[module] : undefined) ?? 'assistant',
        auto: opts?.auto ?? false
      })
    },
    [module, switchRightPanel]
  )

  // 问 AI / 验证过程推送 → messagesVersion 递增通知 AiSidebar 重载
  useEffect(() => {
    if (!aiForceOpen) return
  }, [aiForceOpen])

  // 白噪音播放态（引擎版本号驱动：图标高亮与页面播放按钮同步）
  useSyncExternalStore(noiseEngine.subscribe, noiseEngine.getSnapshot)
  const noisePlaying = noiseEngine.isPlaying()
  const noiseSceneLabel = sceneById(noiseEngine.getState().sceneId)?.label ?? ''

  return (
    <>
      <div className="app-bg" />
      <div className="app-shell">
        {/* 左侧边栏 */}
        <nav className="sidebar">
          {MODULES.map((m) => (
            <Fragment key={m.id}>
              {/* 白噪音控件列于记账本与回收站之间（260908 开发者指令：进列表不再钉底部） */}
              {m.id === 'recycle' && (
                <button
                  className={`nav-item noise-control${module === 'noise' ? ' active' : ''}`}
                  onClick={() => activateModule('noise')}
                  title={noisePlaying ? '白噪音播放中 · 点击打开混音器' : '打开白噪音混音器'}
                >
                  <span className={`material-symbols-outlined${noisePlaying ? ' noise-playing' : ''}`}>
                    graphic_eq
                  </span>
                  <span className="nav-label">白噪音</span>
                </button>
              )}
              <button
                className={`nav-item${module === m.id ? ' active' : ''}`}
                onClick={() => activateModule(m.id)}
                title={m.label}
              >
                <span className="material-symbols-outlined">{m.icon}</span>
                <span className="nav-label">{m.label}</span>
              </button>
            </Fragment>
          ))}
          <div className="sidebar-spacer" />
        </nav>

        {/* 中栏 + 右栏 + 底部终端面板纵向容器（260912 内置终端）：左栏不参与，保持完整可见 */}
        <div className="app-body">
          <div className="app-body-row">
            {/* 中间主栏（keep-alive：模块切换仅隐藏不卸载，AI 生成任务不因切页中断——问题疑惑区万象库#A） */}
            <main className="main-area">
          {MODULES.map((m) => (
            <div
              key={m.id}
              className={m.id === module ? 'module-live' : 'module-live module-hidden'}
              aria-hidden={m.id !== module}
            >
              {m.id === 'learn' && <LearnModule onOpenAi={openAiWith} />}
              {m.id === 'wiki' && (
                <WikiModule onOpenAi={openAiWith} bumpAi={() => setAiVersion((v) => v + 1)} />
              )}
              {m.id === 'inspirations' && <InspirationsModule onOpenAi={openAiWith} />}
              {m.id === 'zhijiji' && (
                <ZhijijiModule onNavigateToProfile={() => activateModule('profile')} />
              )}
              {m.id === 'reasoning' && <ReasoningModule />}
              {m.id === 'wenbi' && (
                <WenbiModule onOpenAi={openAiWith} bumpAi={() => setAiVersion((v) => v + 1)} />
              )}
              {m.id === 'bookshelf' && <BookshelfModule />}
              {m.id === 'favorites' && <FavoritesModule />}
              {m.id === 'feed' && <FeedModule onNavigateToProfile={() => activateModule('profile')} />}
              {m.id === 'ledger' && <LedgerModule />}
              {m.id === 'recycle' && <RecycleModule />}
              {m.id === 'profile' && <ProfileModule />}
            </div>
          ))}
          {/* 白噪音混音器页（不 keep-alive：引擎在组件外，页面卸载播放不断；specs §5.1） */}
          {module === 'noise' && <NoisePage />}
        </main>

        {/* 右侧边栏（右缘三面板互斥：debugzi 常驻挂载保持生成态，草稿本/画布按需挂载）；
            主题按钮仅三面板收起时显示于右下角（优化建议区第29轮：右栏展开时隐藏，治展开态通条不美观） */}
        <div className="right-col">
          <AiSidebar
            collapsed={rightPanel !== 'ai'}
            showRail={rightPanel === null}
            onExpand={() => switchRightPanel('ai')}
            onCollapse={() => switchRightPanel(null)}
            onOpenDraft={() => switchRightPanel('draft')}
            onOpenCanvas={() => switchRightPanel('canvas')}
            currentModule={module}
            pending={aiPending}
            onPendingConsumed={() => setAiPending(null)}
            messagesVersion={aiVersion}
            onNavigateToProfile={() => activateModule('profile')}
          />
          {rightPanel === 'draft' && (
            <DraftSidebar onCollapse={() => switchRightPanel(null)} turtleGame={turtleGame} />
          )}
          {rightPanel === 'canvas' && <CanvasSidebar onCollapse={() => switchRightPanel(null)} />}
          {/* AI 实时活动指示（第31轮反馈修订：自左栏底部迁来右下角主题按钮上方——左栏留给未来新模块；
              同主题按钮规则：三面板任一展开即不渲染，收起态才显示；空闲（无在途调用）也不渲染） */}
          {rightPanel === null && <LlmActivity />}
          {/* 终端呼出/收起（260912 新功能开发区）：白噪音快捷按钮上方，显隐同款（三面板收起） */}
          {rightPanel === null && (
            <button
              className="right-col-terminal"
              onClick={() => setTerminalOpen((o) => !o)}
              title={terminalOpen ? '收起终端 (Ctrl+J)' : '打开终端 (Ctrl+J)'}
            >
              <span className="material-symbols-outlined">terminal</span>
            </button>
          )}
          {/* 白噪音快捷播放/暂停（260911 新功能开发区）：主题按钮上方，显隐同款（三面板收起）；
              点击 toggle，播放中图标主题色高亮（同左栏入口） */}
          {rightPanel === null && (
            <button
              className="right-col-noise"
              onClick={() => void noiseEngine.toggle().catch(() => toast('音频初始化失败'))}
              title={`白噪音 · ${noiseSceneLabel} · ${noisePlaying ? '播放中，点击暂停' : '已暂停，点击播放'}`}
            >
              <span className={`material-symbols-outlined${noisePlaying ? ' noise-playing' : ''}`}>
                graphic_eq
              </span>
            </button>
          )}
          {rightPanel === null && (
            <button
              className="right-col-theme"
              onClick={toggleTheme}
              title={theme === 'light' ? '切到深色' : '切到浅色'}
            >
              <span className="material-symbols-outlined">{theme === 'light' ? 'dark_mode' : 'light_mode'}</span>
            </button>
          )}
          </div>
          </div>

          {/* 内置终端底部面板（常驻挂载；open=false 仅 display:none，进程不死） */}
          <TerminalPanel
            open={terminalOpen}
            theme={theme}
            fontSize={Number(settings[SettingsKeys.FontSize] ?? 16)}
            newTabSignal={terminalNewTabSignal}
            onClose={() => setTerminalOpen(false)}
            onAskAi={(prefill) => openAiWith(prefill, { channel: 'assistant' })}
          />
        </div>
      </div>

      {/* 首次启动引导（个人中心 specs §4） */}
      <WelcomeGuide open={firstLaunch} onDone={setFirstLaunchDone} onGoProfile={() => activateModule('profile')} />
    </>
  )
}
