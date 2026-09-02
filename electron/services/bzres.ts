// 安全资源协议 bzres://：渲染进程安全引用 userData 下的图片（背景图/头像）
import { protocol } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { userDataDir } from '../db/db'

export const BZRES_SCHEME = 'bzres'

/** 必须在 app ready 之前调用（registerSchemesAsPrivileged 约束） */
export function registerBzresSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: BZRES_SCHEME,
      // corsEnabled：dev 下页面源是 http://localhost:5173，fetch(bzres://) 属跨源请求，
      // 不加此特权 Chromium 直接拒（IMG 标签不受限但 ThemeProvider 用 fetch 探测 404）
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
    }
  ])
}

/** app ready 后调用 */
export function registerBzresProtocol(): void {
  protocol.handle(BZRES_SCHEME, (request) => {
    const url = new URL(request.url)
    // bzres:// 无真实主机，host 仅作命名空间（root=userData 根，bg=背景图目录），不映射为磁盘目录。
    // bzres://root/avatar.png → userData/avatar.png；bzres://bg/bg-light.png → userData/bg/bg-light.png
    const host = url.hostname
    const pathPart = url.pathname.replace(/^\/+/, '')
    const raw =
      host === 'bg'
        ? 'bg/' + pathPart
        : host === 'root' || host === 'localhost' || host === ''
          ? pathPart
          : ''
    const parts = decodeURIComponent(raw)
      .replace(/\\/g, '/')
      .split('/')
      .filter((p) => p && p !== '.' && p !== '..')
    if (parts.length === 0) {
      return new Response('Forbidden', { status: 403 })
    }
    const abs = join(userDataDir(), ...parts)
    if (!abs.startsWith(userDataDir())) {
      return new Response('Forbidden', { status: 403 })
    }
    const ext = abs.split('.').pop()?.toLowerCase() ?? ''
    const mime =
      ext === 'png'
        ? 'image/png'
        : ext === 'jpg' || ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'webp'
            ? 'image/webp'
            : ext === 'gif'
              ? 'image/gif'
              : ext === 'bmp'
                ? 'image/bmp'
                : 'application/octet-stream'
    try {
      const data = readFileSync(abs)
      return new Response(data, { headers: { 'Content-Type': mime } })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}
