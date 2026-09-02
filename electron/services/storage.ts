// 数据存储位置服务（优化建议区 #2）：
// 默认数据目录为内置 D 盘路径；用户可在个人中心迁移到任意位置，
// 迁移后在系统默认 userData 位置留 data_home.json 指针，启动时据此定位实际目录。
import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  statSync,
  rmSync,
  unlinkSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { closeDb } from '../db/db'

/** 内置默认数据目录（开发者要求默认存 D 盘） */
export const BUILTIN_DEFAULT_DATA_DIR = 'D:\\Paper\\app_output\\bugzi_workspace'
const POINTER_FILE = 'data_home.json'

/** 系统默认 userData 目录（Electron 原始默认，指针文件固定存放处） */
export function systemDefaultDataDir(): string {
  return join(app.getPath('appData'), 'bugzi_workspace')
}

function pointerPath(): string {
  return join(systemDefaultDataDir(), POINTER_FILE)
}

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

/** 读取指针；无指针/损坏/目标不存在返回 null */
function readPointer(): string | null {
  try {
    const raw = JSON.parse(readFileSync(pointerPath(), 'utf-8')) as { dataDir?: unknown }
    if (typeof raw.dataDir === 'string' && raw.dataDir && existsSync(raw.dataDir)) return raw.dataDir
  } catch {
    /* 无指针或损坏 */
  }
  return null
}

/** 启动时调用（app ready 之前）：确定数据目录并 setPath */
export function applyDataDirAtStartup(): void {
  const dir = readPointer() ?? BUILTIN_DEFAULT_DATA_DIR
  try {
    mkdirSync(dir, { recursive: true })
    app.setPath('userData', dir)
  } catch (e) {
    // D 盘等不可用 → 回退系统默认，避免完全无法启动
    console.warn(`[storage] 数据目录不可用（${dir}），回退系统默认：${(e as Error).message}`)
  }
}

/** 当前数据目录（个人中心展示用） */
export function currentDataDir(): string {
  return app.getPath('userData')
}

/** 应用自有数据文件/目录名（迁移范围；Cache 等 Electron 产物不在此列） */
function dataItemNames(dir: string): string[] {
  const names = ['bugzi.db', 'bugzi.db-wal', 'bugzi.db-shm', 'md', 'bg']
  try {
    for (const f of readdirSync(dir)) {
      if (/^avatar\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(f)) names.push(f)
    }
  } catch {
    /* 目录不可读 */
  }
  return names
}

function copyDirRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true })
  for (const name of readdirSync(src)) {
    const s = join(src, name)
    const d = join(dst, name)
    if (statSync(s).isDirectory()) copyDirRecursive(s, d)
    else copyFileSync(s, d)
  }
}

/**
 * 迁移数据目录（个人中心-数据存储-修改存储位置）：
 * 关库 → 复制数据 → 校验 → 写/删指针 → 清理旧目录数据文件。
 * 成功后由调用方 relaunch 重启生效。
 */
export function migrateDataDir(newDir: string): void {
  const oldDir = currentDataDir()
  if (samePath(oldDir, newDir)) throw new Error('SAME_DIR')
  mkdirSync(newDir, { recursive: true })
  if (existsSync(join(newDir, 'bugzi.db'))) throw new Error('TARGET_HAS_DATA')

  closeDb() // 迁移前先关 SQLite（WAL 落盘，避免复制到不一致快照）

  let copied = 0
  for (const name of dataItemNames(oldDir)) {
    const src = join(oldDir, name)
    if (!existsSync(src)) continue
    const dst = join(newDir, name)
    if (statSync(src).isDirectory()) copyDirRecursive(src, dst)
    else copyFileSync(src, dst)
    copied++
  }
  if (copied === 0 || !existsSync(join(newDir, 'bugzi.db'))) throw new Error('COPY_FAILED')

  // 指针：新目录即内置默认 → 删指针回归默认逻辑；否则写指针指向新目录。
  // 指针写入失败必须报错中止（此时旧数据未清理，无丢失风险）。
  try {
    if (samePath(newDir, BUILTIN_DEFAULT_DATA_DIR)) {
      try {
        unlinkSync(pointerPath())
      } catch {
        /* 本就无指针 */
      }
    } else {
      mkdirSync(systemDefaultDataDir(), { recursive: true })
      writeFileSync(pointerPath(), JSON.stringify({ dataDir: resolve(newDir) }, null, 2), 'utf-8')
    }
  } catch (e) {
    throw new Error(`POINTER_WRITE_FAILED: ${(e as Error).message}`)
  }

  // 清理旧目录中的数据文件（指针文件不在清单内；缓存等 Electron 产物留给系统）
  for (const name of dataItemNames(oldDir)) {
    const p = join(oldDir, name)
    try {
      if (!existsSync(p)) continue
      if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true })
      else unlinkSync(p)
    } catch (e) {
      console.warn(`[storage] 旧目录清理失败 ${p}：${(e as Error).message}`)
    }
  }
}
