// IPC 全通道注册（主进程）：渲染层 window.api.* 的后端
import { ipcMain, dialog, BrowserWindow, shell, app, clipboard } from 'electron'
import { getDb, nowIso, normalizeText, isDupMotto, stripMottoNoteHeader } from './db/db'
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
  clearAiSession
} from './ai/services'
import { chatCompletion, testLlmConnection, listUpstreamModels } from './ai/llm'
import { getEnabledMcps } from './ai/mcp'
import { researchMcpConfig, testMcpConnection } from './ai/mcpResearch'
import { SettingsKeys } from '../src/shared/types'
import type { AiChannel, LlmConfig, McpConfig } from '../src/shared/types'
import { copyFileSync, unlinkSync } from 'node:fs'
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

  // ---------- 通用条目操作（五模块列表共用模式） ----------
  type ItemKind = 'mottos' | 'wiki_entries' | 'inspirations' | 'verify_records' | 'zhijiji_questions'
  const RECYCLE_MAP: Record<string, 'mottos' | 'wiki' | 'inspirations' | 'verify' | 'zhijiji'> = {
    mottos: 'mottos',
    wiki_entries: 'wiki',
    inspirations: 'inspirations',
    verify_records: 'verify',
    zhijiji_questions: 'zhijiji'
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
  ipcMain.handle('ai:messages', (_e, sessionId: number) => listAiMessages(sessionId))
  ipcMain.handle(
    'ai:chat',
    async (_e, message: string, currentModule: string, sessionId: number, channel?: string) => {
      return await aiChat(message, currentModule, sessionId, (channel ?? 'assistant') as AiChannel)
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
  // /compact：会话历史压缩为前情摘要另存新会话（优化建议区第14轮）
  ipcMain.handle('aiSession:compact', (_e, sessionId: number) => compactAiSession(sessionId))
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
  ipcMain.handle('mottos:generate', () => generateMottos())
  ipcMain.handle('mottos:normalize', (_e, s: string) => normalizeText(s))
  ipcMain.handle('mottos:deleteForever', (_e, id: number) => {
    // 直接删除（优化建议区）：越过回收站彻底删除，连带笔记 md（同 hardDelete 的处理口径）
    const row = getDb().prepare('SELECT note_path FROM mottos WHERE id = ?').get(id) as
      | { note_path: string | null }
      | undefined
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
  ipcMain.handle('wiki:generate', async (_e, term: string | null, sectionId: number | null) => {
    try {
      // 必须在此 await：若把 generateWikiCard 的 Promise 嵌进返回对象，
      // ipcMain.handle 只 await 顶层值，嵌套 Promise 序列化失败 → 渲染层 invoke 永不 settle（卡"生成中"）
      return { ok: true as const, data: await generateWikiCard(term, sectionId) }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.startsWith('CONFLICT:')) return { ok: false as const, conflict: msg.slice(9) }
      throw e
    }
  })
  // 随机词条名（手动弹窗骰子/指定板块随机生成）：只构思词条名不生成卡片
  ipcMain.handle('wiki:suggestTerm', async (_e, sectionId: number | null) => {
    const r = await suggestWikiTerm(sectionId)
    return r.term
  })
  // 测一测：随机 5 张卡片批量出四选一（优化建议区）
  ipcMain.handle('wiki:quiz', async () => {
    return await generateWikiQuiz()
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
  ipcMain.handle('inspirations:generate', async () => generateInspirations())
  ipcMain.handle('inspirations:refine', async (_e, id: number) => refineInspiration(id))
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
    async (_e, title: string, tags?: string[], aiInit?: boolean) => {
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
          temperature: 0.7
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
  ipcMain.handle('llm:test', (_e, config: LlmConfig) => testLlmConnection(config))
  ipcMain.handle('llm:models', (_e, config: LlmConfig) => listUpstreamModels(config))
  ipcMain.handle('mcp:listEnabled', () => getEnabledMcps())
  // AI 辅助 MCP 配置（问题疑惑区方案）：研究配置元数据 / 测试连接
  ipcMain.handle('mcp:research', (_e, name: string) => researchMcpConfig(name))
  ipcMain.handle('mcp:test', (_e, config: McpConfig) => testMcpConnection(config))

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
