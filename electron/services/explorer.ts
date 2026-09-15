// 资源管理器服务（主进程，260916 新功能开发区）：右栏第四面板的只读浏览后端。
// 只读三通道：读目录（单层懒加载）/ 读文本 / 读图片；root 逐调用显式传入，
// 所有路径 resolve 后必须位于 root 内，防渲染层越权读盘。无 DB 无落盘。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'

/** 文本预览上限：1MB */
export const TEXT_MAX_BYTES = 1024 * 1024
/** 图片预览上限：5MB */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024

export interface ExplorerEntry {
  name: string
  path: string
  type: 'file' | 'dir'
}

/** 越权校验：p 经 resolve 后必须位于 root 内（root 自身放行） */
function assertUnderRoot(root: string, p: string): string {
  const r = resolve(root)
  const abs = resolve(p)
  if (abs !== r && !abs.startsWith(r + sep)) throw new Error('PATH_OUT_OF_ROOT')
  return abs
}

/** 读单层目录（懒加载不递归；不排序——排序口径在渲染层） */
export function readExplorerDir(root: string, dirPath: string): ExplorerEntry[] {
  const abs = assertUnderRoot(root, dirPath)
  return readdirSync(abs, { withFileTypes: true }).map((d) => ({
    name: d.name,
    path: resolve(abs, d.name),
    type: d.isDirectory() ? ('dir' as const) : ('file' as const)
  }))
}

/** 读文本（utf-8）：超 1MB 抛 TOO_LARGE；含 null byte 判二进制抛 BINARY */
export function readExplorerText(root: string, filePath: string): string {
  const abs = assertUnderRoot(root, filePath)
  const stat = statSync(abs)
  if (stat.isDirectory()) throw new Error('IS_DIR')
  if (stat.size > TEXT_MAX_BYTES) throw new Error('TOO_LARGE')
  const buf = readFileSync(abs)
  if (buf.includes(0)) throw new Error('BINARY')
  return buf.toString('utf-8')
}

/** 读图片 → data URL（base64）：超 5MB 抛 TOO_LARGE */
export function readExplorerImage(root: string, filePath: string): string {
  const abs = assertUnderRoot(root, filePath)
  if (statSync(abs).size > IMAGE_MAX_BYTES) throw new Error('TOO_LARGE')
  const ext = extname(abs).slice(1).toLowerCase()
  const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
  return `data:${mime};base64,${readFileSync(abs).toString('base64')}`
}
