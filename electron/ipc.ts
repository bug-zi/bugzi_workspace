// IPC 全通道注册（主进程）：渲染层 window.api.* 的后端
import { ipcMain, dialog, BrowserWindow, shell, app, clipboard } from 'electron'
import { getDb, nowIso, normalizeText, isDupMotto, stripMottoNoteHeader, recordMottoTombstone } from './db/db'
import { getSetting, setSetting, getAllSettings } from './db/settings'
import { mdRead, mdWrite, mdDelete, mdCreate } from './services/files'
import { discardToRecycle, restoreFromRecycle, hardDelete, listRecycle } from './services/recycle'
import { scheduleMottoTask } from './services/scheduler'
import {
  listAiMessages,
  appendSystemToChannelSession,
  editAiMessage,
  aiChat,
  listAiSessions,
  createAiSession,
  renameAiSession,
  deleteAiSession,
  getActiveSessionId,
  deleteAiMessage,
  generateMottos,
  generateWikiCard,
  suggestWikiTerm,
  generateWikiQuiz,
  generateInspirations,
  refineInspiration,
  runVerification,
  isLlmConfigured,
  profileDigest,
  compactAiSession,
  clearAiSession,
  copilotWriting,
  generateSoups,
  judgeSoupQuestion,
  judgeSoupGuess,
  soupReview,
  generateWallPuzzle,
  judgeWallAnswer,
  wallStreak,
  localDateStr,
  WALL_TYPE_LIST
} from './ai/services'
import type { TurtleSoupMaterial, WallPuzzleType } from './ai/services'
import { chatCompletion, testLlmConnection, listUpstreamModels } from './ai/llm'
import { beginJob, endJob, cancelJob } from './ai/jobs'
import { getEnabledMcps } from './ai/mcp'
import { researchMcpConfig, testMcpConnection } from './ai/mcpResearch'
import { SettingsKeys } from '../src/shared/types'
import type { AiChannel, LlmConfig, McpConfig } from '../src/shared/types'
import { copyFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { userDataDir, yyMMdd } from './db/db'
import { currentDataDir, migrateDataDir } from './services/storage'

function win(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

/** AI 边栏系统消息推送：写入指定频道的激活会话 + webContents 发送（频道制：辩真过程进核查频道） */
export function pushAiSystemMessage(content: string, channel: AiChannel = 'verify'): void {
  const msg = appendSystemToChannelSession(channel, content)
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

  // ---------- 通用条目操作（各模块列表共用模式） ----------
  type ItemKind =
    | 'mottos'
    | 'wiki_entries'
    | 'inspirations'
    | 'verify_records'
    | 'zhijiji_questions'
    | 'turtle_soups'
    | 'turtle_games'
    | 'drafts'
  const RECYCLE_MAP: Record<
    string,
    'mottos' | 'wiki' | 'inspirations' | 'verify' | 'zhijiji' | 'reasoning_soup' | 'reasoning_game' | 'drafts'
  > = {
    mottos: 'mottos',
    wiki_entries: 'wiki',
    inspirations: 'inspirations',
    verify_records: 'verify',
    zhijiji_questions: 'zhijiji',
    turtle_soups: 'reasoning_soup',
    turtle_games: 'reasoning_game',
    drafts: 'drafts'
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

  // ---------- AI 边栏（多会话 + 频道制：致知己 specs §4） ----------
  // 统一取消通道（260908 全局取消）：渲染层 ai.cancel(jobId) → 掐断进行中的 AI 任务
  ipcMain.handle('ai:cancel', (_e, jobId: string) => cancelJob(jobId))
  ipcMain.handle('ai:messages', (_e, sessionId: number) => listAiMessages(sessionId))
  ipcMain.handle(
    'ai:chat',
    async (_e, jobId: string, message: string, currentModule: string, sessionId: number, channel?: string) => {
      const ac = beginJob(jobId)
      try {
        return await aiChat(message, currentModule, sessionId, (channel ?? 'assistant') as AiChannel, ac.signal)
      } finally {
        endJob(jobId)
      }
    }
  )
  ipcMain.handle('ai:configured', () => isLlmConfigured())
  ipcMain.handle('ai:pushSystem', (_e, content: string) => {
    pushAiSystemMessage(content)
    return true
  })
  ipcMain.handle('ai:deleteMessage', (_e, id: number) => {
    deleteAiMessage(id)
    return true
  })
  ipcMain.handle('ai:editMessage', (_e, id: number, content: string) => {
    editAiMessage(id, content)
    return true
  })

  // ---------- AI 会话管理（按频道隔离：list/create/active/delete 均带频道参数） ----------
  ipcMain.handle('aiSession:list', (_e, channel?: string) =>
    listAiSessions((channel ?? 'assistant') as AiChannel)
  )
  ipcMain.handle('aiSession:create', (_e, channel?: string) =>
    createAiSession('新对话', (channel ?? 'assistant') as AiChannel)
  )
  ipcMain.handle('aiSession:rename', (_e, id: number, title: string) => {
    renameAiSession(id, title)
    return true
  })
  ipcMain.handle('aiSession:delete', (_e, id: number, channel?: string) => {
    deleteAiSession(id, (channel ?? 'assistant') as AiChannel)
    return true
  })
  ipcMain.handle('aiSession:active', (_e, channel?: string) =>
    getActiveSessionId((channel ?? 'assistant') as AiChannel)
  )
  // /compact：会话历史压缩为前情摘要另存新会话（优化建议区第14轮；补接取消——含 chatCompletion）
  ipcMain.handle('aiSession:compact', async (_e, jobId: string, sessionId: number) => {
    const ac = beginJob(jobId)
    try {
      return await compactAiSession(sessionId, ac.signal)
    } finally {
      endJob(jobId)
    }
  })
  // /clear：清空当前会话全部消息（优化建议区第14轮修订：会话保留，存储清零）
  ipcMain.handle('aiSession:clear', (_e, sessionId: number) => {
    clearAiSession(sessionId)
    return true
  })

  // ---------- 格言库 ----------
  /** mottos.tags 列（JSON 字符串）→ string[]，容错解析 */
  const parseTags = (raw: unknown): string[] => {
    if (typeof raw !== 'string' || !raw) return []
    try {
      const v = JSON.parse(raw) as unknown
      return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
    } catch {
      return []
    }
  }
  /** 标签清洗：trim、去空、去重（渲染层传入数组的统一入口） */
  const sanitizeTags = (tags: unknown): string[] => {
    if (!Array.isArray(tags)) return []
    const out: string[] = []
    for (const t of tags) {
      if (typeof t !== 'string') continue
      const s = t.trim()
      if (s && !out.includes(s)) out.push(s)
    }
    return out
  }
  ipcMain.handle('mottos:list', (_e, status?: string) => {
    const d = getDb()
    const base = 'SELECT * FROM mottos WHERE deleted_at IS NULL'
    const rows = (
      status
        ? d.prepare(`${base} AND status = ? ORDER BY sort, id`).all(status)
        : d.prepare(`${base} ORDER BY sort, id`).all()
    ) as { tags?: string | null }[]
    // tags JSON 列 → 数组（v2.0 §7.1）
    return rows.map((r) => ({ ...r, tags: parseTags(r.tags) }))
  })
  /** 区内最小 sort（空区返回 0），新条目插到区首 */
  const mottoHeadSort = (d: ReturnType<typeof getDb>, status: string): number => {
    const row = d
      .prepare('SELECT MIN(sort) AS m FROM mottos WHERE status = ? AND deleted_at IS NULL')
      .get(status) as { m: number | null }
    return row.m == null ? 0 : row.m - 1
  }
  ipcMain.handle(
    'mottos:create',
    (_e, content: string, source: string, status: string, tags?: string[]) => {
      const d = getDb()
      const now = nowIso()
      const r = d
        .prepare(
          'INSERT INTO mottos (content, source, status, origin, note_path, sort, tags, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)'
        )
        .run(content, source, status, 'manual', mottoHeadSort(d, status), JSON.stringify(sanitizeTags(tags)), now, now)
      const id = Number(r.lastInsertRowid)
      if (status === 'formal') {
        const notePath = `md/mottos/${id}.md`
        d.prepare('UPDATE mottos SET note_path = ? WHERE id = ?').run(notePath, id)
        // 笔记正文从空白开始（优化建议区：句子+出处由弹窗标题区展示，正文不重复）
        mdCreate(notePath, '')
      }
      return id
    }
  )
  ipcMain.handle(
    'mottos:update',
    (_e, id: number, content: string, source: string, tags?: string[]) => {
      // tags 未传（undefined）= 不改动标签；传数组（含空）= 覆盖
      if (tags === undefined) {
        getDb()
          .prepare('UPDATE mottos SET content = ?, source = ?, updated_at = ? WHERE id = ?')
          .run(content, source, nowIso(), id)
      } else {
        getDb()
          .prepare('UPDATE mottos SET content = ?, source = ?, tags = ?, updated_at = ? WHERE id = ?')
          .run(content, source, JSON.stringify(sanitizeTags(tags)), nowIso(), id)
      }
      return true
    }
  )
  ipcMain.handle('mottos:setTags', (_e, id: number, tags: string[]) => {
    getDb()
      .prepare('UPDATE mottos SET tags = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(sanitizeTags(tags)), nowIso(), id)
    return true
  })
  /** 手动新增/批量导入查重（v2.0 §7.4：仅未删除区，与生成同款判重规则） */
  ipcMain.handle('mottos:checkDuplicate', (_e, content: string) => {
    const existing = (
      getDb()
        .prepare('SELECT content FROM mottos WHERE deleted_at IS NULL')
        .all() as { content: string }[]
    ).map((r) => normalizeText(r.content))
    return isDupMotto(existing, normalizeText(content))
  })
  ipcMain.handle('mottos:setStatus', (_e, id: number, status: string) => {
    const d = getDb()
    const row = d.prepare('SELECT * FROM mottos WHERE id = ?').get(id) as { note_path: string | null; content: string; source: string } | undefined
    if (!row) throw new Error('NOT_FOUND')
    if (status === 'formal') {
      if (!row.note_path) {
        const notePath = `md/mottos/${id}.md`
        d.prepare('UPDATE mottos SET note_path = ? WHERE id = ?').run(notePath, id)
        // 笔记正文从空白开始（同 mottos:create）
        mdCreate(notePath, '')
      } else {
        // 旧笔记可能仍带「# 句子\n\n> 出处」模板头（v8 前创建、回收站恢复后再转正等），顺带剥离
        stripMottoNoteHeader(row.note_path, row.content, row.source)
      }
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
  ipcMain.handle('mottos:generate', async (_e, jobId: string) => {
    const ac = beginJob(jobId)
    try {
      return await generateMottos(ac.signal)
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('mottos:normalize', (_e, s: string) => normalizeText(s))
  ipcMain.handle('mottos:deleteForever', (_e, id: number) => {
    // 直接删除（优化建议区）：越过回收站彻底删除，连带笔记 md（同 hardDelete 的处理口径）；
    // 物理删除前写墓碑留底（优化建议区第24轮，防「来10条格言」复现已删格言）
    const row = getDb().prepare('SELECT content, note_path FROM mottos WHERE id = ?').get(id) as
      | { content: string; note_path: string | null }
      | undefined
    if (row) recordMottoTombstone(row.content)
    getDb().prepare('DELETE FROM mottos WHERE id = ?').run(id)
    if (row?.note_path) mdDelete(row.note_path)
    return true
  })

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
  ipcMain.handle('wiki:generate', async (_e, jobId: string, term: string | null, sectionId: number | null) => {
    const ac = beginJob(jobId)
    try {
      // 必须在此 await：若把 generateWikiCard 的 Promise 嵌进返回对象，
      // ipcMain.handle 只 await 顶层值，嵌套 Promise 序列化失败 → 渲染层 invoke 永不 settle（卡"生成中"）
      return { ok: true as const, data: await generateWikiCard(term, sectionId, ac.signal) }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.startsWith('CONFLICT:')) return { ok: false as const, conflict: msg.slice(9) }
      throw e
    } finally {
      endJob(jobId)
    }
  })
  // 随机词条名（手动弹窗骰子/指定板块随机生成）：只构思词条名不生成卡片
  ipcMain.handle('wiki:suggestTerm', async (_e, jobId: string, sectionId: number | null) => {
    const ac = beginJob(jobId)
    try {
      const r = await suggestWikiTerm(sectionId, ac.signal)
      return r.term
    } finally {
      endJob(jobId)
    }
  })
  // 测一测：随机 5 张卡片批量出四选一（优化建议区）
  ipcMain.handle('wiki:quiz', async (_e, jobId: string) => {
    const ac = beginJob(jobId)
    try {
      return await generateWikiQuiz(ac.signal)
    } finally {
      endJob(jobId)
    }
  })
  // 直接删除词条（生成审核流）：越过回收站删卡片 md + 高光 + 词条行（同 hardDelete wiki 口径）
  ipcMain.handle('wiki:deleteForeverEntry', (_e, id: number) => {
    const d = getDb()
    const row = d.prepare('SELECT md_path FROM wiki_entries WHERE id = ?').get(id) as
      | { md_path: string | null }
      | undefined
    d.prepare('DELETE FROM wiki_highlights WHERE entry_id = ?').run(id)
    d.prepare('DELETE FROM wiki_entries WHERE id = ?').run(id)
    if (row?.md_path) mdDelete(row.md_path)
    return true
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
    // 正文不写标题行（优化建议区第19轮）：标题由弹窗标题区展示，正文从空白开始
    mdCreate(mdPath, '')
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
  // 灵感泉 v2.0（specs §6.1）：AI 生成 / AI 完善
  ipcMain.handle('inspirations:generate', async (_e, jobId: string) => {
    const ac = beginJob(jobId)
    try {
      return await generateInspirations(ac.signal)
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('inspirations:refine', async (_e, jobId: string, id: number) => {
    const ac = beginJob(jobId)
    try {
      return await refineInspiration(id, ac.signal)
    } finally {
      endJob(jobId)
    }
  })
  /** AI 完善确认后追加进 md：拼接收敛主进程，避免前端 read-modify-write 与打开中的 MdDialog 竞态 */
  ipcMain.handle('inspirations:appendRefine', (_e, id: number, content: string) => {
    const d = getDb()
    const row = d.prepare('SELECT md_path FROM inspirations WHERE id = ?').get(id) as
      | { md_path: string }
      | undefined
    if (!row) throw new Error('NOT_FOUND')
    let prev: string
    try {
      prev = mdRead(row.md_path)
    } catch {
      throw new Error('NOT_FOUND')
    }
    // 段落标题时间戳以追加时刻为准（specs §6.3），格式同回收站时间显示
    const t = new Date()
    const stamp = `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    mdWrite(row.md_path, `${prev.replace(/\s+$/, '')}\n\n## AI 补充 · ${stamp}\n\n${content.trim()}\n`)
    d.prepare('UPDATE inspirations SET updated_at = ? WHERE id = ?').run(nowIso(), id)
    return true
  })

  // ---------- 草稿本（DB v14，优化建议区第21轮）：右缘常驻面板的 md 草稿 ----------
  ipcMain.handle('draft:list', (_e, channel: string) =>
    getDb()
      .prepare(
        'SELECT id, title, channel, md_path, created_at, updated_at FROM drafts WHERE channel = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC'
      )
      .all(channel === 'turtle' ? 'turtle' : 'general')
  )
  ipcMain.handle('draft:create', (_e, channel: string, title: string | null, content: string | null) => {
    const d = getDb()
    const now = nowIso()
    const r = d
      .prepare('INSERT INTO drafts (title, channel, md_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(title && title.trim() ? title.trim().slice(0, 50) : '新建草稿', channel === 'turtle' ? 'turtle' : 'general', 'PENDING', now, now)
    const id = Number(r.lastInsertRowid)
    const mdPath = `md/drafts/${id}.md`
    d.prepare('UPDATE drafts SET md_path = ? WHERE id = ?').run(mdPath, id)
    // 正文不写标题行（口径同灵感第19轮）：标题由面板切换条展示；海龟汤联动的汤面/线索模板作为 content 传入
    mdCreate(mdPath, content ?? '')
    return id
  })
  ipcMain.handle('draft:rename', (_e, id: number, title: string) => {
    // 改名不触碰 updated_at（与会话改名一致，列表顺序保持稳定）
    getDb().prepare('UPDATE drafts SET title = ? WHERE id = ?').run(title.trim().slice(0, 50) || '新建草稿', id)
    return true
  })
  ipcMain.handle('draft:save', (_e, id: number, content: string) => {
    const d = getDb()
    const row = d.prepare('SELECT md_path FROM drafts WHERE id = ?').get(id) as
      | { md_path: string }
      | undefined
    if (!row) throw new Error('NOT_FOUND')
    mdWrite(row.md_path, content)
    d.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(nowIso(), id)
    return true
  })
  /** 大窗编辑（MdDialog 自行 md.write 保存）后的触碰：只 bump updated_at 让草稿浮回列表顶部 */
  ipcMain.handle('draft:touch', (_e, id: number) => {
    getDb().prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(nowIso(), id)
    return true
  })

  // ---------- 文笔坊（DB v17，文笔坊 specs §2/§3/§4）：浮生记零 AI + 写作台 + Copilot ----------
  ipcMain.handle('wenbi:journalList', () =>
    getDb()
      .prepare('SELECT * FROM wenbi_journals WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC')
      .all()
  )
  /** 新建一条记录：返回整行（渲染层需 created_at 拼弹窗标题日期） */
  ipcMain.handle('wenbi:journalCreate', () => {
    const d = getDb()
    const now = nowIso()
    const r = d
      .prepare("INSERT INTO wenbi_journals (md_path, created_at, updated_at) VALUES ('PENDING', ?, ?)")
      .run(now, now)
    const id = Number(r.lastInsertRowid)
    const mdPath = `md/wenbi/journal/${id}.md`
    d.prepare('UPDATE wenbi_journals SET md_path = ? WHERE id = ?').run(mdPath, id)
    mdCreate(mdPath, '')
    return d.prepare('SELECT * FROM wenbi_journals WHERE id = ?').get(id)
  })
  /** 大事件标记切换：不动 updated_at（标记非内容变更，时间线位置钉在 created_at） */
  ipcMain.handle('wenbi:journalSetEvent', (_e, id: number, isEvent: boolean) => {
    getDb().prepare('UPDATE wenbi_journals SET is_event = ? WHERE id = ?').run(isEvent ? 1 : 0, id)
    return true
  })
  ipcMain.handle('wenbi:journalDiscard', (_e, id: number) => {
    discardToRecycle('wenbi_journal', id)
    return true
  })
  ipcMain.handle('wenbi:articleList', () =>
    getDb().prepare('SELECT * FROM wenbi_articles WHERE deleted_at IS NULL ORDER BY zone, sort, id').all()
  )
  ipcMain.handle('wenbi:articleCreate', (_e, zone: string, title: string) => {
    const d = getDb()
    const tail =
      (
        d.prepare('SELECT MAX(sort) AS m FROM wenbi_articles WHERE zone = ? AND deleted_at IS NULL').get(zone) as {
          m: number | null
        }
      ).m ?? 0
    const now = nowIso()
    const r = d
      .prepare('INSERT INTO wenbi_articles (title, zone, md_path, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(title, zone, 'PENDING', tail + 1, now, now)
    const id = Number(r.lastInsertRowid)
    const mdPath = `md/wenbi/article/${id}.md`
    d.prepare('UPDATE wenbi_articles SET md_path = ? WHERE id = ?').run(mdPath, id)
    mdCreate(mdPath, `# ${title}\n`)
    return id
  })
  /** 改标题不动 updated_at（drafts 改名先例，列表时间稳定） */
  ipcMain.handle('wenbi:articleRename', (_e, id: number, title: string) => {
    getDb().prepare('UPDATE wenbi_articles SET title = ? WHERE id = ?').run(title.trim().slice(0, 100) || '未命名文章', id)
    return true
  })
  ipcMain.handle('wenbi:articleMove', (_e, id: number, zone: string, sort: number) => {
    getDb().prepare('UPDATE wenbi_articles SET zone = ?, sort = ?, updated_at = ? WHERE id = ?').run(zone, sort, nowIso(), id)
    return true
  })
  /** 拖拽重排后归一化（批量） */
  ipcMain.handle('wenbi:articleReorder', (_e, moves: { id: number; zone: string; sort: number }[]) => {
    const stmt = getDb().prepare('UPDATE wenbi_articles SET zone = ?, sort = ?, updated_at = ? WHERE id = ?')
    for (const m of moves) stmt.run(m.zone, m.sort, nowIso(), m.id)
    return true
  })
  /** MdDialog 编辑保存后的触碰：只 bump updated_at（draft:touch 先例） */
  ipcMain.handle('wenbi:articleTouch', (_e, id: number) => {
    getDb().prepare('UPDATE wenbi_articles SET updated_at = ? WHERE id = ?').run(nowIso(), id)
    return true
  })
  ipcMain.handle('wenbi:articleDiscard', (_e, id: number) => {
    discardToRecycle('wenbi_article', id)
    return true
  })
  /** 导出 .md：系统保存对话框（默认文件名=标题），取消返回 null */
  ipcMain.handle('wenbi:articleExport', async (_e, id: number) => {
    const row = getDb().prepare('SELECT title, md_path FROM wenbi_articles WHERE id = ?').get(id) as
      | { title: string; md_path: string }
      | undefined
    if (!row) throw new Error('NOT_FOUND')
    const content = mdRead(row.md_path)
    const r = await dialog.showSaveDialog(win()!, {
      defaultPath: `${row.title.replace(/[\\/:*?"<>|]/g, '_')}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (r.canceled || !r.filePath) return null
    writeFileSync(r.filePath, content, 'utf-8')
    return r.filePath
  })
  ipcMain.handle('wenbi:copilot', async (_e, jobId: string, id: number, action: string, selection?: string) => {
    const ac = beginJob(jobId)
    try {
      return await copilotWriting(id, action as 'draft' | 'continue' | 'polish' | 'rewrite', selection, ac.signal)
    } finally {
      endJob(jobId)
    }
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
  ipcMain.handle('verify:run', async (_e, jobId: string, claim: string) => {
    const ac = beginJob(jobId)
    try {
      return await runVerification(claim, (msg) => pushAiSystemMessage(msg), ac.signal)
    } finally {
      endJob(jobId)
    }
  })

  // ---------- 致知己（DB v9，致知己 specs §2：问题 + 多版本答案，AI 只追问不代笔） ----------
  ipcMain.handle('zhijiji:list', () => {
    const rows = getDb()
      .prepare(
        `SELECT q.id, q.title, q.tags, q.created_at, q.updated_at,
          (SELECT COUNT(*) FROM zhijiji_versions v WHERE v.question_id = q.id) AS version_count
        FROM zhijiji_questions q WHERE q.deleted_at IS NULL ORDER BY q.updated_at DESC`
      )
      .all() as { tags?: string | null }[]
    return rows.map((r) => ({ ...r, tags: parseTags(r.tags) }))
  })
  ipcMain.handle(
    'zhijiji:createQuestion',
    async (_e, jobId: string, title: string, tags?: string[], aiInit?: boolean) => {
      const ac = beginJob(jobId)
      try {
        const t = title.trim()
        if (!t) throw new Error('TITLE_REQUIRED')
        // AI 初始化答案（优化建议区第13轮）：LLM 先就问题给出初始参考答案（v0），
        // 失败则抛错不建问题（渲染层提示，用户的输入不落半截数据）
        let initContent = ''
        if (aiInit) {
          const digest = profileDigest()
          const prompt = `${digest}${digest ? '\n\n' : ''}请回答这个问题：「${t}」。用简体中文 Markdown 输出一份结构清晰、有见解的初始参考答案（600 字以内），不要输出与答案无关的内容。`
          const res = await chatCompletion({
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            signal: ac.signal
          })
          const body = res.content
            .replace(/^```(?:markdown|md)?\s*\n?/, '')
            .replace(/\n?```\s*$/, '')
            .trim()
          if (!body) throw new Error('LLM 未返回内容')
          initContent = `> 以下是 AI 初始化的参考答案（v0）。请在此基础上写出属于你自己的 v1，完成后可删除本段。\n\n${body}\n`
        }
        const d = getDb()
        const now = nowIso()
        const r = d
          .prepare('INSERT INTO zhijiji_questions (title, tags, created_at, updated_at) VALUES (?, ?, ?, ?)')
          .run(t, JSON.stringify(sanitizeTags(tags)), now, now)
        const qid = Number(r.lastInsertRowid)
        // v0（AI 初始化）或空白 v1：seq = aiInit ? 0 : 1，用户在其上编辑保存为 v1/v2…
        const seq = aiInit ? 0 : 1
        const mdPath = `md/zhijiji/${qid}-v${seq}.md`
        mdCreate(mdPath, initContent)
        const vr = d
          .prepare(
            'INSERT INTO zhijiji_versions (question_id, seq, date, md_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(qid, seq, yyMMdd(), mdPath, now, now)
        return { questionId: qid, versionId: Number(vr.lastInsertRowid), mdPath }
      } finally {
        endJob(jobId)
      }
    }
  )
  ipcMain.handle('zhijiji:versions', (_e, questionId: number) =>
    getDb()
      .prepare('SELECT * FROM zhijiji_versions WHERE question_id = ? ORDER BY seq DESC')
      .all(questionId)
  )
  ipcMain.handle('zhijiji:saveNewVersion', (_e, questionId: number, content: string) => {
    const d = getDb()
    const now = nowIso()
    const date = yyMMdd()
    const max = d
      .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM zhijiji_versions WHERE question_id = ?')
      .get(questionId) as { m: number }
    const seq = max.m + 1
    const mdPath = `md/zhijiji/${questionId}-v${seq}.md`
    mdCreate(mdPath, content)
    const r = d
      .prepare(
        'INSERT INTO zhijiji_versions (question_id, seq, date, md_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(questionId, seq, date, mdPath, now, now)
    d.prepare('UPDATE zhijiji_questions SET updated_at = ? WHERE id = ?').run(now, questionId)
    return { versionId: Number(r.lastInsertRowid), seq, date }
  })
  ipcMain.handle('zhijiji:overwriteVersion', (_e, versionId: number, content: string) => {
    const d = getDb()
    const row = d
      .prepare('SELECT question_id, md_path FROM zhijiji_versions WHERE id = ?')
      .get(versionId) as { question_id: number; md_path: string } | undefined
    if (!row) throw new Error('NOT_FOUND')
    const now = nowIso()
    mdWrite(row.md_path, content)
    // 覆盖：序号不变、日期更新为覆盖当日（specs §2）
    d.prepare('UPDATE zhijiji_versions SET date = ?, updated_at = ? WHERE id = ?').run(
      yyMMdd(),
      now,
      versionId
    )
    d.prepare('UPDATE zhijiji_questions SET updated_at = ? WHERE id = ?').run(now, row.question_id)
    return true
  })
  ipcMain.handle('zhijiji:renameQuestion', (_e, id: number, title: string) => {
    const t = title.trim()
    if (!t) return false
    getDb()
      .prepare('UPDATE zhijiji_questions SET title = ?, updated_at = ? WHERE id = ?')
      .run(t, nowIso(), id)
    return true
  })
  ipcMain.handle('zhijiji:discard', (_e, id: number) => {
    discardToRecycle('zhijiji', id)
    win()?.webContents.send('recycle:changed')
    return true
  })

  // ---------- 推理角（DB v12，推理角 specs §2/§4） ----------
  ipcMain.handle('turtle:generate', async (_e, jobId: string, preference: string) => {
    const ac = beginJob(jobId)
    try {
      return await generateSoups(
        preference === 'easy' || preference === 'medium' || preference === 'hard' ? preference : 'random',
        ac.signal
      )
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('turtle:listSoups', (_e, difficulty?: string) => {
    const base =
      'SELECT id, title, difficulty, theme_tag, status, created_at FROM turtle_soups WHERE deleted_at IS NULL'
    return difficulty
      ? getDb().prepare(`${base} AND difficulty = ? ORDER BY id DESC`).all(difficulty)
      : getDb().prepare(`${base} ORDER BY id DESC`).all()
  })
  ipcMain.handle('turtle:openSoup', (_e, soupId: number) => {
    const d = getDb()
    const soup = d
      .prepare('SELECT id, status FROM turtle_soups WHERE id = ? AND deleted_at IS NULL')
      .get(soupId) as { id: number; status: string } | undefined
    if (!soup) throw new Error('NOT_FOUND')
    // 终局汤：回看模式（问题疑惑区第8轮）——取该汤最近一局终局对局只读打开，不开新局
    if (soup.status === 'solved' || soup.status === 'abandoned') {
      const fin = d
        .prepare(
          "SELECT id FROM turtle_games WHERE soup_id = ? AND status != 'playing' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1"
        )
        .get(soupId) as { id: number } | undefined
      if (!fin) throw new Error('NOT_FOUND')
      return turtleGamePayload(fin.id)
    }
    let game = d
      .prepare(
        "SELECT id FROM turtle_games WHERE soup_id = ? AND status = 'playing' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1"
      )
      .get(soupId) as { id: number } | undefined
    if (!game) {
      const now = nowIso()
      const r = d
        .prepare(
          "INSERT INTO turtle_games (soup_id, status, started_at, created_at, updated_at) VALUES (?, 'playing', ?, ?, ?)"
        )
        .run(soupId, now, now, now)
      d.prepare("UPDATE turtle_soups SET status = 'playing', updated_at = ? WHERE id = ?").run(
        now,
        soupId
      )
      game = { id: Number(r.lastInsertRowid) }
    }
    return turtleGamePayload(game.id)
  })
  ipcMain.handle('turtle:game', (_e, gameId: number) => turtleGamePayload(gameId))
  ipcMain.handle('turtle:ask', async (_e, jobId: string, gameId: number, question: string) => {
    const ac = beginJob(jobId)
    try {
      const q = question.trim()
      if (!q) throw new Error('EMPTY')
      const d = getDb()
      const game = getPlayingGame(d, gameId)
      const judged = await judgeSoupQuestion(
        turtleMaterial(d, game.soup_id),
        turtleHistoryText(d, gameId),
        q,
        ac.signal
      )
      const now = nowIso()
      insertTurtleMsg(d, gameId, 'user', 'question', q, now)
      insertTurtleMsg(
        d,
        gameId,
        'assistant',
        judged.type === 'invalid' ? 'invalid' : 'answer',
        judged.reply,
        now
      )
      let count = game.question_count
      if (judged.type !== 'invalid') {
        count += 1
        d.prepare('UPDATE turtle_games SET question_count = ?, updated_at = ? WHERE id = ?').run(
          count,
          now,
          gameId
        )
      }
      return { type: judged.type, reply: judged.reply, questionCount: count }
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('turtle:guess', async (_e, jobId: string, gameId: number, reasoning: string) => {
    const ac = beginJob(jobId)
    try {
      const g = reasoning.trim()
      if (!g) throw new Error('EMPTY')
      const d = getDb()
      const game = getPlayingGame(d, gameId)
      const verdict = await judgeSoupGuess(turtleMaterial(d, game.soup_id), turtleHistoryText(d, gameId), g, ac.signal)
      const vText = verdict.solved
        ? `破汤！${verdict.feedback}`
        : `未破。${verdict.hits.length ? `已命中：${verdict.hits.join('；')}。` : ''}${
            verdict.misses.length ? `有偏差：${verdict.misses.join('；')}。` : ''
          }${verdict.feedback}`
      const now = nowIso()
      insertTurtleMsg(d, gameId, 'user', 'guess', g, now)
      insertTurtleMsg(d, gameId, 'assistant', 'verdict', vText, now)
      if (!verdict.solved) {
        d.prepare('UPDATE turtle_games SET updated_at = ? WHERE id = ?').run(now, gameId)
        return { solved: false, hits: verdict.hits, misses: verdict.misses, feedback: verdict.feedback }
      }
      const fin = await finishTurtleGame(gameId, 'solved', ac.signal)
      return {
        solved: true,
        bottom: fin.bottom,
        hits: verdict.hits,
        misses: verdict.misses,
        feedback: verdict.feedback,
        mdPath: fin.mdPath
      }
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('turtle:abandon', async (_e, jobId: string, gameId: number) => {
    const ac = beginJob(jobId)
    try {
      const d = getDb()
      getPlayingGame(d, gameId)
      insertTurtleMsg(d, gameId, 'system', 'notice', '我放弃了本局，揭示汤底。', nowIso())
      return await finishTurtleGame(gameId, 'abandoned', ac.signal)
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('turtle:discardSoup', (_e, soupId: number) => {
    const soup = getDb()
      .prepare('SELECT status FROM turtle_soups WHERE id = ? AND deleted_at IS NULL')
      .get(soupId) as { status: string } | undefined
    if (!soup) throw new Error('NOT_FOUND')
    if (soup.status === 'playing') throw new Error('PLAYING')
    discardToRecycle('reasoning_soup', soupId)
    win()?.webContents.send('recycle:changed')
    return true
  })
  ipcMain.handle('turtle:discardGame', (_e, gameId: number) => {
    const game = getDb()
      .prepare('SELECT status FROM turtle_games WHERE id = ? AND deleted_at IS NULL')
      .get(gameId) as { status: string } | undefined
    if (!game) throw new Error('NOT_FOUND')
    if (game.status === 'playing') throw new Error('PLAYING')
    discardToRecycle('reasoning_game', gameId)
    win()?.webContents.send('recycle:changed')
    return true
  })
  ipcMain.handle('turtle:listGames', () =>
    getDb()
      .prepare(
        `SELECT g.id, g.status, g.question_count, g.started_at, g.ended_at, g.duration_ms, g.md_path, s.title, s.difficulty
         FROM turtle_games g JOIN turtle_soups s ON g.soup_id = s.id
         WHERE g.status != 'playing' AND g.deleted_at IS NULL ORDER BY g.ended_at DESC`
      )
      .all()
  )

  // ---------- 思维墙（打开现出，无定时器；specs §2/§4；v1.2 洞察题管线） ----------
  ipcMain.handle('wall:ensureToday', async (_e, jobId: string) => {
    const ac = beginJob(jobId)
    try {
      const d = getDb()
      const today = localDateStr()
      let row = d.prepare('SELECT * FROM wall_puzzles WHERE date = ?').get(today)
      if (!row) {
        // 出题难度由连胜推导（v1.2：答对 1 天即升一档，答错清零回 easy）
        const lv = Math.min(2, wallStreak())
        const difficulty = (['easy', 'medium', 'hard'] as const)[lv]
        // 题型轮换：近 2 日已出题型不再出（三题型池保证至少剩一种可选）
        const recentTypes = d
          .prepare(
            'SELECT puzzle_type FROM wall_puzzles ORDER BY date DESC LIMIT 2'
          )
          .all()
          .map((r) => (r as { puzzle_type: string }).puzzle_type)
        const candidates = WALL_TYPE_LIST.filter((t) => !recentTypes.includes(t))
        const type = candidates[Math.floor(Math.random() * candidates.length)] ?? WALL_TYPE_LIST[0]
        // 避免重复：近 20 题题面摘要入避免清单（防同构重出）
        const avoid = (
          d
            .prepare(
              'SELECT puzzle_text FROM wall_puzzles ORDER BY date DESC LIMIT 20'
            )
            .all() as { puzzle_text: string }[]
        ).map((r) => r.puzzle_text.replace(/\s+/g, ' ').slice(0, 60))
        const draft = await generateWallPuzzle(difficulty, { type, avoid }, ac.signal)
        const now = nowIso()
        d.prepare(
          'INSERT INTO wall_puzzles (date, puzzle_text, answer_standard, standard_reasoning, hints, puzzle_type, difficulty, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          today,
          draft.puzzle,
          draft.answer,
          draft.reasoning,
          JSON.stringify(draft.hints),
          draft.type,
          draft.difficulty,
          'answering',
          now,
          now
        )
        row = d.prepare('SELECT * FROM wall_puzzles WHERE date = ?').get(today)
      }
      return wallPayload(row)
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('wall:answer', async (_e, jobId: string, puzzleId: number, myAnswer: string) => {
    const ac = beginJob(jobId)
    try {
      const a = myAnswer.trim()
      if (!a) throw new Error('EMPTY')
      const d = getDb()
      const row = d.prepare('SELECT * FROM wall_puzzles WHERE id = ?').get(puzzleId) as
        | WallPuzzleRow
        | undefined
      if (!row) throw new Error('NOT_FOUND')
      if (row.status !== 'answering') throw new Error('ALREADY_ANSWERED')
      const verdict = await judgeWallAnswer(
        row.puzzle_text,
        row.answer_standard,
        row.standard_reasoning ?? '',
        a,
        ac.signal
      )
      const hintsTotal = parseWallHints(row.hints).length
      const mdPath = `md/wall/${row.date}.md`
      mdWrite(
        mdPath,
        `# ${row.date} 每日一题（${WALL_TYPE_ZH[row.puzzle_type] ?? row.puzzle_type} · ${
          DIFFICULTY_ZH[row.difficulty] ?? row.difficulty
        }）\n\n> ${verdict.correct ? '答对' : '答错'} · 提示使用 ${row.hints_used}/${hintsTotal}\n\n## 题面\n\n${
          row.puzzle_text
        }\n\n## 我的作答\n\n${a}\n\n## 判定\n\n${
          verdict.correct ? '答对' : '答错'
        }（标准答案：${row.answer_standard}）\n\n## 讲解\n\n${verdict.explanation}\n\n## 标准论证\n\n${
          row.standard_reasoning ?? '（未存档）'
        }\n`
      )
      d.prepare(
        'UPDATE wall_puzzles SET status = ?, my_answer = ?, md_path = ?, updated_at = ? WHERE id = ?'
      ).run(verdict.correct ? 'correct' : 'wrong', a, mdPath, nowIso(), puzzleId)
      return {
        correct: verdict.correct,
        standardAnswer: row.answer_standard,
        explanation: verdict.explanation,
        mdPath
      }
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('wall:hint', (_e, puzzleId: number) => {
    const d = getDb()
    const row = d.prepare('SELECT * FROM wall_puzzles WHERE id = ?').get(puzzleId) as
      | WallPuzzleRow
      | undefined
    if (!row || row.status !== 'answering') return null
    const hints = parseWallHints(row.hints)
    if (row.hints_used >= hints.length) return null
    const level = row.hints_used + 1
    d.prepare('UPDATE wall_puzzles SET hints_used = ?, updated_at = ? WHERE id = ?').run(
      level,
      nowIso(),
      puzzleId
    )
    return { level, text: hints[row.hints_used] }
  })
  ipcMain.handle('wall:month', (_e, year: number, month: number) => {
    const prefix = `${year}-${String(month).padStart(2, '0')}-%`
    const rows = getDb()
      .prepare(
        "SELECT date, status, hints_used, difficulty, md_path FROM wall_puzzles WHERE date LIKE ? AND status != 'answering'"
      )
      .all(prefix) as {
      date: string
      status: string
      hints_used: number
      difficulty: string
      md_path: string | null
    }[]
    return {
      streak: wallStreak(),
      correct: rows.filter((r) => r.status === 'correct').length,
      wrong: rows.filter((r) => r.status === 'wrong').length,
      days: rows.map((r) => ({
        date: r.date,
        status: r.status,
        hintsUsed: r.hints_used,
        difficulty: r.difficulty,
        mdPath: r.md_path
      }))
    }
  })
  ipcMain.handle('wall:recordPath', (_e, date: string) => {
    const row = getDb()
      .prepare('SELECT md_path FROM wall_puzzles WHERE date = ?')
      .get(date) as { md_path: string | null } | undefined
    return row?.md_path ?? null
  })

  // ---------- 思维墙·练习场（design v2 备选提前落地）：随时刷题，不计入墙/连胜/月历 ----------
  // 会话级暂存主进程内存（practiceBank）：不落库、不写 md，应用重启即清——练习无存档语义。
  ipcMain.handle('wall:practiceNew', async (_e, jobId: string, pref: string, typePref?: string) => {
    const ac = beginJob(jobId)
    try {
      const difficulty =
        pref === 'easy' || pref === 'medium' || pref === 'hard'
          ? pref
          : (['easy', 'medium', 'hard'] as const)[Math.floor(Math.random() * 3)] // 随机
      // 题型自选（v1.2）：随机 | 三洞察题型之一（防重复注入见 wall_puzzles 近题避免清单——练习不落库，无历史可避）
      const type: WallPuzzleType | undefined = WALL_TYPE_LIST.find((t) => t === typePref)
      const draft = await generateWallPuzzle(difficulty, { type: type ?? undefined }, ac.signal)
      const id = ++practiceSeq
      practiceBank.set(id, {
        puzzle: draft.puzzle,
        answer: draft.answer,
        reasoning: draft.reasoning,
        hints: draft.hints,
        hintsUsed: 0,
        typeZh: WALL_TYPE_ZH[draft.type] ?? draft.type,
        diffZh: DIFFICULTY_ZH[draft.difficulty] ?? draft.difficulty
      })
      // 长会话防累积：只留最近 10 条。Map 按插入序遍历，删最旧不伤当前题（当前题必是最新插入）
      for (const old of practiceBank.keys()) {
        if (practiceBank.size <= 10) break
        practiceBank.delete(old)
      }
      return {
        id,
        puzzle: draft.puzzle,
        typeZh: WALL_TYPE_ZH[draft.type] ?? draft.type,
        diffZh: DIFFICULTY_ZH[draft.difficulty] ?? draft.difficulty,
        hintsTotal: draft.hints.length
      }
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('wall:practiceAnswer', async (_e, jobId: string, practiceId: number, myAnswer: string) => {
    const ac = beginJob(jobId)
    try {
      const a = myAnswer.trim()
      if (!a) throw new Error('EMPTY')
      const entry = practiceBank.get(practiceId)
      if (!entry) throw new Error('PRACTICE_GONE')
      // 取消 → 判答未完成，entry 未删，可重新提交
      const verdict = await judgeWallAnswer(entry.puzzle, entry.answer, entry.reasoning, a, ac.signal)
      practiceBank.delete(practiceId) // 一题一命：判答即终局，对错都揭示答案与讲解
      return {
        correct: verdict.correct,
        standardAnswer: entry.answer,
        explanation: verdict.explanation
      }
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('wall:practiceHint', (_e, practiceId: number) => {
    const entry = practiceBank.get(practiceId)
    if (!entry || entry.hintsUsed >= entry.hints.length) return null
    const level = entry.hintsUsed + 1
    const text = entry.hints[entry.hintsUsed]
    entry.hintsUsed = level
    return { level, text }
  })

  // ---------- 思维墙·精选题库（v1.2 双层题源第二层）：人工策展存量难题，AI 只判答不出题 ----------
  // 题面/答案/标准论证随 DB v13 种子迁移入库；作答/看解答均为终态（墙是真实历史，不可重做）。
  ipcMain.handle('wall:bankList', () => {
    const rows = getDb()
      .prepare(
        'SELECT id, title, tag, difficulty, source, status, my_answer, md_path FROM wall_bank ORDER BY id'
      )
      .all() as {
      id: number
      title: string
      tag: string
      difficulty: string
      source: string
      status: string
      my_answer: string | null
      md_path: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      tag: r.tag,
      diffZh: DIFFICULTY_ZH[r.difficulty] ?? r.difficulty,
      difficulty: r.difficulty,
      source: r.source,
      status: r.status,
      mdPath: r.md_path
    }))
  })
  ipcMain.handle('wall:bankOpen', (_e, bankId: number) => {
    const row = getDb()
      .prepare('SELECT id, title, tag, difficulty, puzzle_text, status, my_answer, md_path FROM wall_bank WHERE id = ?')
      .get(bankId) as
      | {
          id: number
          title: string
          tag: string
          difficulty: string
          puzzle_text: string
          status: string
          my_answer: string | null
          md_path: string | null
        }
      | undefined
    if (!row) throw new Error('NOT_FOUND')
    // 不返回 answer_standard / solution——判答与看解答前不泄底
    return {
      id: row.id,
      title: row.title,
      tag: row.tag,
      difficulty: row.difficulty,
      diffZh: DIFFICULTY_ZH[row.difficulty] ?? row.difficulty,
      puzzle: row.puzzle_text,
      status: row.status,
      myAnswer: row.my_answer,
      mdPath: row.md_path
    }
  })
  ipcMain.handle('wall:bankAnswer', async (_e, jobId: string, bankId: number, myAnswer: string) => {
    const ac = beginJob(jobId)
    try {
      const a = myAnswer.trim()
      if (!a) throw new Error('EMPTY')
      const d = getDb()
      const row = d.prepare('SELECT * FROM wall_bank WHERE id = ?').get(bankId) as
        | {
            id: number
            title: string
            tag: string
            difficulty: string
            puzzle_text: string
            answer_standard: string
            solution: string
            source: string
            status: string
            my_answer: string | null
            md_path: string | null
          }
        | undefined
      if (!row) throw new Error('NOT_FOUND')
      if (row.status !== 'todo') throw new Error('ALREADY_ANSWERED')
      const verdict = await judgeWallAnswer(row.puzzle_text, row.answer_standard, row.solution, a, ac.signal)
      const mdPath = writeBankMd(row, a, verdict.correct, verdict.explanation)
      d.prepare(
        'UPDATE wall_bank SET status = ?, my_answer = ?, md_path = ?, updated_at = ? WHERE id = ?'
      ).run(verdict.correct ? 'solved' : 'failed', a, mdPath, nowIso(), bankId)
      return {
        correct: verdict.correct,
        standardAnswer: row.answer_standard,
        explanation: verdict.explanation,
        mdPath
      }
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('wall:bankReveal', (_e, bankId: number) => {
    const d = getDb()
    const row = d.prepare('SELECT * FROM wall_bank WHERE id = ?').get(bankId) as
      | {
          id: number
          title: string
          tag: string
          difficulty: string
          puzzle_text: string
          answer_standard: string
          solution: string
          source: string
          status: string
          my_answer: string | null
          md_path: string | null
        }
      | undefined
    if (!row) throw new Error('NOT_FOUND')
    if (row.status !== 'todo') throw new Error('ALREADY_ANSWERED')
    const mdPath = writeBankMd(row, null, false, '（选择直接看解答，未提交作答）')
    d.prepare('UPDATE wall_bank SET status = ?, md_path = ?, updated_at = ? WHERE id = ?').run(
      'failed',
      mdPath,
      nowIso(),
      bankId
    )
    return { standardAnswer: row.answer_standard, solution: row.solution, mdPath }
  })

  // ---------- 个人中心：我的画像（DB v9，致知己 specs §3） ----------
  ipcMain.handle('profile:list', () =>
    getDb().prepare('SELECT * FROM profile_facts ORDER BY id').all()
  )
  ipcMain.handle('profile:add', (_e, category: string, content: string, source?: string) => {
    if (!category.trim() || !content.trim()) throw new Error('FIELDS_REQUIRED')
    const now = nowIso()
    const r = getDb()
      .prepare(
        'INSERT INTO profile_facts (category, content, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(category.trim(), content.trim(), source === 'ai' ? 'ai' : 'manual', now, now)
    return Number(r.lastInsertRowid)
  })
  ipcMain.handle('profile:update', (_e, id: number, category: string, content: string) => {
    if (!category.trim() || !content.trim()) throw new Error('FIELDS_REQUIRED')
    getDb()
      .prepare('UPDATE profile_facts SET category = ?, content = ?, updated_at = ? WHERE id = ?')
      .run(category.trim(), content.trim(), nowIso(), id)
    return true
  })
  ipcMain.handle('profile:delete', (_e, id: number) => {
    getDb().prepare('DELETE FROM profile_facts WHERE id = ?').run(id)
    return true
  })

  // ---------- 个人中心：LLM/MCP ----------
  ipcMain.handle('llm:test', (_e, jobId: string, config: LlmConfig) => {
    const ac = beginJob(jobId)
    return testLlmConnection(config, ac.signal).finally(() => endJob(jobId))
  })
  ipcMain.handle('llm:models', (_e, config: LlmConfig) => listUpstreamModels(config))
  ipcMain.handle('mcp:listEnabled', () => getEnabledMcps())
  // AI 辅助 MCP 配置（问题疑惑区方案）：研究配置元数据 / 测试连接
  ipcMain.handle('mcp:research', (_e, jobId: string, name: string) => {
    const ac = beginJob(jobId)
    return researchMcpConfig(name, ac.signal).finally(() => endJob(jobId))
  })
  ipcMain.handle('mcp:test', (_e, jobId: string, config: McpConfig) => {
    const ac = beginJob(jobId)
    return testMcpConnection(config, ac.signal).finally(() => endJob(jobId))
  })

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

// ---------- 推理角辅助（turtle:* / wall:* 共用，specs §4） ----------

interface TurtleGameRow {
  id: number
  soup_id: number
  status: string
  question_count: number
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  md_path: string | null
}

interface WallPuzzleRow {
  id: number
  date: string
  puzzle_text: string
  answer_standard: string
  standard_reasoning: string | null
  hints: string
  puzzle_type: string
  difficulty: string
  status: string
  hints_used: number
  my_answer: string | null
  md_path: string | null
}

const DIFFICULTY_ZH: Record<string, string> = { easy: '简单', medium: '中等', hard: '困难' }
const WALL_TYPE_ZH: Record<string, string> = {
  logic_grid: '逻辑网格',
  truth_lie: '真假话推理',
  sequence: '序列推理',
  verbal_trap: '文字逻辑陷阱',
  // v1.2 洞察题型池（旧四类仅历史行显示用，不再生成）
  insight_invariant: '不变量与构造',
  strategy_protocol: '策略协议设计',
  counter_probability: '反直觉概率'
}

/** wall_puzzles.hints（JSON 列）→ string[]，容错解析 */
function parseWallHints(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string' && h.trim() !== '') : []
  } catch {
    return []
  }
}

/** 取进行中的局；局不存在或已终局抛错（防终局后继续提问） */
function getPlayingGame(d: ReturnType<typeof getDb>, gameId: number): TurtleGameRow {
  const game = d
    .prepare('SELECT * FROM turtle_games WHERE id = ? AND deleted_at IS NULL')
    .get(gameId) as TurtleGameRow | undefined
  if (!game) throw new Error('NOT_FOUND')
  if (game.status !== 'playing') throw new Error('GAME_FINISHED')
  return game
}

/** 汤三件套（裁判材料） */
function turtleMaterial(d: ReturnType<typeof getDb>, soupId: number): TurtleSoupMaterial {
  const soup = d
    .prepare('SELECT surface, bottom, analysis FROM turtle_soups WHERE id = ?')
    .get(soupId) as TurtleSoupMaterial | undefined
  if (!soup) throw new Error('NOT_FOUND')
  return soup
}

/** 最近问答历史文本（判答 prompt 注入用，防重复问；倒取最近 N 条再正序拼装） */
function turtleHistoryText(d: ReturnType<typeof getDb>, gameId: number, limit = 30): string {
  const msgs = d
    .prepare('SELECT type, content FROM turtle_game_messages WHERE game_id = ? ORDER BY id DESC LIMIT ?')
    .all(gameId, limit)
    .reverse() as { type: string; content: string }[]
  return msgs
    .map((m) => {
      if (m.type === 'question') return `我问：${m.content}`
      if (m.type === 'guess') return `我猜汤底：${m.content}`
      if (m.type === 'verdict') return `判定：${m.content}`
      if (m.type === 'notice') return ''
      return `裁判：${m.content}` // answer / invalid
    })
    .filter(Boolean)
    .join('\n')
}

function insertTurtleMsg(
  d: ReturnType<typeof getDb>,
  gameId: number,
  role: 'user' | 'assistant' | 'system',
  type: string,
  content: string,
  createdAt: string
): void {
  d.prepare(
    'INSERT INTO turtle_game_messages (game_id, role, type, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(gameId, role, type, content, createdAt)
}

/** 对局视图载荷（openSoup / game 共用）：进行中不暴露汤底（列表与后端均不含 bottom）；终局局带汤底/复盘供回看 */
function turtleGamePayload(gameId: number) {
  const d = getDb()
  const game = d
    .prepare('SELECT * FROM turtle_games WHERE id = ? AND deleted_at IS NULL')
    .get(gameId) as TurtleGameRow | undefined
  if (!game) throw new Error('NOT_FOUND')
  const soup = d
    .prepare('SELECT title, surface, difficulty, theme_tag, bottom FROM turtle_soups WHERE id = ?')
    .get(game.soup_id) as
    | { title: string; surface: string; difficulty: string; theme_tag: string; bottom: string }
    | undefined
  if (!soup) throw new Error('NOT_FOUND')
  const messages = d
    .prepare(
      'SELECT id, role, type, content, created_at FROM turtle_game_messages WHERE game_id = ? ORDER BY id ASC'
    )
    .all(gameId)
  return {
    gameId: game.id,
    title: soup.title,
    surface: soup.surface,
    difficulty: soup.difficulty,
    theme: soup.theme_tag,
    status: game.status,
    questionCount: game.question_count,
    startedAt: game.started_at,
    messages,
    // 终局回看（问题疑惑区第8轮）：额外暴露汤底与复盘路径；进行中不暴露
    ...(game.status === 'playing'
      ? {}
      : { bottom: soup.bottom, mdPath: game.md_path, durationMs: game.duration_ms })
  }
}

/**
 * 终局链（specs §4，guess 破汤与 abandon 共用）：点评 → 拼对局记录 md（快照式，
 * 含汤面汤底全文）→ 更新局行与汤状态。点评失败降级为固定文案，不阻断终局。
 */
async function finishTurtleGame(
  gameId: number,
  result: 'solved' | 'abandoned',
  signal?: AbortSignal
): Promise<{ bottom: string; mdPath: string }> {
  const d = getDb()
  const game = d
    .prepare('SELECT * FROM turtle_games WHERE id = ? AND deleted_at IS NULL')
    .get(gameId) as TurtleGameRow | undefined
  if (!game) throw new Error('NOT_FOUND')
  const soup = d
    .prepare('SELECT title, surface, bottom, analysis, difficulty, theme_tag FROM turtle_soups WHERE id = ?')
    .get(game.soup_id) as
    | {
        title: string
        surface: string
        bottom: string
        analysis: string
        difficulty: string
        theme_tag: string
      }
    | undefined
  if (!soup) throw new Error('NOT_FOUND')
  const msgs = d
    .prepare('SELECT type, content FROM turtle_game_messages WHERE game_id = ? ORDER BY id ASC')
    .all(gameId) as { type: string; content: string }[]
  const fmtMsg = (m: { type: string; content: string }): string => {
    switch (m.type) {
      case 'question':
        return `**我**：${m.content}`
      case 'guess':
        return `> **我猜汤底**：${m.content}`
      case 'verdict':
        return `> **判定**：${m.content}`
      case 'notice':
        return `*（${m.content}）*`
      default:
        return `**裁判**：${m.content}` // answer / invalid
    }
  }
  const transcript = msgs.map(fmtMsg).join('\n\n')
  let review = ''
  try {
    review = await soupReview(
      { surface: soup.surface, bottom: soup.bottom, analysis: soup.analysis },
      transcript,
      result,
      game.question_count,
      signal
    )
  } catch {
    review = '（AI 点评生成失败，可重读上方问答自行复盘。）'
  }
  const now = new Date()
  const duration = now.getTime() - new Date(game.started_at).getTime()
  const mdPath = `md/turtle/${gameId}.md`
  const lastGuess = [...msgs].reverse().find((m) => m.type === 'guess')
  mdWrite(
    mdPath,
    `# ${soup.title}（${DIFFICULTY_ZH[soup.difficulty] ?? soup.difficulty} · ${soup.theme_tag}）\n\n> ${
      result === 'solved' ? '已破汤' : '弃汤'
    } · 提问 ${game.question_count} 次 · 用时 ${fmtDuration(duration)}\n\n## 汤面\n\n${
      soup.surface
    }\n\n## 汤底\n\n${soup.bottom}\n\n## 问答全程\n\n${transcript}\n${
      lastGuess ? `\n## 最终推理\n\n${lastGuess.content}\n` : ''
    }\n## AI 点评\n\n${review}\n`
  )
  d.prepare(
    'UPDATE turtle_games SET status = ?, ended_at = ?, duration_ms = ?, md_path = ?, updated_at = ? WHERE id = ?'
  ).run(result, now.toISOString(), duration, mdPath, now.toISOString(), gameId)
  d.prepare('UPDATE turtle_soups SET status = ?, updated_at = ? WHERE id = ?').run(
    result,
    now.toISOString(),
    game.soup_id
  )
  return { bottom: soup.bottom, mdPath }
}

/** 毫秒 → m:ss / h:mm:ss（对局用时展示） */
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

/** wall_puzzles 行 → 渲染层今日题载荷（hints 只暴露条数，不暴露内容） */
function wallPayload(row: unknown) {
  const r = row as WallPuzzleRow
  return {
    phase: r.status === 'answering' ? ('answering' as const) : ('done' as const),
    puzzleId: r.id,
    date: r.date,
    puzzle: r.puzzle_text,
    puzzleType: r.puzzle_type,
    typeZh: WALL_TYPE_ZH[r.puzzle_type] ?? r.puzzle_type,
    difficulty: r.difficulty,
    diffZh: DIFFICULTY_ZH[r.difficulty] ?? r.difficulty,
    status: r.status,
    hintsUsed: r.hints_used,
    hintsTotal: parseWallHints(r.hints).length,
    myAnswer: r.my_answer,
    mdPath: r.md_path
  }
}

// ---------- 思维墙·练习场（会话级暂存；不计入墙/连胜/月历，重启即清） ----------

interface PracticeEntry {
  puzzle: string
  answer: string
  /** 标准论证（判答讲解注入用，会话级） */
  reasoning: string
  hints: string[]
  hintsUsed: number
  typeZh: string
  diffZh: string
}

const practiceBank = new Map<number, PracticeEntry>()
let practiceSeq = 0

/** 精选题库详情 md（作答终局 / 看解答共用，局终一次写入 md/wall/bank/{id}.md） */
function writeBankMd(
  row: {
    id: number
    title: string
    tag: string
    difficulty: string
    puzzle_text: string
    answer_standard: string
    solution: string
    source: string
  },
  myAnswer: string | null,
  correct: boolean,
  explanation: string
): string {
  const mdPath = `md/wall/bank/${row.id}.md`
  mdWrite(
    mdPath,
    `# ${row.title}（${row.tag} · ${DIFFICULTY_ZH[row.difficulty] ?? row.difficulty}）\n\n> 来源：${row.source}\n\n## 题面\n\n${row.puzzle_text}\n\n## 我的作答\n\n${
      myAnswer ?? '（未作答，选择直接看解答）'
    }\n\n## 判定\n\n${
      correct ? '已破' : '未破'
    }（标准答案：${row.answer_standard}）\n\n## 讲解\n\n${explanation}\n\n## 标准论证\n\n${row.solution}\n`
  )
  return mdPath
}
