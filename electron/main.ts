// 主进程入口：窗口创建、协议注册、IPC 注册、定时任务
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { initDb } from './db/db'
import { registerBzresProtocol, registerBzresSchemes } from './services/bzres'
import { registerIpc } from './ipc'
import { startSchedulers } from './services/scheduler'
import { backfillTrickNotes } from './ai/services'
import { applyDataDirAtStartup } from './services/storage'

// 确保作为打包应用运行时仍能 require 到依赖（Electron 打包场景，esm 兼容）
if (process.env.NODE_ENV === 'production' && !process.versions.electron) {
  // no-op：esm 打包由 electron-vite 处理
}

// 应用图标（优化建议区：resources/app.png）。dev 从项目根取；打包态预留 extraResources 路径
const appIcon = app.isPackaged
  ? join(process.resourcesPath, 'app.png')
  : join(__dirname, '../../resources/app.png')

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
      w.focus()
    }
  })

  void app.whenReady().then(() => {
    registerBzresProtocol()
    initDb()
    registerIpc()
    startSchedulers()
    // 存量汤诡计摘要一次性回填（海龟汤质量优化 spec）：错开启动高峰，失败静默（内部自 catch）
    setTimeout(() => void backfillTrickNotes(), 10_000).unref()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
