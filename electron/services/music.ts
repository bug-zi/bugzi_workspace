// 音乐吧轻音乐服务（2026-09-15-音乐吧-轻音乐-design.md §三/§四）：mp3 复制入库 + 歌单/曲目 CRUD。
// 文件存 userData/music/<id>.mp3（DB 存相对路径，同书籍模式）；删除彻底删连文件，不入回收站；
// 去重口径 = 同名（去扩展名，不区分大小写）同字节数（对既有曲目文件 stat 比对，不另存 size 列）。
import { copyFileSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, nowIso, userDataDir } from '../db/db'
import type { MusicImportSummary, MusicListResult, MusicPlaylistRow, MusicTrackRow } from '../../src/shared/types'

function musicDir(): string {
  const dir = join(userDataDir(), 'music')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 全量：歌单按建序 + 曲目按加入时间（播放上下文「按加入时间连播」的顺序依据） */
export function listMusic(): MusicListResult {
  const d = getDb()
  return {
    playlists: d.prepare('SELECT * FROM music_playlists ORDER BY id').all() as unknown as MusicPlaylistRow[],
    tracks: d.prepare('SELECT * FROM music_tracks ORDER BY added_at, id').all() as unknown as MusicTrackRow[]
  }
}

/** 多选导入：逐个校验扩展名/复制入库；同名（去扩展名，不区分大小写）同字节数跳过；汇总返回（渲染层 toast） */
export function importTracks(paths: string[]): MusicImportSummary {
  const d = getDb()
  const existing = d.prepare('SELECT title, file_path FROM music_tracks').all() as {
    title: string
    file_path: string
  }[]
  const summary: MusicImportSummary = { imported: 0, skipped: 0, failed: 0 }
  for (const src of paths) {
    try {
      if (src.split('.').pop()?.toLowerCase() !== 'mp3') {
        summary.failed++
        continue
      }
      const base = src.split(/[\\/]/).pop() ?? src
      const size = statSync(src).size
      const dup = existing.some((t) => {
        if (t.title.toLowerCase() !== base.replace(/\.mp3$/i, '').toLowerCase()) return false
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
      const title = base.replace(/\.mp3$/i, '')
      const r = d
        .prepare(
          'INSERT INTO music_tracks (title, file_path, duration_sec, playlist_id, added_at) VALUES (?, ?, NULL, NULL, ?)'
        )
        .run(title, `music/placeholder-${Date.now()}.mp3`, nowIso())
      const id = Number(r.lastInsertRowid)
      const rel = `music/${id}.mp3`
      copyFileSync(src, join(musicDir(), `${id}.mp3`))
      d.prepare('UPDATE music_tracks SET file_path = ? WHERE id = ?').run(rel, id)
      summary.imported++
    } catch {
      summary.failed++
    }
  }
  return summary
}

export function playlistCreate(name: string): number {
  try {
    const r = getDb().prepare('INSERT INTO music_playlists (name, created_at) VALUES (?, ?)').run(name, nowIso())
    return Number(r.lastInsertRowid)
  } catch {
    throw new Error('CONFLICT') // name UNIQUE 冲突
  }
}

export function playlistRename(id: number, name: string): void {
  try {
    getDb().prepare('UPDATE music_playlists SET name = ? WHERE id = ?').run(name, id)
  } catch {
    throw new Error('CONFLICT')
  }
}

/** 删歌单：曲目回未分组（playlist_id 置 NULL），不删曲不删文件（设计 §四） */
export function playlistDelete(id: number): void {
  const d = getDb()
  d.prepare('UPDATE music_tracks SET playlist_id = NULL WHERE playlist_id = ?').run(id)
  d.prepare('DELETE FROM music_playlists WHERE id = ?').run(id)
}

export function trackMove(id: number, playlistId: number | null): void {
  const d = getDb()
  if (playlistId != null && !d.prepare('SELECT id FROM music_playlists WHERE id = ?').get(playlistId)) {
    throw new Error('NOT_FOUND')
  }
  d.prepare('UPDATE music_tracks SET playlist_id = ? WHERE id = ?').run(playlistId, id)
}

/** 彻底删除：删行 + 删文件（渲染层已二次确认；不入回收站） */
export function trackDelete(id: number): void {
  const row = getDb().prepare('SELECT file_path FROM music_tracks WHERE id = ?').get(id) as
    | { file_path: string }
    | undefined
  if (!row) return
  getDb().prepare('DELETE FROM music_tracks WHERE id = ?').run(id)
  try {
    unlinkSync(join(userDataDir(), row.file_path))
  } catch {
    /* 文件本就丢失 */
  }
}

/** 时长懒回写（引擎 loadedmetadata 时调用） */
export function setTrackDuration(id: number, sec: number): void {
  getDb().prepare('UPDATE music_tracks SET duration_sec = ? WHERE id = ?').run(sec, id)
}

/** 曲目二进制（渲染层 Blob URL 播放用；文件缺失抛错由引擎跳下一首） */
export function readTrackFile(id: number): Uint8Array {
  const row = getDb().prepare('SELECT file_path FROM music_tracks WHERE id = ?').get(id) as
    | { file_path: string }
    | undefined
  if (!row) throw new Error('NOT_FOUND')
  return new Uint8Array(readFileSync(join(userDataDir(), row.file_path)))
}
