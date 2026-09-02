// IPC 全通道注册（主进程）：渲染层 window.api.* 的后端
import { ipcMain, dialog, BrowserWindow, shell, app, clipboard } from 'electron'
import { getDb, nowIso, normalizeText } from './db/db'
import { getSetting, setSetting, getAllSettings } from './db/settings'
import { mdRead, mdWrite, mdDelete, mdCreate } from './services/files'
import { discardToRecycle, restoreFromRecycle, hardDelete, listRecycle } from './services/recycle'
import { scheduleMottoTask } from './services/scheduler'
import {
  listAiMessages,
  appendAiMessage,
  aiChat,
  generateMottos,
  generateWikiCard,
  runVerification,
  isLlmConfigured
} from './ai/services'
import { chatCompletion, testLlmConnection, listUpstreamModels } from './ai/llm'
import { getEnabledMcps } from './ai/mcp'
import { SettingsKeys } from '../src/shared/types'
import type { LlmConfig, McpConfig } from '../src/shared/types'
import { copyFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { userDataDir } from './db/db'
import { currentDataDir, migrateDataDir } from './services/storage'

function win(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

/** AI 边栏系统消息推送：写库 + webContents 发送 */
export function pushAiSystemMessage(content: string): void {
  const msg = appendAiMessage('system', content, null)
  win()?.webContents.send('ai:message', msg)
}

export function registerIpc(): void {
  // ---------- settings ----------
  ipcMain.handle('settings:getAll', () => getAllSettings())
  ipcMain.handle('settings:get', (_e, key: string) => getSetting(key))
  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    setSetting(key, value)
    // 定时设置变更 → 重排格言任务
    if (key === SettingsKeys.MottoSchedule) scheduleMottoTask()
    return true
  })

  // ---------- md 文件 ----------
  ipcMain.handle('md:read', (_e, path: string) => mdRead(path))
  ipcMain.handle('md:write', (_e, path: string, content: string) => {
    mdWrite(path, content)
    return true
  })
  ipcMain.handle('md:create', (_e, path: string, content: string) => {
    mdCreate(path, content)
    return true
  })
  ipcMain.handle('md:delete', (_e, path: string) => {
    mdDelete(path)
    return true
  })

  // ---------- 头像/背景图上传 ----------
  ipcMain.handle('image:pick', async (_e, kind: 'avatar' | 'bg-light' | 'bg-dark') => {
    const r = await dialog.showOpenDialog(win()!, {
      title: '选择图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      properties: ['openFile']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    const src = r.filePaths[0]
    const ext = src.split('.').pop()?.toLowerCase() ?? 'png'
    let dest: string
    if (kind === 'avatar') {
      dest = join(userDataDir(), `avatar.${ext}`)
      // 清旧头像（不同扩展名）
      for (const old of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']) {
        if (old !== ext) {
          try {
            unlinkSync(join(userDataDir(), `avatar.${old}`))
          } catch {
            /* 无旧文件 */
          }
        }
      }
      setSetting(SettingsKeys.UserAvatar, `avatar.${ext}`)
    } else {
      // 背景图带扩展名存（settings 记文件名，bzres://bg/<file> 引用）
      dest = join(userDataDir(), 'bg', `${kind}.${ext}`)
      copyFileSync(src, dest)
      setSetting(`bg_${kind}`, `${kind}.${ext}`)
      // 删掉旧的其他扩展版本
      for (const old of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']) {
        if (old !== ext) {
          try {
            unlinkSync(join(userDataDir(), 'bg', `${kind}.${old}`))
          } catch {
            /* 无旧文件 */
          }
        }
      }
    }
    return true
  })

  // ---------- 通用条目操作（四模块列表共用模式） ----------
  type ItemKind = 'mottos' | 'wiki_entries' | 'inspirations' | 'verify_records'
  const RECYCLE_MAP: Record<string, 'mottos' | 'wiki' | 'inspirations' | 'verify'> = {
    mottos: 'mottos',
    wiki_entries: 'wiki',
    inspirations: 'inspirations',
    verify_records: 'verify'
  }

  ipcMain.handle('item:discard', (_e, table: string, id: number) => {
    const source = RECYCLE_MAP[table]
    if (!source) throw new Error('UNKNOWN_TABLE')
    discardToRecycle(source, id)
    win()?.webContents.send('recycle:changed')
    return true
  })

  // ---------- 回收站 ----------
  ipcMain.handle('recycle:list', () => listRecycle())
  ipcMain.handle('recycle:restore', (_e, id: number) => {
    const r = restoreFromRecycle(id)
    win()?.webContents.send('recycle:changed')
    return r
  })
  ipcMain.handle('recycle:delete', (_e, id: number) => {
    hardDelete(id)
    win()?.webContents.send('recycle:changed')
    return true
  })

  // ---------- AI 边栏 ----------
  ipcMain.handle('ai:messages', () => listAiMessages())
  ipcMain.handle('ai:chat', async (_e, message: string, currentModule: string) => {
    const msgs = await aiChat(message, currentModule)
    return msgs
  })
  ipcMain.handle('ai:configured', () => isLlmConfigured())
  ipcMain.handle('ai:pushSystem', (_e, content: string) => {
    pushAiSystemMessage(content)
    return true
  })

  // ---------- 格言库 ----------
  ipcMain.handle('mottos:list', (_e, status?: string) => {
    const d = getDb()
    const base = 'SELECT * FROM mottos WHERE deleted_at IS NULL'
    const rows = status
      ? d.prepare(`${base} AND status = ? ORDER BY sort, id`).all(status)
      : d.prepare(`${base} ORDER BY sort, id`).all()
    return rows
  })
  /** 区内最小 sort（空区返回 0），新条目插到区首 */
  const mottoHeadSort = (d: ReturnType<typeof getDb>, status: string): number => {
    const row = d
      .prepare('SELECT MIN(sort) AS m FROM mottos WHERE status = ? AND deleted_at IS NULL')
      .get(status) as { m: number | null }
    return row.m == null ? 0 : row.m - 1
  }
  ipcMain.handle('mottos:create', (_e, content: string, source: string, status: string) => {
    const d = getDb()
    const now = nowIso()
    const r = d
      .prepare(
        'INSERT INTO mottos (content, source, status, origin, note_path, sort, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)'
      )
      .run(content, source, status, 'manual', mottoHeadSort(d, status), now, now)
    const id = Number(r.lastInsertRowid)
    if (status === 'formal') {
      const notePath = `md/mottos/${id}.md`
      d.prepare('UPDATE mottos SET note_path = ? WHERE id = ?').run(notePath, id)
      mdCreate(notePath, `# ${content}\n\n> ${source}\n`)
    }
    return id
  })
  ipcMain.handle('mottos:update', (_e, id: number, content: string, source: string) => {
    getDb().prepare('UPDATE mottos SET content = ?, source = ?, updated_at = ? WHERE id = ?').run(content, source, nowIso(), id)
    return true
  })
  ipcMain.handle('mottos:setStatus', (_e, id: number, status: string) => {
    const d = getDb()
    const row = d.prepare('SELECT * FROM mottos WHERE id = ?').get(id) as { note_path: string | null; content: string; source: string } | undefined
    if (!row) throw new Error('NOT_FOUND')
    if (status === 'formal' && !row.note_path) {
      const notePath = `md/mottos/${id}.md`
      d.prepare('UPDATE mottos SET note_path = ? WHERE id = ?').run(notePath, id)
      mdCreate(notePath, `# ${row.content}\n\n> ${row.source}\n`)
    }
    // 流转目标区：插到区首（sort 取目标区最小值-1）
    d.prepare('UPDATE mottos SET status = ?, sort = ?, updated_at = ? WHERE id = ?').run(
      status,
      mottoHeadSort(d, status),
      nowIso(),
      id
    )
    return true
  })
  ipcMain.handle('mottos:reorder', (_e, moves: { id: number; sort: number }[]) => {
    const d = getDb()
    const stmt = d.prepare('UPDATE mottos SET sort = ?, updated_at = ? WHERE id = ?')
    for (const m of moves) stmt.run(m.sort, nowIso(), m.id)
    return true
  })
  ipcMain.handle('mottos:generate', () => generateMottos())
  ipcMain.handle('mottos:normalize', (_e, s: string) => normalizeText(s))

  // ---------- 万象库 ----------
  ipcMain.handle('wiki:sections', () =>
    getDb().prepare('SELECT * FROM wiki_sections ORDER BY sort').all()
  )
  ipcMain.handle('wiki:createSection', (_e, name: string) => {
    const d = getDb()
    const max = d.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM wiki_sections').get() as { m: number }
    const r = d
      .prepare('INSERT INTO wiki_sections (name, sort, created_at) VALUES (?, ?, ?)')
      .run(name, max.m + 1, nowIso())
    return Number(r.lastInsertRowid)
  })
  ipcMain.handle('wiki:renameSection', (_e, id: number, name: string) => {
    getDb().prepare('UPDATE wiki_sections SET name = ? WHERE id = ?').run(name, id)
    return true
  })
  ipcMain.handle('wiki:deleteSection', (_e, id: number) => {
    const d = getDb()
    const count = d.prepare('SELECT COUNT(*) AS c FROM wiki_entries WHERE section_id = ? AND deleted_at IS NULL').get(id) as { c: number }
    if (count.c > 0) throw new Error('SECTION_NOT_EMPTY')
    d.prepare('DELETE FROM wiki_sections WHERE id = ?').run(id)
    return true
  })
  ipcMain.handle('wiki:entries', (_e, sectionId: number) =>
    getDb().prepare('SELECT * FROM wiki_entries WHERE section_id = ? AND deleted_at IS NULL ORDER BY id DESC').all(sectionId)
  )
  ipcMain.handle('wiki:entry', (_e, id: number) =>
    getDb().prepare('SELECT * FROM wiki_entries WHERE id = ?').get(id)
  )
  ipcMain.handle('wiki:updateEntry', (_e, id: number, term: string, summary: string) => {
    getDb().prepare('UPDATE wiki_entries SET term = ?, summary = ?, updated_at = ? WHERE id = ?').run(term, summary, nowIso(), id)
    return true
  })
  ipcMain.handle('wiki:generate', (_e, term: string | null, sectionId: number | null) => {
    try {
      return { ok: true as const, data: generateWikiCard(term, sectionId) }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.startsWith('CONFLICT:')) return { ok: false as const, conflict: msg.slice(9) }
      throw e
    }
  })
  ipcMain.handle('wiki:highlights', () =>
    getDb().prepare('SELECT h.*, e.term AS term FROM wiki_highlights h JOIN wiki_entries e ON h.entry_id = e.id WHERE e.deleted_at IS NULL ORDER BY h.id DESC').all()
  )
  ipcMain.handle('wiki:addHighlight', (_e, entryId: number, text: string) => {
    const d = getDb()
    const dup = d.prepare('SELECT id FROM wiki_highlights WHERE entry_id = ? AND text = ?').get(entryId, text)
    if (dup) return false
    d.prepare('INSERT INTO wiki_highlights (entry_id, text, created_at) VALUES (?, ?, ?)').run(entryId, text, nowIso())
    return true
  })
  ipcMain.handle('wiki:deleteHighlight', (_e, id: number) => {
    getDb().prepare('DELETE FROM wiki_highlights WHERE id = ?').run(id)
    return true
  })
  ipcMain.handle('wiki:mcpStatus', () => ({ enabled: getEnabledMcps().length }))

  // ---------- 灵感泉 ----------
  ipcMain.handle('inspirations:list', () =>
    getDb().prepare('SELECT * FROM inspirations WHERE deleted_at IS NULL ORDER BY sort, id').all()
  )
  ipcMain.handle('inspirations:create', (_e, title: string, status: string) => {
    const d = getDb()
    const now = nowIso()
    const r = d
      .prepare('INSERT INTO inspirations (title, status, md_path, sort, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(title, status, 'PENDING', now, now)
    const id = Number(r.lastInsertRowid)
    const mdPath = `md/inspirations/${id}.md`
    d.prepare('UPDATE inspirations SET md_path = ? WHERE id = ?').run(mdPath, id)
    mdCreate(mdPath, `# ${title}\n`)
    return id
  })
  ipcMain.handle('inspirations:updateTitle', (_e, id: number, title: string) => {
    getDb().prepare('UPDATE inspirations SET title = ?, updated_at = ? WHERE id = ?').run(title, nowIso(), id)
    return true
  })
  ipcMain.handle('inspirations:move', (_e, id: number, status: string, sort: number) => {
    getDb().prepare('UPDATE inspirations SET status = ?, sort = ?, updated_at = ? WHERE id = ?').run(status, sort, nowIso(), id)
    return true
  })
  ipcMain.handle('inspirations:reorder', (_e, moves: { id: number; status: string; sort: number }[]) => {
    const d = getDb()
    const stmt = d.prepare('UPDATE inspirations SET status = ?, sort = ?, updated_at = ? WHERE id = ?')
    for (const m of moves) stmt.run(m.status, m.sort, nowIso(), m.id)
    return true
  })

  // ---------- 辩真阁 ----------
  ipcMain.handle('verify:list', () =>
    getDb().prepare('SELECT * FROM verify_records WHERE deleted_at IS NULL ORDER BY id DESC').all()
  )
  ipcMain.handle('verify:get', (_e, id: number) =>
    getDb().prepare('SELECT * FROM verify_records WHERE id = ?').get(id)
  )
  ipcMain.handle('verify:findDuplicate', (_e, claim: string) => {
    const rows = getDb().prepare('SELECT id, claim, created_at FROM verify_records WHERE deleted_at IS NULL').all() as { id: number; claim: string; created_at: string }[]
    const key = normalizeText(claim)
    return rows.find((r) => normalizeText(r.claim) === key) ?? null
  })
  ipcMain.handle('verify:run', async (_e, claim: string) => {
    const result = await runVerification(claim, (msg) => pushAiSystemMessage(msg))
    return result
  })

  // ---------- 个人中心：LLM/MCP ----------
  ipcMain.handle('llm:test', (_e, config: LlmConfig) => testLlmConnection(config))
  ipcMain.handle('llm:models', (_e, config: LlmConfig) => listUpstreamModels(config))
  ipcMain.handle('mcp:listEnabled', () => getEnabledMcps())

  // ---------- 个人中心：数据存储（优化建议区 #2） ----------
  ipcMain.handle('storage:currentDir', () => currentDataDir())
  ipcMain.handle('storage:pickDir', async () => {
    const r = await dialog.showOpenDialog(win()!, {
      title: '选择新的数据存储位置（将在该位置下创建 bugzi_workspace 数据）',
      properties: ['openDirectory']
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })
  ipcMain.handle('storage:migrate', (_e, newDir: string) => {
    migrateDataDir(newDir)
    return true
  })
  ipcMain.handle('storage:openDir', (_e, dir: string) => {
    void shell.openPath(dir)
    return true
  })
  ipcMain.handle('storage:relaunch', () => {
    // 迁移完成后重启：closeDb 已在 migrate 内完成，直接 relaunch
    app.relaunch()
    app.quit()
    return true
  })

  // ---------- 外链 ----------
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return true
  })

  // ---------- 剪贴板 ----------
  ipcMain.handle('clipboard:writeText', (_e, text: string) => {
    clipboard.writeText(text)
    return true
  })
}
