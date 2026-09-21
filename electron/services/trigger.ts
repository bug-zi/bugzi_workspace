// 音乐吧触发音服务（2026-09-21-触发音与白噪音体验升级-design.md §三）：音频文件复制入库 + 改名/删除。
// 文件存 userData/triggers/<id>.<ext>（DB 存相对路径，同轻音乐模式）；删除彻底删连文件，不入回收站；
// 去重口径 = 同名（去扩展名，不区分大小写）同字节数；扩展名白名单 mp3/wav/ogg（Chromium decodeAudioData 原生支持）。
import { copyFileSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, nowIso, userDataDir } from '../db/db'
import type { TriggerImportSummary, TriggerSoundRow } from '../../src/shared/types'

const EXTS = ['mp3', 'wav', 'ogg']

function triggerDir(): string {
  const dir = join(userDataDir(), 'triggers')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function listTriggers(): TriggerSoundRow[] {
  return getDb().prepare('SELECT * FROM trigger_sounds ORDER BY id').all() as unknown as TriggerSoundRow[]
}

/** 多选导入：逐个校验扩展名/复制入库；同名同字节数跳过；汇总返回（渲染层 toast） */
export function importTriggers(paths: string[]): TriggerImportSummary {
  const d = getDb()
  const existing = d.prepare('SELECT name, file_path FROM trigger_sounds').all() as {
    name: string
    file_path: string
  }[]
  const summary: TriggerImportSummary = { imported: 0, skipped: 0, failed: 0 }
  for (const src of paths) {
    try {
      const ext = src.split('.').pop()?.toLowerCase() ?? ''
      if (!EXTS.includes(ext)) {
        summary.failed++
        continue
      }
      const base = src.split(/[\\/]/).pop() ?? src
      const name = base.replace(new RegExp(`\\.${ext}$`, 'i'), '')
      const size = statSync(src).size
      const dup = existing.some((t) => {
        if (t.name.toLowerCase() !== name.toLowerCase()) return false
        try {
          return statSync(join(userDataDir(), t.file_path)).size === size
        } catch {
          return false // 库文件已丢失的不参与去重
        }
      })
      if (dup) {
        summary.skipped++
        continue
      }
      const r = d
        .prepare('INSERT INTO trigger_sounds (name, file_path, created_at) VALUES (?, ?, ?)')
        .run(name, `triggers/placeholder-${Date.now()}`, nowIso())
      const id = Number(r.lastInsertRowid)
      const rel = `triggers/${id}.${ext}`
      copyFileSync(src, join(triggerDir(), `${id}.${ext}`))
      d.prepare('UPDATE trigger_sounds SET file_path = ? WHERE id = ?').run(rel, id)
      existing.push({ name, file_path: rel })
      summary.imported++
    } catch {
      summary.failed++
    }
  }
  return summary
}

export function triggerRename(id: number, name: string): void {
  try {
    getDb().prepare('UPDATE trigger_sounds SET name = ? WHERE id = ?').run(name, id)
  } catch {
    throw new Error('CONFLICT') // name UNIQUE 冲突
  }
}

/** 彻底删除：删行 + 删文件（渲染层已二次确认；不入回收站） */
export function triggerDelete(id: number): void {
  const row = getDb().prepare('SELECT file_path FROM trigger_sounds WHERE id = ?').get(id) as
    | { file_path: string }
    | undefined
  if (!row) return
  getDb().prepare('DELETE FROM trigger_sounds WHERE id = ?').run(id)
  try {
    unlinkSync(join(userDataDir(), row.file_path))
  } catch {
    /* 文件本就丢失 */
  }
}

/** 触发音频二进制（渲染层 decodeAudioData 用；文件缺失抛错由引擎跳过并提示一次） */
export function readTriggerFile(id: number): Uint8Array {
  const row = getDb().prepare('SELECT file_path FROM trigger_sounds WHERE id = ?').get(id) as
    | { file_path: string }
    | undefined
  if (!row) throw new Error('NOT_FOUND')
  return new Uint8Array(readFileSync(join(userDataDir(), row.file_path)))
}
