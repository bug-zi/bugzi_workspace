// 托盘常驻：左键/菜单显示主窗口；菜单含开机自启勾选（读 settings 实时态）与退出
import { Tray, Menu, app } from 'electron'
import { getSetting, setSetting } from '../db/settings'
import { SettingsKeys } from '../../src/shared/types'

let tray: Tray | null = null
let showMain: () => void = () => {}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMain() },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: getSetting(SettingsKeys.LaunchOnBoot) === '1',
      click: (item) => {
        setSetting(SettingsKeys.LaunchOnBoot, item.checked ? '1' : '0')
        app.setLoginItemSettings({ openAtLogin: item.checked })
        refreshTrayMenu()
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
}

export function createTray(iconPath: string, onShow: () => void): void {
  showMain = onShow
  tray = new Tray(iconPath)
  tray.setToolTip("bugzi's workspace")
  refreshTrayMenu()
  tray.on('click', () => showMain())
}

/** 勾选态变化后重建菜单（个人档/托盘两处入口都会触发） */
export function refreshTrayMenu(): void {
  if (tray) tray.setContextMenu(buildMenu())
}
