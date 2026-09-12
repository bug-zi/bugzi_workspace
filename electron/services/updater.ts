// 更新服务（个人档「版本与更新」）：electron-updater 状态机封装，状态全内存、不落库不落 settings。
// 自动化策略（260913 设计定稿）：启动静默检查一次仅提示；下载/安装由用户在个人档手动触发。
import { app, type BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { UpdateCheckResult, UpdateSnapshot } from '../../src/shared/types'

let getWin: () => BrowserWindow | null = () => null
let snapshot: UpdateSnapshot = {
  currentVersion: app.getVersion(),
  phase: 'idle',
  availableVersion: null,
  releaseDate: null,
  percent: 0,
  notice: null
}
let inited = false
/** 并发检查去重：启动静默检查与手动检查共用同一 in-flight Promise */
let checkingPromise: Promise<UpdateCheckResult> | null = null

/** 三段数字版本号比较：remote 更大返回 true（版本号自控，无预发布段） */
function isNewer(remote: string, current: string): boolean {
  const a = remote.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

function push(): void {
  getWin()?.webContents.send('app:updateEvent', snapshot)
}

function setPhase(phase: UpdateSnapshot['phase'], extra?: Partial<UpdateSnapshot>): void {
  snapshot = { ...snapshot, phase, ...extra }
  push()
}

export function initUpdater(winGetter: () => BrowserWindow | null): void {
  getWin = winGetter
  // dev 模式无 app-update.yml，checkForUpdates 必抛：直接置 disabled（UI 点检查 toast「开发模式下不可用」）
  if (!app.isPackaged) {
    snapshot = { ...snapshot, phase: 'disabled' }
    push()
    return
  }
  if (inited) return
  inited = true
  // 一切显式控制：不自动下载、退出不自动装（退出自动装在托盘关闭行为下易意外，设计否决）
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // electron-updater 6.x 未暴露 requestTimeout（默认超时即可）；国内波动由检查静默/回退、下载可重试兜底
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    setPhase('available', { availableVersion: info.version, releaseDate: info.releaseDate, percent: 0 })
  })
  autoUpdater.on('update-not-available', () => setPhase('idle'))
  autoUpdater.on('download-progress', (p: { percent: number }) => {
    setPhase('downloading', { percent: Math.min(100, Math.round(p.percent)) })
  })
  autoUpdater.on('update-downloaded', () => setPhase('downloaded', { percent: 100 }))
  autoUpdater.on('error', () => {
    // 检查失败回 idle；下载失败回 available 可重试（blockmap 差量续传）
    if (snapshot.phase === 'checking') setPhase('idle')
    else if (snapshot.phase === 'downloading') setPhase('available', { percent: 0 })
  })
  // 启动静默检查：错开启动高峰；发现新版置一次性 notice，任何失败静默（首个 Release 发布前 404 同静默）
  setTimeout(() => {
    void checkForUpdates()
      .then((r) => {
        if (r.status === 'available') {
          snapshot = { ...snapshot, notice: `发现新版本 v${r.version}` }
          push()
        }
      })
      .catch(() => {})
  }, 5_000).unref()
}

export function getUpdateState(): UpdateSnapshot {
  return snapshot
}

/** 检查更新（手动按钮与启动静默检查共用；并发去重） */
export function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) return Promise.resolve({ status: 'disabled' })
  if (checkingPromise) return checkingPromise
  setPhase('checking')
  checkingPromise = (async () => {
    try {
      const r = await autoUpdater.checkForUpdates()
      const info = r?.updateInfo
      // update-not-available 时 updateInfo 为远端（≤当前）版本：isNewer 判否即「已最新」
      if (info && isNewer(info.version, app.getVersion())) {
        return { status: 'available' as const, version: info.version, releaseDate: info.releaseDate }
      }
      return { status: 'up-to-date' as const }
    } catch {
      return { status: 'error' as const }
    } finally {
      checkingPromise = null
    }
  })()
  return checkingPromise
}

/** 开始下载（仅 available 态受理）；进度/失败经事件推送，无取消（设计决策：失败回 available 可重试） */
export function downloadUpdate(): void {
  if (snapshot.phase !== 'available') return
  setPhase('downloading', { percent: 0 })
  void autoUpdater.downloadUpdate().catch(() => {
    if (snapshot.phase === 'downloading') setPhase('available', { percent: 0 })
  })
}

/** 重启并安装（仅 downloaded 态受理）：静默安装 + 装完自动重启。
 *  退出链路：quitAndInstall → app.quit() → before-quit（main.ts 置 quitting=true）→ close 拦截放行，托盘模式零改动兼容 */
export function installUpdate(): void {
  if (snapshot.phase !== 'downloaded') return
  autoUpdater.quitAndInstall(true, true)
}
