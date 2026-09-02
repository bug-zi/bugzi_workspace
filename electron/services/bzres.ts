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
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/** app ready 后调用 */
export function registerBzresProtocol(): void {
  protocol.handle(BZRES_SCHEME, (request) => {
    const url = new URL(request.url)
    // bzres://bg/bg-light → userData/bg/bg-light（standard scheme：host 为第一段路径）
    const host = url.hostname === 'localhost' ? '' : url.hostname
    const rel = (host ? host + '/' : '') + url.pathname.replace(/^\/+/, '')
    const parts = decodeURIComponent(rel)
      .replace(/\\/g, '/')
      .split('/')
      .filter((p) => p && p !== '.' && p !== '..')
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
