// 主进程入口：窗口创建、协议注册、IPC 注册、定时任务
import { app, BrowserWindow, session, shell } from 'electron'
import { join } from 'node:path'
import { initDb } from './db/db'
import { registerBzresProtocol, registerBzresSchemes } from './services/bzres'
import { registerIpc, settleTurtleTimers } from './ipc'
import { startSchedulers } from './services/scheduler'
import { backfillTrickNotes } from './ai/services'
import { ensureReasoningStock } from './services/reasoningStock'
import { ensureDailyLearn, ensureWikiStock } from './services/wikiStock'
import { ensureWikiQuizStock } from './services/wikiQuizStock'
import { ensureLearnStock } from './services/learnStock'
import { ensureInterviewDaily } from './services/interviewBank'
import { ensureWhoamiDaily } from './services/whoami'
import { applyDataDirAtStartup } from './services/storage'
import { killAllTerminals } from './services/terminal'
import './services/agent/bootstrap'
import { startAgent } from './services/agent/engine'
import { createTray } from './services/tray'
import { initUpdater } from './services/updater'
import { getSetting } from './db/settings'
import { SettingsKeys } from '../src/shared/types'

// userData 钉回 %APPDATA%\bugzi_workspace（dev 同款）：打包态 productName 变化会导致默认 userData 分裂、
// 已有数据"消失"。必须先于单实例锁（锁文件在 userData）与 applyDataDirAtStartup（读 userData 下 data_home.json）
app.setName('bugzi_workspace')
app.setPath('userData', join(app.getPath('appData'), 'bugzi_workspace'))

// 应用图标（优化建议区：resources/app.png）。dev 从项目根取；打包态预留 extraResources 路径
const appIcon = app.isPackaged
  ? join(process.resourcesPath, 'app.png')
  : join(__dirname, '../../resources/app.png')

// 托盘「退出」走 app.quit() → 窗口 close 事件：quitting 放行真正销毁；平时点 × 仅隐藏
let quitting = false

function createWindow(): void {
  const win = new BrowserWindow({
    title: "bugzi's workspace",
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // preload 需要部分 node 能力做类型化桥（仍不开 nodeIntegration）
    },
    icon: appIcon
  })

  win.on('ready-to-show', () => win.show())

  // 点 × 默认隐藏到托盘（settings close_action='exit' 时才真退出）；quitting 标志放行托盘「退出」路径
  win.on('close', (e) => {
    if (!quitting && getSetting(SettingsKeys.CloseAction) !== 'exit') {
      e.preventDefault()
      win.hide()
    }
  })

  // 外部链接一律系统浏览器打开（辩真阁来源链接等）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 单实例锁（避免 userData 锁冲突）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // 必须在 app ready 之前注册特权 scheme（bzres:// 头像/背景图）
  registerBzresSchemes()
  // 数据目录切换（优化建议区 #2）：默认 D 盘，data_home.json 指针支持自定义；须在 ready 前 setPath
  applyDataDirAtStartup()

  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows()
    if (wins.length > 0) {
      const w = wins[0]
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }
  })

  void app.whenReady().then(() => {
    registerBzresProtocol()
    initDb()
    registerIpc()
    startSchedulers()
    // 少数派图片 CDN 空 Referer 防盗链（问题疑惑区第12轮）：cdnfile/cdn.sspai.com 对无 Referer 请求一律 403，
    // 而 RSSHub 全文 img 自带 referrerpolicy="no-referrer"、打包态页面源 file:// 本就不发 Referer，
    // 渲染层无法自救 → 网络层对少数派 CDN 请求统一补站点 Referer（dev/prod 双端生效）
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['https://cdnfile.sspai.com/*', 'https://cdn.sspai.com/*'] },
      (details, callback) => {
        if (!details.requestHeaders.Referer) details.requestHeaders.Referer = 'https://sspai.com/'
        callback({ requestHeaders: details.requestHeaders })
      }
    )
    // 超级工作台 2.0 引擎（自判 agent_enabled，关闭态零副作用待命）
    startAgent()
    // 存量汤诡计摘要一次性回填（海龟汤质量优化 spec）：错开启动高峰，失败静默（内部自 catch）
    setTimeout(() => void backfillTrickNotes(), 10_000).unref()
    // 推理角题库预生成泵（v1.3）：同样错开启动高峰；存量达标即 no-op，内部自 catch 永不抛错
    setTimeout(() => void ensureReasoningStock(), 10_000).unref()
    // 万象库待学习区（260910）：每日批次（5-10 张板块均摊，settings 幂等）+ 后库泵
    // （每板块 3 张池卡），同样错开启动高峰；静默失败，LLM 未配置跳过且不记日期
    setTimeout(() => {
      void ensureDailyLearn()
      void ensureWikiStock()
    }, 10_000).unref()
    // 学习库（260911→260924 面经题库化）：面经每日定档（learn_daily 所有权）+ 知识树备学池泵；
    // 静默失败，LLM 未配置跳过（定档纯 SQL 照常）
    setTimeout(() => {
      ensureInterviewDaily()
      void ensureLearnStock()
    }, 10_000).unref()
    // 万象库测一测题库泵（260916 题库制）：错开启动高峰，静默失败
    setTimeout(() => void ensureWikiQuizStock(), 10_000).unref()
    // 我是谁（260921）：每日 3-4 问（settings 幂等）；错开启动高峰，静默失败，LLM 未配置跳过
    setTimeout(() => void ensureWhoamiDaily(), 10_000).unref()
    createWindow()
    // 托盘常驻：图标复用 appIcon；启动时按 settings 应用开机自启（键缺省 = 关）
    createTray(appIcon, showMainWindow)
    app.setLoginItemSettings({ openAtLogin: getSetting(SettingsKeys.LaunchOnBoot) === '1' })
    // 应用内更新（个人档「版本与更新」）：启动静默检查在 updater.ts 内部错峰 5s 触发，失败静默
    initUpdater(() => BrowserWindow.getAllWindows()[0] ?? null)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

function showMainWindow(): void {
  const w = BrowserWindow.getAllWindows()[0]
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 海龟汤净用时退出兜底（优化建议区第26轮）+ 内置终端进程兜底（260912）：退出前杀光 shell，不留僵尸进程
app.on('before-quit', () => {
  quitting = true
  settleTurtleTimers()
  killAllTerminals()
})
