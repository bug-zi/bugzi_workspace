// md 文件读写服务（主进程）：所有 md 路径均为相对 userData 的正斜杠路径，如 md/mottos/3.md
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { userDataDir } from '../db/db'

/** 相对路径 → 绝对路径（限定在 userData 内，防越界） */
export function resolveUnderUserData(relPath: string): string {
  const root = resolve(userDataDir())
  const abs = resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + '\\') && !abs.startsWith(root + '/')) {
    throw new Error('PATH_OUT_OF_USERDATA')
  }
  return abs
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

export function mdRead(relPath: string): string {
  return readFileSync(resolveUnderUserData(relPath), 'utf-8')
}

export function mdWrite(relPath: string, content: string): void {
  const abs = resolveUnderUserData(relPath)
  ensureDir(dirname(abs))
  writeFileSync(abs, content, 'utf-8')
}

export function mdDelete(relPath: string | null | undefined): void {
  if (!relPath) return
  try {
    unlinkSync(resolveUnderUserData(relPath))
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/** 创建新 md 文件（若已存在则不覆盖） */
export function mdCreate(relPath: string, content: string): void {
  const abs = resolveUnderUserData(relPath)
  ensureDir(dirname(abs))
  if (!existsSync(abs)) writeFileSync(abs, content, 'utf-8')
}

/** 删除 md 后清理其空父目录（md/mottos 等） */
export function pruneEmptyDir(relPath: string): void {
  try {
    rmSync(dirname(resolveUnderUserData(relPath)), { recursive: false })
  } catch {
    /* 目录非空或不存在，忽略 */
  }
}
