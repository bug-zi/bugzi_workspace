import { BrowserWindow } from 'electron'

// 主进程轻提示通道（notify:toast）：后台生成完成后由渲染层弹 toast——
// 格言启动生成（优化建议区第60轮）首用；LLM 调用本身已入 AI 调用面板，此处只补完成轻提示
export function notifyToast(text: string): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send('notify:toast', { text })
}
