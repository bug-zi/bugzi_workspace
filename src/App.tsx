// 三栏布局 + 模块路由（样式 specs §3）
import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ThemeProvider, useAppSettings } from './theme/ThemeProvider'
import { registerCustomFontFaces } from './theme/customFonts'
import { ToastProvider } from './components/Toast'
import AiSidebar from './components/AiSidebar'
import DraftSidebar from './components/DraftSidebar'
import CanvasSidebar from './components/CanvasSidebar'
import FileExplorerSidebar from './components/FileExplorerSidebar'
import OverviewModule from './modules/zonglan/OverviewModule'
import LearnModule from './modules/learn/LearnModule'
import WikiModule from './modules/wiki/WikiModule'
import InspirationsModule from './modules/inspirations/InspirationsModule'
import ZhijijiModule from './modules/zhijiji/ZhijijiModule'
import AnswersModule from './modules/answers/AnswersModule'
import ReasoningModule from './modules/reasoning/ReasoningModule'
import WenbiModule from './modules/wenbi/WenbiModule'
import ZangyueModule from './modules/zangyue/ZangyueModule'
import FavoritesModule from './modules/favorites/FavoritesModule'
import FeedModule from './modules/feed/FeedModule'
import LiteratureModule from './modules/literature/LiteratureModule'
import PodcastModule from './modules/podcast/PodcastModule'
import FushiModule from './modules/fushi/FushiModule'
import FubenModule from './modules/fuben/FubenModule'
import LedgerModule from './modules/ledger/LedgerModule'
import YuleModule from './modules/yule/YuleModule'
import RecycleModule from './modules/recycle/RecycleModule'
import ProfileModule from './modules/profile/ProfileModule'
import WelcomeGuide from './modules/profile/WelcomeGuide'
import NoisePage from './modules/noise/NoisePage'
import AgentCenterPage from './modules/agent/AgentCenterPage'
import AgentColdStartGuide from './modules/agent/AgentColdStartGuide'
import LlmActivity from './components/LlmActivity'
import TerminalPanel from './components/terminal/TerminalPanel'
import { noiseEngine } from './services/noiseEngine'
import { musicEngine } from './services/musicEngine'
import { activeAudioKind } from './services/audioExclusive'
import { sceneById } from './services/noiseScenes'
import { useToast } from './components/Toast'
import { SettingsKeys, TURTLE_GAME_EVENT } from './shared/types'
import type { AiChannel, ModuleId, ModuleMode } from './shared/types'
import './App.css'

// 左栏模块顺序（260924 侧边栏新布局：三段式——top 上固定 / learn|life 模式区 / bottom 下固定，
// 渲染顺序 = top → 当前模式区 → bottom，各组内保持数组相对顺序；设计正本 docs/project/全局/2026-09-24-侧边栏新布局-design.md）
// 拆分新模块：literature 论文库（自信息源）/ answers 答疑店（问答|辩真|预言家）/ favorites 收藏夹（自图书馆）
// 归属变化：文笔坊升常驻(top)、致知己 life→learn、灵感泉留生活区（顶替已删除的惊喜林规划）
// pending 占位：无（播客台/副本库/赋诗苑/娱乐城 260925 全部转正；新占位出现时在此注记）
const MODULES: {
  id: ModuleId
  label: string
  icon: string
  seg: 'top' | 'learn' | 'life' | 'bottom'
  pending?: true
}[] = [
  // —— 上固定 ——
  { id: 'zonglan', label: '总导览', icon: 'space_dashboard', seg: 'top' },
  { id: 'wenbi', label: '文笔坊', icon: 'history_edu', seg: 'top' },
  // —— 学习区 ——
  { id: 'learn', label: '学习库', icon: 'school', seg: 'learn' },
  { id: 'literature', label: '论文库', icon: 'library_books', seg: 'learn' },
  { id: 'wiki', label: '万象库', icon: 'public', seg: 'learn' },
  { id: 'feed', label: '信息源', icon: 'rss_feed', seg: 'learn' },
  { id: 'podcast', label: '播客台', icon: 'podcasts', seg: 'learn' },
  { id: 'answers', label: '答疑店', icon: 'forum', seg: 'learn' },
  { id: 'zhijiji', label: '致知己', icon: 'self_improvement', seg: 'learn' },
  // —— 生活区 ——
  { id: 'zangyue', label: '图书馆', icon: 'collections_bookmark', seg: 'life' },
  { id: 'fuben', label: '副本库', icon: 'sports_esports', seg: 'life' },
  { id: 'fushi', label: '赋诗苑', icon: 'auto_awesome', seg: 'life' },
  { id: 'reasoning', label: '推理角', icon: 'psychology', seg: 'life' },
  { id: 'yule', label: '娱乐城', icon: 'casino', seg: 'life' },
  { id: 'ledger', label: '记账本', icon: 'account_balance_wallet', seg: 'life' },
  { id: 'inspirations', label: '灵感泉', icon: 'lightbulb', seg: 'life' },
  // —— 下固定 ——
  { id: 'favorites', label: '收藏夹', icon: 'bookmarks', seg: 'bottom' },
  { id: 'recycle', label: '回收站', icon: 'delete', seg: 'bottom' },
  { id: 'profile', label: '个人档', icon: 'person', seg: 'bottom' }
]

/** 模块 → AI 边栏频道映射（频道制，致知己 specs §4）：其余模块默认助手频道；
 *  辩真阁已并入万象库，'verify' 频道由万象库辩真板块经 openAiWith 的 channel 覆盖直达；
 *  格言库已并入文笔坊，'motto' 频道由文笔坊格言面板显式传 channel 覆盖直达；
 *  学习库划词问 AI 直发弹窗拓展坞（'learn' 频道），不再经模块映射走右栏 */
const CHANNEL_BY_MODULE: Partial<Record<ModuleId, AiChannel>> = {
  wiki: 'wiki',
  zhijiji: 'zhijiji',
  podcast: 'podcast'
}

/** 主栏视图：十一模块 + 白噪音混音器页（不进左栏模块列表，入口在左栏底部控件；specs §5.1）
 *  + 任务中心页（2.0 批次C，呼吸灯点击进入，同临时视图先例） */
type MainView = ModuleId | 'noise' | 'agent'

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
// 模块深链导航事件（260912 总导览）：detail ModuleNavDetail——目标模块 useModuleNavigate 监听切内部视图
export const MODULE_NAVIGATE_EVENT = 'bugzi:module-navigate'

function Shell() {
  const { theme, toggleTheme, firstLaunch, setFirstLaunchDone, settings } = useAppSettings()
  const { toast } = useToast()
  const [module, setModule] = useState<MainView>('zonglan')
  // 当前模块 ref（失活事件需捕获旧模块 id；ref 方案防 strict-mode 双触发）
  const moduleRef = useRef<MainView>('zonglan')
  useEffect(() => {
    moduleRef.current = module
  }, [module])
  // 右缘四面板互斥展开（260916 资源管理器加入）：'ai'=debugzi | 'draft'=草稿本 | 'files'=资源管理器 | 'canvas'=画布 | null=都收起（右缘细条四图标入口）
  const [rightPanel, setRightPanel] = useState<'ai' | 'draft' | 'files' | 'canvas' | null>('ai')
  const [aiPending, setAiPending] = useState<{ text: string; channel: AiChannel; auto: boolean } | null>(null)
  const [aiVersion, setAiVersion] = useState(0)
  const [aiForceOpen, setAiForceOpen] = useState(false)
  // 海龟汤对局上下文（TurtlePanel 进出对局派发；草稿本据此切频道 + 新建以汤名命名，App 持有保证面板收起时不丢）
  const [turtleGame, setTurtleGame] = useState<{ title: string } | null>(null)
  // 内置终端（260912）：open 默认收起（pty 不跨重启）；Ctrl+J 呼出/收起、Ctrl+Shift+J 新建标签
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalNewTabSignal, setTerminalNewTabSignal] = useState(0)
  // 学习/生活双模式（优化建议区 260922）：当前模式；启动经下方 effect 恢复（主栏仍固定落总导览）
  const [appMode, setAppMode] = useState<ModuleMode>('learn')

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
      else if (v === 'files') setRightPanel('files')
      else if (v === '') setRightPanel(null)
      else setRightPanel('ai')
    })
  }, [])

  // 双模式恢复（优化建议区 260922）：左栏按上次模式过滤；主栏仍固定落总导览（现状不变）
  useEffect(() => {
    void window.api.settings.get(SettingsKeys.AppMode).then((v) => {
      if (v === 'life') setAppMode('life')
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

  // 轻音乐启动恢复（音乐吧设计 §五）：只灌参数不播放——重启默认暂停
  useEffect(() => {
    void window.api.settings.get(SettingsKeys.MusicState).then((raw) => {
      if (!raw) return
      try {
        musicEngine.loadPersisted(JSON.parse(raw) as { trackId?: number; loopMode?: string; volume?: number })
      } catch {
        /* 坏数据静默容错 */
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

  // 导入字体注册（优化建议区第46轮）：全局字体设置为导入字体时重启即生效
  useEffect(() => {
    void registerCustomFontFaces()
  }, [])

  const switchRightPanel = useCallback((p: 'ai' | 'draft' | 'files' | 'canvas' | null): void => {
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

  // 视图所属模式（双模式）：'agent'（任务中心）视为学习专属，'noise'（音乐吧）常驻，
  // 其余按 MODULES 段位映射（top/bottom=常驻，learn/life 同名）
  const modeOfView = useCallback((id: MainView): 'learn' | 'life' | 'common' => {
    if (id === 'agent') return 'learn'
    if (id === 'noise') return 'common'
    const seg = MODULES.find((m) => m.id === id)?.seg
    return seg === 'learn' ? 'learn' : seg === 'life' ? 'life' : 'common'
  }, [])

  // 模式 last 专属模块记录（双模式）：仅专属模块记账，常驻（总导览/音乐吧/回收站/个人档）不记——
  // 切走再切回 = 回到该模式上次工作现场
  useEffect(() => {
    const m = modeOfView(module)
    if (m === 'common') return
    void window.api.settings.set(m === 'learn' ? SettingsKeys.ModeLastLearn : SettingsKeys.ModeLastLife, module)
  }, [module, modeOfView])

  // 模式切换（双模式）：写 app_mode → 主栏落到 landTo（深链等显式指定）或目标模式 last 专属模块（无记录落总导览）。
  // landTo 必须同步 activateModule——不能走异步 get 回来再切，否则会晚于调用方的 activateModule 把主栏抢走
  const switchMode = useCallback(
    (next: ModuleMode, landTo?: MainView): void => {
      setAppMode(next)
      void window.api.settings.set(SettingsKeys.AppMode, next)
      if (landTo) {
        activateModule(landTo)
        return
      }
      void window.api.settings
        .get(next === 'learn' ? SettingsKeys.ModeLastLearn : SettingsKeys.ModeLastLife)
        .then((v) => activateModule((v || 'zonglan') as MainView))
    },
    [activateModule]
  )

  // 深链集中切换（260915 优化区：原仅总导览 onNavigate；现在任何常驻模块都可派发事件跳转，
  // 如学习库深挖完成后轻提示点击跨模块跳回）：目标模块内部视图由其 useModuleNavigate 自行处理；
  // 双模式（260922）：目标模块不在当前模式时自动切到目标模式——深链是明确意图，模式跟着走
  // （回收站恢复跳转同规则）；landTo 显式传深链目标，防异步 last 落点抢走深链跳转
  useEffect(() => {
    const onNav = (e: Event): void => {
      const detail = (e as CustomEvent<{ module: ModuleId }>).detail
      if (!detail || !detail.module) return
      const target = modeOfView(detail.module)
      if (target !== 'common' && target !== appMode) {
        switchMode(target, detail.module)
        return
      }
      activateModule(detail.module)
    }
    window.addEventListener(MODULE_NAVIGATE_EVENT, onNav)
    return () => window.removeEventListener(MODULE_NAVIGATE_EVENT, onNav)
  }, [activateModule, appMode, switchMode, modeOfView])

  // 任务中心直达（2.0 批次C；260924 左栏工作台入口删除，直达逻辑抽为 openAgentCenter——
  // 总导览聚合块事件与个人档「打开任务中心」入口共用）：'agent' 学习专属，生活模式自动切回
  const openAgentCenter = useCallback((): void => {
    if (appMode === 'life') switchMode('learn', 'agent')
    else activateModule('agent')
  }, [appMode, activateModule, switchMode])

  useEffect(() => {
    const onOpenAgent = (): void => openAgentCenter()
    window.addEventListener('bugzi:open-agent-center', onOpenAgent)
    return () => window.removeEventListener('bugzi:open-agent-center', onOpenAgent)
  }, [openAgentCenter])

  // 冷启动向导（2.0 批次C）：升级用户首启弹一次（首装走 WelcomeGuide 不叠加）；完成/跳过后不再弹
  const [coldStartOpen, setColdStartOpen] = useState(false)
  useEffect(() => {
    if (firstLaunch) return
    void window.api.settings.get(SettingsKeys.AgentColdStartDone).then((v) => {
      if (!v) setColdStartOpen(true)
    })
  }, [firstLaunch])

  // 模块请求展开 AI 边栏（频道制：按当前模块映射频道；opts.channel 显式覆盖——万象库辩真板块直连核查频道；
  // opts.auto 时切频道后自动发送）
  const openAiWith = useCallback(
    (prefill?: string, opts?: { auto?: boolean; channel?: AiChannel }) => {
      switchRightPanel('ai')
      setAiForceOpen((v) => !v)
      setAiPending({
        text: prefill ?? '',
        channel:
          opts?.channel ??
          (module !== 'noise' && module !== 'agent' ? CHANNEL_BY_MODULE[module] : undefined) ??
          'assistant',
        auto: opts?.auto ?? false
      })
    },
    [module, switchRightPanel]
  )

  // 问 AI / 验证过程推送 → messagesVersion 递增通知 AiSidebar 重载
  useEffect(() => {
    if (!aiForceOpen) return
  }, [aiForceOpen])

  // 音源播放态（双引擎版本号驱动：左栏/右栏图标与页面播放按钮同步）
  useSyncExternalStore(noiseEngine.subscribe, noiseEngine.getSnapshot)
  useSyncExternalStore(musicEngine.subscribe, musicEngine.getSnapshot)
  const noisePlaying = noiseEngine.isPlaying()
  const musicPlaying = musicEngine.isPlaying()
  const noiseSceneLabel = sceneById(noiseEngine.getState().sceneId)?.label ?? ''
  // 活跃音源口径：谁在播控谁；都停着控上次音源（从未播过默认白噪音）
  const activeKind = noisePlaying ? 'noise' : musicPlaying ? 'music' : activeAudioKind()
  const anyPlaying = noisePlaying || musicPlaying

  // 左栏列表项（三段公用）：占位项置灰仅提示待建；下固定段在回收站位前注入音乐吧
  const renderNavItem = (m: (typeof MODULES)[number]) => {
    if (m.pending) {
      return (
        <button
          key={m.id}
          className="nav-item pending"
          title={`${m.label} · 待建`}
          onClick={() => toast(`「${m.label}」待建，敬请期待`)}
        >
          <span className="material-symbols-outlined">{m.icon}</span>
          <span className="nav-label">{m.label}</span>
        </button>
      )
    }
    return (
      <Fragment key={m.id}>
        {m.id === 'recycle' && (
          <button
            className={`nav-item noise-control${module === 'noise' ? ' active' : ''}`}
            onClick={() => activateModule('noise')}
            title={
              noisePlaying
                ? '白噪音播放中 · 点击打开音乐吧'
                : musicPlaying
                  ? '轻音乐播放中 · 点击打开音乐吧'
                  : '打开音乐吧'
            }
          >
            <span className={`material-symbols-outlined${anyPlaying ? ' noise-playing' : ''}`}>
              graphic_eq
            </span>
            <span className="nav-label">音乐吧</span>
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
    )
  }

  return (
    <>
      <div className="app-bg" />
      <div className="app-shell">
        {/* 左侧边栏（260924 三段式：top 上固定 → 当前模式区 → bottom 下固定；音乐吧为下固定列表项，
            在回收站位前注入；占位项置灰点击提示；个人档图标挂工作台呼吸灯——入口已迁入个人档页） */}
        <nav className="sidebar">
          {MODULES.filter((m) => m.seg === 'top').map(renderNavItem)}
          {MODULES.filter((m) => m.seg === appMode).map(renderNavItem)}
          {MODULES.filter((m) => m.seg === 'bottom').map(renderNavItem)}
          <div className="sidebar-spacer" />
        </nav>

        {/* 中栏 + 右栏 + 底部终端面板纵向容器（260912 内置终端）：左栏不参与，保持完整可见 */}
        <div className="app-body">
          <div className="app-body-row">
            {/* 中间主栏（keep-alive：模块切换仅隐藏不卸载，AI 生成任务不因切页中断——问题疑惑区万象库#A） */}
            <main className="main-area">
          {MODULES.filter((m) => !m.pending).map((m) => (
            <div
              key={m.id}
              className={m.id === module ? 'module-live' : 'module-live module-hidden'}
              aria-hidden={m.id !== module}
            >
              {m.id === 'zonglan' && <OverviewModule mode={appMode} />}
              {m.id === 'learn' && <LearnModule />}
              {m.id === 'wiki' && (
                <WikiModule onOpenAi={openAiWith} bumpAi={() => setAiVersion((v) => v + 1)} />
              )}
              {m.id === 'inspirations' && <InspirationsModule onOpenAi={openAiWith} />}
              {m.id === 'zhijiji' && (
                <ZhijijiModule
                  onNavigateToProfile={() => activateModule('profile')}
                  onOpenAi={openAiWith}
                  bumpAi={() => setAiVersion((v) => v + 1)}
                />
              )}
              {m.id === 'answers' && (
                <AnswersModule
                  onOpenAi={openAiWith}
                  bumpAi={() => setAiVersion((v) => v + 1)}
                  onNavigateToProfile={() => activateModule('profile')}
                />
              )}
              {m.id === 'reasoning' && <ReasoningModule />}
              {m.id === 'fuben' && <FubenModule />}
              {m.id === 'wenbi' && (
                <WenbiModule onOpenAi={openAiWith} bumpAi={() => setAiVersion((v) => v + 1)} />
              )}
              {m.id === 'zangyue' && <ZangyueModule />}
              {m.id === 'favorites' && <FavoritesModule />}
              {m.id === 'feed' && <FeedModule onNavigateToProfile={() => activateModule('profile')} />}
              {m.id === 'literature' && <LiteratureModule onOpenAi={openAiWith} />}
              {m.id === 'podcast' && (
                <PodcastModule
                  onOpenAi={openAiWith}
                  onNavigateToProfile={() => activateModule('profile')}
                />
              )}
              {m.id === 'ledger' && <LedgerModule />}
              {m.id === 'yule' && <YuleModule />}
              {m.id === 'fushi' && <FushiModule />}
              {m.id === 'recycle' && <RecycleModule />}
              {m.id === 'profile' && <ProfileModule onOpenWorkspace={openAgentCenter} />}
            </div>
          ))}
          {/* 白噪音混音器页（不 keep-alive：引擎在组件外，页面卸载播放不断；specs §5.1） */}
          {module === 'noise' && <NoisePage />}
          {/* 任务中心页（2.0 批次C：同临时视图先例，不 keep-alive） */}
          {module === 'agent' && <AgentCenterPage />}
        </main>

        {/* 右侧边栏（右缘四面板互斥：debugzi 常驻挂载保持生成态，草稿本/资源管理器/画布按需挂载）；
            主题按钮仅四面板收起时显示于右下角（优化建议区第29轮：右栏展开时隐藏，治展开态通条不美观） */}
        <div className="right-col">
          <AiSidebar
            collapsed={rightPanel !== 'ai'}
            showRail={rightPanel === null}
            onExpand={() => switchRightPanel('ai')}
            onCollapse={() => switchRightPanel(null)}
            onOpenDraft={() => switchRightPanel('draft')}
            onOpenFiles={() => switchRightPanel('files')}
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
          {rightPanel === 'files' && (
            <FileExplorerSidebar onCollapse={() => switchRightPanel(null)} />
          )}
          {rightPanel === 'canvas' && <CanvasSidebar onCollapse={() => switchRightPanel(null)} />}
          {/* AI 实时活动指示（第31轮反馈修订：自左栏底部迁来右下角主题按钮上方——左栏留给未来新模块；
              同主题按钮规则：四面板任一展开即不渲染，收起态才显示；空闲（无在途调用）也不渲染） */}
          {rightPanel === null && <LlmActivity />}
          {/* 终端呼出/收起（260912 新功能开发区）：白噪音快捷按钮上方，显隐同款（四面板收起） */}
          {rightPanel === null && (
            <button
              className="right-col-terminal"
              onClick={() => setTerminalOpen((o) => !o)}
              title={terminalOpen ? '收起终端 (Ctrl+J)' : '打开终端 (Ctrl+J)'}
            >
              <span className="material-symbols-outlined">terminal</span>
            </button>
          )}
          {/* 音源快捷播放/暂停（260911 新功能开发区；260915 改活跃音源口径）：主题按钮上方，显隐同款（四面板收起） */}
          {rightPanel === null && (
            <button
              className="right-col-noise"
              onClick={() => {
                if (activeKind === 'music') void musicEngine.toggle()
                else void noiseEngine.toggle().catch(() => toast('音频初始化失败'))
              }}
              title={
                activeKind === 'music'
                  ? `轻音乐 · ${musicPlaying ? '播放中，点击暂停' : '已暂停，点击播放'}`
                  : `白噪音 · ${noiseSceneLabel} · ${noisePlaying ? '播放中，点击暂停' : '已暂停，点击播放'}`
              }
            >
              <span className={`material-symbols-outlined${anyPlaying ? ' noise-playing' : ''}`}>
                {activeKind === 'music' ? 'music_note' : 'graphic_eq'}
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
          {/* 模式切换（优化建议区 260922 双模式）：右下角最底位（原主题按钮位），其余按钮上移一位；
              单按钮往返，图标=将切去的模式（与主题按钮「显示目标」约定一致）；显隐同主题按钮（四面板收起态） */}
          {rightPanel === null && (
            <button
              className="right-col-mode"
              onClick={() => switchMode(appMode === 'learn' ? 'life' : 'learn')}
              title={appMode === 'learn' ? '切换到生活模式' : '切换到学习模式'}
            >
              <span className="material-symbols-outlined">{appMode === 'learn' ? 'home' : 'school'}</span>
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
      {coldStartOpen && <AgentColdStartGuide onDone={() => setColdStartOpen(false)} />}
    </>
  )
}
