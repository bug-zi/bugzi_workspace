// IPC 全通道注册（主进程）：渲染层 window.api.* 的后端
import { ipcMain, dialog, BrowserWindow, shell, app, clipboard } from 'electron'
import { getDb, nowIso, normalizeText, isDupMotto, stripMottoNoteHeader, recordMottoTombstone } from './db/db'
import { getSetting, setSetting, getAllSettings } from './db/settings'
import { mdRead, mdWrite, mdDelete, mdCreate } from './services/files'
import { discardToRecycle, restoreFromRecycle, hardDelete, listRecycle } from './services/recycle'
import { scheduleMottoTask } from './services/scheduler'
import { ensureReasoningStock, freshSoupCount } from './services/reasoningStock'
import { ensureWikiStock, drawPoolCard } from './services/wikiStock'
import { ensureDailyQueue, ensureLearnStock, addDaysLocal } from './services/learnStock'
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
  generateLearnTree,
  generateLearnCard,
  expandLearnTopic,
  generateLearnQuiz,
  gradeLearnQuiz,
  generateLearnTask,
  reviewLearnTask,
  digLearnCard,
  suggestZhijiQuestions,
  rateZhijiQuestions,
  generateInspirations,
  refineInspiration,
  runVerification,
  runQaAnswer,
  runProphetAnalysis,
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
import {
  importBooks,
  listBooks,
  readBookFile,
  saveProgress,
  deleteBook,
  listNotes,
  addNote,
  updateNote,
  removeNote,
  listMarks,
  addMark,
  updateMark,
  removeMark,
  setReadingPref,
  addReadTime,
  readStats,
  notesOverview,
  exportNotesFile
} from './services/books'
import {
  listFeeds,
  fetchAllFeeds,
  probeFeed,
  addFeed,
  renameFeed,
  removeFeed,
  listArticles,
  openArticle,
  markAllRead,
  setArticleRead,
  setArticleFavorite,
  summarizeArticle
} from './services/feed'
import {
  listFavorites,
  addFavoriteItem,
  updateFavoriteItem,
  deleteFavoriteItem,
  addCategory,
  renameCategory,
  moveCategory,
  deleteCategory,
  fetchMeta as fetchFavoriteMeta
} from './services/favorites'
import type { FeedView, FavoriteItemPatch } from '../src/shared/types'
import {
  listAccounts,
  saveAccount,
  removeAccount,
  listCategories,
  saveCategory,
  removeCategory,
  listTx,
  saveTx,
  removeTx,
  stats
} from './services/ledger'
import type { LedgerTxInput } from './services/ledger'
import { SettingsKeys } from '../src/shared/types'
import { refreshTrayMenu } from './services/tray'
import type { AiChannel, LlmConfig, McpConfig, LearnDailyRow, LearnQuizQuestion, LearnQuizAnswer, LearnQuizView, LearnTaskRow, ZhijijiQuestionCandidate } from '../src/shared/types'
import { copyFileSync, unlinkSync, writeFileSync, readdirSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { userDataDir, yyMMdd } from './db/db'
import { currentDataDir, migrateDataDir } from './services/storage'
import { createTerminal, writeTerminal, resizeTerminal, killTerminal } from './services/terminal'
import type { TerminalCreateOpts } from './services/terminal'

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

  // ---------- app（开机自启） ----------
  ipcMain.handle('app:setLaunchOnBoot', (_e, on: boolean) => {
    setSetting(SettingsKeys.LaunchOnBoot, on ? '1' : '0')
    app.setLoginItemSettings({ openAtLogin: on })
    refreshTrayMenu()
    return true
  })

  // ---------- terminal（260912 内置终端） ----------
  ipcMain.handle('terminal:create', (_e, id: string, opts: TerminalCreateOpts) =>
    createTerminal({ id, cwd: opts.cwd, shell: opts.shell })
  )
  ipcMain.handle('terminal:write', (_e, id: string, data: string) => writeTerminal(id, data))
  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number) =>
    resizeTerminal(id, cols, rows)
  )
  ipcMain.handle('terminal:kill', (_e, id: string) => killTerminal(id))

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

  // ---------- 背景素材库（优化建议区第36轮：文件系统为真相源，light/dark 两组独立） ----------
  const BG_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']
  /** 每组素材上限 */
  const BG_MAX_PER_GROUP = 20

  const bgGroupDir = (group: 'light' | 'dark'): string => join(userDataDir(), 'bg', group)

  /** 列出某组素材文件名（新上传在前；只认图片扩展；目录缺失自动创建） */
  function bgListFiles(group: 'light' | 'dark'): string[] {
    const dir = bgGroupDir(group)
    mkdirSync(dir, { recursive: true })
    return readdirSync(dir)
      .filter((f) => BG_EXTS.includes(f.split('.').pop()?.toLowerCase() ?? ''))
      .sort((a, b) => b.localeCompare(a))
  }

  /** 一次性迁移（幂等，registerIpc 注册时执行）：旧单图 bg/bg-light.ext → bg/light/bg-light.ext，dark 同理；
   *  文件名保持原名（settings 已指向它，零额外改动）；组目录已有文件即跳过；失败静默（旧图原地不动，现有行为不受影响） */
  function migrateBgLibrary(): void {
    for (const group of ['light', 'dark'] as const) {
      const dir = bgGroupDir(group)
      try {
        if (readdirSync(dir).length > 0) continue
      } catch {
        /* 目录不存在 → 继续迁移 */
      }
      for (const ext of BG_EXTS) {
        const oldFile = `bg-${group}.${ext}`
        try {
          mkdirSync(dir, { recursive: true })
          renameSync(join(userDataDir(), 'bg', oldFile), join(dir, oldFile))
          break // 每组最多一个旧文件
        } catch {
          /* 无此扩展旧文件，试下一个 */
        }
      }
    }
  }

  // 背景素材库一次性迁移（幂等；失败静默不影响任何现有行为——须在上方工具 const 初始化后调用，防 TDZ）
  try {
    migrateBgLibrary()
  } catch {
    /* 静默 */
  }

  // ---------- 头像上传 / 背景素材库 ----------
  ipcMain.handle(
    'image:pick',
    async (_e, kind: 'avatar' | 'reader-bg') => {
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
      for (const old of BG_EXTS) {
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
      // reader-bg 为藏书架阅读背景单槽位（260911 阅读背景设计 §四），settings 键走常量；
      // 项目背景图 bg-light/bg-dark 已升级为素材库（image:bg* 四通道），不再走本通道
      dest = join(userDataDir(), 'bg', `reader-bg.${ext}`)
      setSetting(SettingsKeys.ReaderBgImage, `reader-bg.${ext}`)
      // 删掉旧的其他扩展版本
      for (const old of BG_EXTS) {
        if (old !== ext) {
          try {
            unlinkSync(join(userDataDir(), 'bg', `reader-bg.${old}`))
          } catch {
            /* 无旧文件 */
          }
        }
      }
    }
    copyFileSync(src, dest)
    return true
    }
  )

  ipcMain.handle('image:bgList', (_e, group: 'light' | 'dark'): string[] => bgListFiles(group))

  // 多选上传入组；单张自动设为当前背景（applied=文件名），多张只入库（applied=null）
  ipcMain.handle(
    'image:bgUpload',
    async (_e, group: 'light' | 'dark'): Promise<{ list: string[]; applied: string | null } | null> => {
      const r = await dialog.showOpenDialog(win()!, {
        title: '选择背景图片（可多选）',
        filters: [{ name: '图片', extensions: BG_EXTS }],
        properties: ['openFile', 'multiSelections']
      })
      if (r.canceled || r.filePaths.length === 0) return null
      const dir = bgGroupDir(group)
      if (bgListFiles(group).length + r.filePaths.length > BG_MAX_PER_GROUP) {
        throw new Error(`素材库已达上限（每组 ${BG_MAX_PER_GROUP} 张），请先删除部分素材`)
      }
      let applied: string | null = null
      for (const src of r.filePaths) {
        const ext = src.split('.').pop()?.toLowerCase() ?? 'png'
        const name = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`
        copyFileSync(src, join(dir, name))
        if (r.filePaths.length === 1) applied = name
      }
      if (applied) setSetting(`bg_bg-${group}`, applied)
      return { list: bgListFiles(group), applied }
    }
  )

  // 设某张为当前使用（校验在库 + 文件名安全）
  ipcMain.handle('image:bgUse', (_e, group: 'light' | 'dark', file: string): boolean => {
    if (!/^[\w.-]+$/.test(file)) return false
    if (!bgListFiles(group).includes(file)) return false
    setSetting(`bg_bg-${group}`, file)
    return true
  })

  // 删某张；删的是当前使用图时置空 settings 回退纯色（wasUsing 供渲染层 refreshBg）
  ipcMain.handle(
    'image:bgDelete',
    (_e, group: 'light' | 'dark', file: string): { list: string[]; wasUsing: boolean } => {
      if (!/^[\w.-]+$/.test(file)) throw new Error('非法文件名')
      unlinkSync(join(bgGroupDir(group), file))
      const wasUsing = getSetting(`bg_bg-${group}`) === file
      if (wasUsing) setSetting(`bg_bg-${group}`, '')
      return { list: bgListFiles(group), wasUsing }
    }
  )

  // ---------- 通用条目操作（各模块列表共用模式） ----------
  type ItemKind =
    | 'mottos'
    | 'wiki_entries'
    | 'inspirations'
    | 'verify_records'
    | 'qa_records'
    | 'zhijiji_questions'
    | 'turtle_soups'
    | 'turtle_games'
    | 'drafts'
  const RECYCLE_MAP: Record<
    string,
    | 'mottos'
    | 'wiki'
    | 'inspirations'
    | 'verify'
    | 'qa'
    | 'zhijiji'
    | 'reasoning_soup'
    | 'reasoning_game'
    | 'drafts'
    | 'canvases'
  > = {
    mottos: 'mottos',
    wiki_entries: 'wiki',
    inspirations: 'inspirations',
    verify_records: 'verify',
    qa_records: 'qa',
    zhijiji_questions: 'zhijiji',
    turtle_soups: 'reasoning_soup',
    turtle_games: 'reasoning_game',
    drafts: 'drafts',
    canvases: 'canvases'
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
    // 待学习/已学会词条仍阻删（原口径）；后库池卡用户不可见（260910 待学习区），
    // 随板块物理清理（含 md）——不可成为「看起来空却删不掉」的死局；板块存续时泵会自动补回
    const count = d.prepare("SELECT COUNT(*) AS c FROM wiki_entries WHERE section_id = ? AND deleted_at IS NULL AND state != 'pool'").get(id) as { c: number }
    if (count.c > 0) throw new Error('SECTION_NOT_EMPTY')
    const poolRows = d.prepare("SELECT md_path FROM wiki_entries WHERE section_id = ? AND state = 'pool'").all(id) as { md_path: string | null }[]
    d.prepare("DELETE FROM wiki_entries WHERE section_id = ? AND state = 'pool'").run(id)
    for (const r of poolRows) if (r.md_path) mdDelete(r.md_path)
    d.prepare('DELETE FROM wiki_sections WHERE id = ?').run(id)
    return true
  })
  // 板块页只列已学会词条（260910 待学习区）：learn 态在待学习区页、pool 态用户不可见
  ipcMain.handle('wiki:entries', (_e, sectionId: number) =>
    getDb().prepare("SELECT * FROM wiki_entries WHERE section_id = ? AND deleted_at IS NULL AND state = 'learned' ORDER BY id DESC").all(sectionId)
  )
  ipcMain.handle('wiki:entry', (_e, id: number) =>
    getDb().prepare('SELECT * FROM wiki_entries WHERE id = ?').get(id)
  )
  ipcMain.handle('wiki:updateEntry', (_e, id: number, term: string, summary: string) => {
    getDb().prepare('UPDATE wiki_entries SET term = ?, summary = ?, updated_at = ? WHERE id = ?').run(term, summary, nowIso(), id)
    return true
  })
  ipcMain.handle('wiki:generate', async (_e, jobId: string, term: string | null, sectionId: number | null) => {
    // 随机抽卡池优先（260910 待学习区）：抽中池卡原地转 learn 态秒回（无 LLM 调用，
    // 池卡入库时已查重故无 CONFLICT 路径），随后消耗后触发补泵；池空才兜底现场生成
    if (!term) {
      const drawn = drawPoolCard(sectionId)
      if (drawn) {
        void ensureWikiStock()
        return { ok: true as const, data: { entryId: drawn.id, term: drawn.term, summary: drawn.summary } }
      }
    }
    const ac = beginJob(jobId)
    try {
      // 必须在此 await：若把 generateWikiCard 的 Promise 嵌进返回对象，
      // ipcMain.handle 只 await 顶层值，嵌套 Promise 序列化失败 → 渲染层 invoke 永不 settle（卡"生成中"）
      // state='learn'（默认）：用户随机/手动生成的卡片一律先入待学习区
      return { ok: true as const, data: await generateWikiCard(term, sectionId, ac.signal) }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.startsWith('CONFLICT:')) {
        // 撞词词条可能在待学习区（板块页 entries 只列 learned），主进程带回 id 供「查看原卡片」直达；
        // 池卡（pool）用户不可见，跳过（仅池卡撞词时无跳转，只提示已存在）
        const dup = getDb()
          .prepare(
            "SELECT id FROM wiki_entries WHERE term = ? AND deleted_at IS NULL AND state != 'pool' ORDER BY id LIMIT 1"
          )
          .get(msg.slice(9)) as { id: number } | undefined
        return { ok: false as const, conflict: msg.slice(9), conflictId: dup?.id ?? null }
      }
      throw e
    } finally {
      endJob(jobId)
    }
  })
  // 待学习列表（260910 待学习区）：state='learn' 联表板块名，新卡在前
  ipcMain.handle('wiki:learnEntries', () =>
    getDb().prepare("SELECT e.*, s.name AS section_name FROM wiki_entries e JOIN wiki_sections s ON e.section_id = s.id WHERE e.state = 'learn' AND e.deleted_at IS NULL ORDER BY e.id DESC").all()
  )
  // 学会了/已学会 切换：learn ↔ learned（state 守卫防误改池卡）
  ipcMain.handle('wiki:setLearned', (_e, id: number, learned: boolean) => {
    getDb().prepare("UPDATE wiki_entries SET state = ?, updated_at = ? WHERE id = ? AND state != 'pool'").run(learned ? 'learned' : 'learn', nowIso(), id)
    return true
  })
  // 后库补充泵触发（进万象库模块，照 reasoning:stockCheck 模式）：fire-and-forget 秒回
  ipcMain.handle('wiki:stockCheck', () => {
    void ensureWikiStock()
    return true
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

  // ---------- 学习库（2026-09-11-学习库-design.md） ----------
  /** 知识点卡片行通用 SQL（联领域/主题名；弹窗 titleTag 与列表行共用） */
  const learnCardSql = `SELECT n.*, dom.name AS domain_name, t.title AS topic_title
    FROM learn_nodes n
    JOIN learn_domains dom ON n.domain_id = dom.id
    LEFT JOIN learn_nodes t ON n.parent_id = t.id
    WHERE n.deleted_at IS NULL AND n.level = 2`

  ipcMain.handle('learn:domains', () =>
    getDb()
      .prepare(
        `SELECT d.*,
          (SELECT COUNT(*) FROM learn_nodes n WHERE n.domain_id = d.id AND n.level = 2 AND n.deleted_at IS NULL) AS total,
          (SELECT COUNT(*) FROM learn_nodes n WHERE n.domain_id = d.id AND n.level = 2 AND n.deleted_at IS NULL AND n.state = 'learned') AS learned
         FROM learn_domains d ORDER BY d.sort`
      )
      .all()
  )
  ipcMain.handle('learn:domainCreate', (_e, name: string) => {
    const d = getDb()
    const max = d.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM learn_domains').get() as {
      m: number
    }
    try {
      const r = d
        .prepare('INSERT INTO learn_domains (name, sort, created_at) VALUES (?, ?, ?)')
        .run(name, max.m + 1, nowIso())
      return Number(r.lastInsertRowid)
    } catch {
      throw new Error('CONFLICT:' + name) // name UNIQUE 撞名
    }
  })
  ipcMain.handle('learn:domainRename', (_e, id: number, name: string) => {
    try {
      getDb().prepare('UPDATE learn_domains SET name = ? WHERE id = ?').run(name, id)
      return true
    } catch {
      throw new Error('CONFLICT:' + name)
    }
  })
  ipcMain.handle('learn:domainDelete', (_e, id: number) => {
    const d = getDb()
    // 领域清空才能删（设计 §三：无主题行方可删——主题层被删光的前提是知识点已清空）
    const count = d
      .prepare('SELECT COUNT(*) AS c FROM learn_nodes WHERE domain_id = ? AND level = 1')
      .get(id) as { c: number }
    if (count.c > 0) throw new Error('DOMAIN_NOT_EMPTY')
    d.prepare('DELETE FROM learn_domains WHERE id = ?').run(id)
    return true
  })
  ipcMain.handle('learn:generateTree', async (_e, jobId: string, domainId: number) => {
    const ac = beginJob(jobId)
    try {
      return await generateLearnTree(domainId, ac.signal)
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('learn:tree', (_e, domainId: number) => {
    const d = getDb()
    const topics = d
      .prepare(
        'SELECT * FROM learn_nodes WHERE domain_id = ? AND level = 1 AND deleted_at IS NULL ORDER BY id'
      )
      .all(domainId) as { id: number; title: string }[]
    return topics.map((t) => {
      const points = d
        .prepare(
          'SELECT * FROM learn_nodes WHERE parent_id = ? AND level = 2 AND deleted_at IS NULL ORDER BY id'
        )
        .all(t.id) as { state: string }[]
      return {
        id: t.id,
        title: t.title,
        total: points.length,
        learned: points.filter((p) => p.state === 'learned').length,
        points
      }
    })
  })
  ipcMain.handle('learn:topicCreate', (_e, domainId: number, title: string) => {
    const r = getDb()
      .prepare('INSERT INTO learn_nodes (domain_id, level, title, created_at) VALUES (?, 1, ?, ?)')
      .run(domainId, title, nowIso())
    return Number(r.lastInsertRowid)
  })
  ipcMain.handle('learn:topicRename', (_e, id: number, title: string) => {
    getDb().prepare('UPDATE learn_nodes SET title = ? WHERE id = ? AND level = 1').run(title, id)
    return true
  })
  ipcMain.handle('learn:topicDelete', (_e, id: number) => {
    const d = getDb()
    // 判空含回收站中未彻底删的知识点（设计 §三：保证回收站恢复目标主题永远存在，无孤儿）
    const count = d
      .prepare('SELECT COUNT(*) AS c FROM learn_nodes WHERE parent_id = ? AND level = 2')
      .get(id) as { c: number }
    if (count.c > 0) throw new Error('TOPIC_NOT_EMPTY')
    // 级联彻底删该主题实战任务与三份 md（升级设计 §三：任务不入回收站）
    const tasks = d
      .prepare('SELECT task_md, homework_md, review_md FROM learn_tasks WHERE topic_id = ?')
      .all(id) as { task_md: string; homework_md: string | null; review_md: string | null }[]
    for (const t of tasks) {
      mdDelete(t.task_md)
      mdDelete(t.homework_md)
      mdDelete(t.review_md)
    }
    d.prepare('DELETE FROM learn_tasks WHERE topic_id = ?').run(id)
    d.prepare('DELETE FROM learn_nodes WHERE id = ?').run(id)
    return true
  })
  ipcMain.handle('learn:expandTopic', async (_e, jobId: string, topicId: number) => {
    const ac = beginJob(jobId)
    try {
      return await expandLearnTopic(topicId, ac.signal)
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('learn:nodeAdd', async (_e, jobId: string, topicId: number, title: string) => {
    const d = getDb()
    const dup = d
      .prepare('SELECT id FROM learn_nodes WHERE parent_id = ? AND title = ?')
      .get(topicId, title)
    if (dup) throw new Error('CONFLICT:' + title)
    const topic = d
      .prepare('SELECT domain_id FROM learn_nodes WHERE id = ? AND level = 1')
      .get(topicId) as { domain_id: number } | undefined
    if (!topic) throw new Error('NOT_FOUND')
    const r = d
      .prepare(
        "INSERT INTO learn_nodes (domain_id, parent_id, level, title, source, created_at) VALUES (?, ?, 2, ?, 'manual', ?)"
      )
      .run(topic.domain_id, topicId, title, nowIso())
    const id = Number(r.lastInsertRowid)
    const ac = beginJob(jobId)
    try {
      // 手动添加即生成完整卡片（工作即学即用入口，万象库手动输入同款体验）
      await generateLearnCard(id, ac.signal)
    } finally {
      endJob(jobId)
    }
    return d.prepare(`${learnCardSql} AND n.id = ?`).get(id)
  })
  ipcMain.handle('learn:nodeDelete', (_e, id: number) => {
    discardToRecycle('learn', id)
    win()?.webContents.send('recycle:changed')
    return true
  })
  ipcMain.handle('learn:getCard', async (_e, jobId: string, id: number) => {
    const d = getDb()
    const row = d.prepare(`${learnCardSql} AND n.id = ?`).get(id) as { content_ready: number } | undefined
    if (!row) throw new Error('NOT_FOUND')
    if (row.content_ready === 0) {
      // 骨架先行兜底：未生成的卡点开时现场生成（可取消；常态泵已备好秒回）
      const ac = beginJob(jobId)
      try {
        await generateLearnCard(id, ac.signal)
      } finally {
        endJob(jobId)
      }
    }
    return d.prepare(`${learnCardSql} AND n.id = ?`).get(id)
  })
  ipcMain.handle('learn:daily', () => {
    ensureDailyQueue() // 幂等定档（纯 SQL）；随后 fire-and-forget 泵补内容
    void ensureLearnStock()
    const d = getDb()
    const row = d
      .prepare('SELECT new_ids, review_ids FROM learn_daily WHERE date = ?')
      .get(localDateStr()) as { new_ids: string; review_ids: string } | undefined
    if (!row) return { new: [], review: [] }
    const byId = new Map<number, LearnDailyRow>()
    const all = [
      ...(JSON.parse(row.new_ids) as number[]),
      ...(JSON.parse(row.review_ids) as number[])
    ]
    if (all.length > 0) {
      const rows = d
        .prepare(`${learnCardSql} AND n.id IN (${all.map(() => '?').join(',')})`)
        .all(...all) as unknown as LearnDailyRow[]
      for (const r of rows) byId.set(r.id, r)
    }
    const pick = (arr: number[]): LearnDailyRow[] =>
      arr.map((i) => byId.get(i)).filter((r): r is LearnDailyRow => r != null)
    return {
      new: pick(JSON.parse(row.new_ids) as number[]),
      review: pick(JSON.parse(row.review_ids) as number[])
    }
  })
  ipcMain.handle('learn:randomOne', async (_e, jobId: string) => {
    const d = getDb()
    // 已生成的未学卡优先（秒开——泵产即备选池）；无才现场生成（生成中可取消）
    const ready = d
      .prepare(`${learnCardSql} AND n.state = 'todo' AND n.content_ready = 1`)
      .all() as { id: number }[]
    const pool = ready.length > 0 ? ready : (d.prepare(`${learnCardSql} AND n.state = 'todo'`).all() as { id: number }[])
    if (pool.length === 0) throw new Error('没有可学的知识点：去知识树建树、AI 展开主题或手动添加')
    const picked = pool[Math.floor(Math.random() * pool.length)]
    if (ready.length === 0) {
      const ac = beginJob(jobId)
      try {
        await generateLearnCard(picked.id, ac.signal)
      } finally {
        endJob(jobId)
      }
    }
    return d.prepare(`${learnCardSql} AND n.id = ?`).get(picked.id)
  })
  // ---------- 学习库 v2.0：每日小测（升级设计 §二；一天一卷，作答实时存库，检验不惩罚） ----------
  type LearnQuizDbRow = {
    date: string
    node_ids: string
    questions: string
    answers: string
    status: string
    created_at: string
    graded_at: string | null
  }
  /** DB 行 → 渲染层视图：联节点标题；answering 态隐去答案与解析（防抄答案） */
  const quizViewOf = (row: LearnQuizDbRow): LearnQuizView => {
    const questions = JSON.parse(row.questions) as LearnQuizQuestion[]
    const titled = questions.map((q) => {
      const r = getDb().prepare('SELECT title FROM learn_nodes WHERE id = ?').get(q.nodeId) as
        | { title: string }
        | undefined
      return { ...q, nodeTitle: r?.title ?? '' }
    })
    return {
      date: row.date,
      status: row.status as LearnQuizView['status'],
      questions:
        row.status === 'answering'
          ? titled.map((q) => ({ ...q, answerIndex: undefined, acceptable: undefined, answer: '', analysis: '' }))
          : titled,
      answers: JSON.parse(row.answers) as LearnQuizAnswer[]
    }
  }
  /** blank 归一化：去空格 + 全角转半角 + 小写（宽松比对，命中任一可接受答案即对） */
  const normBlank = (s: string): string =>
    String(s)
      .trim()
      .toLowerCase()
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\s+/g, '')
  const quizRowOfToday = (): LearnQuizDbRow | undefined =>
    getDb().prepare('SELECT * FROM learn_quiz WHERE date = ?').get(localDateStr()) as
      | LearnQuizDbRow
      | undefined
  ipcMain.handle('learn:quizGet', () => {
    const row = quizRowOfToday()
    return row ? quizViewOf(row) : null
  })
  ipcMain.handle('learn:quizCreate', async (_e, jobId: string, force?: boolean) => {
    const d = getDb()
    const today = localDateStr()
    const has = quizRowOfToday()
    if (has && !force) return quizViewOf(has) // 一天一卷幂等：重复点击直接返回既有卷；force=true 换一张（覆盖旧卷）
    const daily = d.prepare('SELECT new_ids FROM learn_daily WHERE date = ?').get(today) as
      | { new_ids: string }
      | undefined
    const newIds = daily ? (JSON.parse(daily.new_ids) as number[]) : []
    if (newIds.length === 0) throw new Error('今日还没有可测的卡：先在「今日新学」学会至少 2 张')
    const learned = d
      .prepare(
        `SELECT id FROM learn_nodes WHERE state = 'learned' AND deleted_at IS NULL
         AND id IN (${newIds.map(() => '?').join(',')})`
      )
      .all(...newIds) as { id: number }[]
    if (learned.length < 2) throw new Error('今日已学会的卡不足 2 张，先学习再小测')
    const ac = beginJob(jobId)
    try {
      const questions = await generateLearnQuiz(learned.map((r) => r.id), ac.signal)
      d.prepare('DELETE FROM learn_quiz WHERE date = ?').run(today)
      d.prepare(
        'INSERT INTO learn_quiz (date, node_ids, questions, answers, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(today, JSON.stringify(learned.map((r) => r.id)), JSON.stringify(questions), '[]', 'answering', nowIso())
    } finally {
      endJob(jobId)
    }
    return quizViewOf(quizRowOfToday() as LearnQuizDbRow)
  })
  ipcMain.handle('learn:quizAnswer', (_e, qIndex: number, answer: string) => {
    const row = quizRowOfToday()
    if (!row || row.status !== 'answering') throw new Error('NO_QUIZ')
    const questions = JSON.parse(row.questions) as LearnQuizQuestion[]
    const q = questions[qIndex]
    if (!q) throw new Error('BAD_INDEX')
    let correct: boolean | null = null
    if (q.type === 'choice') correct = q.answerIndex === Number(answer)
    else if (q.type === 'blank')
      correct = (q.acceptable ?? []).some((a) => normBlank(a) === normBlank(answer))
    const answers = JSON.parse(row.answers) as LearnQuizAnswer[]
    const next = answers.filter((a) => a.qIndex !== qIndex)
    next.push({ qIndex, answer, correct })
    getDb().prepare('UPDATE learn_quiz SET answers = ? WHERE date = ?').run(JSON.stringify(next), localDateStr())
    return correct
  })
  ipcMain.handle('learn:quizSubmit', async (_e, jobId: string) => {
    const row = quizRowOfToday()
    if (!row || row.status !== 'answering') throw new Error('NO_QUIZ')
    const questions = JSON.parse(row.questions) as LearnQuizQuestion[]
    const answers = JSON.parse(row.answers) as LearnQuizAnswer[]
    const missing = questions.length - answers.length
    if (missing > 0) throw new Error(`还有 ${missing} 题未作答`)
    const shorts = questions
      .map((q, i) => ({ q, i }))
      .filter(({ q, i }) => q.type === 'short' && answers.some((a) => a.qIndex === i))
    if (shorts.length > 0) {
      const ac = beginJob(jobId)
      try {
        const graded = await gradeLearnQuiz(
          shorts.map(({ q, i }) => ({
            qIndex: i,
            question: q.question,
            reference: q.answer,
            userAnswer: answers.find((a) => a.qIndex === i)?.answer ?? ''
          })),
          ac.signal
        )
        for (const g of graded) {
          const a = answers.find((x) => x.qIndex === g.qIndex)
          if (a) {
            a.correct = g.correct
            a.aiComment = g.comment
          }
        }
      } finally {
        endJob(jobId)
      }
    }
    const correct = answers.filter((a) => a.correct === true).length
    getDb()
      .prepare('UPDATE learn_quiz SET answers = ?, status = ?, graded_at = ? WHERE date = ?')
      .run(JSON.stringify(answers), 'graded', nowIso(), localDateStr())
    return { correct, total: questions.length }
  })
  ipcMain.handle('learn:quizRetry', () => {
    getDb()
      .prepare("UPDATE learn_quiz SET answers = '[]', status = 'answering', graded_at = NULL WHERE date = ?")
      .run(localDateStr())
    return quizViewOf(quizRowOfToday() as LearnQuizDbRow)
  })
  // ---------- 学习库 v2.0：实战任务（升级设计 §三；30 分钟小任务，不入回收站） ----------
  const learnTaskSql = 'SELECT t.*, n.title AS topic_title FROM learn_tasks t JOIN learn_nodes n ON t.topic_id = n.id'
  const taskRowOf = (id: number): LearnTaskRow =>
    getDb().prepare(`${learnTaskSql} WHERE t.id = ?`).get(id) as unknown as LearnTaskRow
  ipcMain.handle('learn:taskList', (_e, topicId: number) =>
    getDb()
      .prepare(`${learnTaskSql} WHERE t.topic_id = ? ORDER BY t.id DESC`)
      .all(topicId) as unknown as LearnTaskRow[]
  )
  ipcMain.handle('learn:taskGenerate', async (_e, jobId: string, topicId: number) => {
    const ac = beginJob(jobId)
    try {
      const { domainId, taskMd } = await generateLearnTask(topicId, ac.signal)
      const r = getDb()
        .prepare(
          "INSERT INTO learn_tasks (topic_id, domain_id, status, task_md, created_at) VALUES (?, ?, 'todo', '', ?)"
        )
        .run(topicId, domainId, nowIso())
      const id = Number(r.lastInsertRowid)
      const path = `md/learn/task/${id}-task.md`
      mdWrite(path, taskMd)
      getDb().prepare('UPDATE learn_tasks SET task_md = ? WHERE id = ?').run(path, id)
    } finally {
      endJob(jobId)
    }
    return taskRowOf(Number((getDb().prepare('SELECT MAX(id) AS m FROM learn_tasks').get() as { m: number }).m))
  })
  ipcMain.handle('learn:taskSubmit', async (_e, jobId: string, taskId: number, homework: string) => {
    const d = getDb()
    const t = d.prepare('SELECT * FROM learn_tasks WHERE id = ?').get(taskId) as
      | { topic_id: number; status: string; task_md: string; homework_md: string | null }
      | undefined
    if (!t) throw new Error('NOT_FOUND')
    if (t.status === 'reviewed') throw new Error('TASK_REVIEWED')
    if (!homework.trim()) throw new Error('作业内容为空')
    const ac = beginJob(jobId)
    try {
      const homeworkPath = t.homework_md ?? `md/learn/task/${taskId}-homework.md`
      mdWrite(homeworkPath, homework)
      const taskMd = mdRead(t.task_md)
      const { score, reviewMd } = await reviewLearnTask(t.topic_id, taskMd, homework, ac.signal)
      const reviewPath = `md/learn/task/${taskId}-review.md`
      mdWrite(reviewPath, reviewMd)
      d.prepare(
        "UPDATE learn_tasks SET status = 'reviewed', score = ?, homework_md = ?, review_md = ?, submitted_at = ? WHERE id = ?"
      ).run(score, homeworkPath, reviewPath, nowIso(), taskId)
    } finally {
      endJob(jobId)
    }
    return taskRowOf(taskId)
  })
  ipcMain.handle('learn:taskDelete', (_e, taskId: number) => {
    const d = getDb()
    const t = d.prepare('SELECT task_md, homework_md, review_md FROM learn_tasks WHERE id = ?').get(taskId) as
      | { task_md: string; homework_md: string | null; review_md: string | null }
      | undefined
    if (!t) throw new Error('NOT_FOUND')
    mdDelete(t.task_md)
    mdDelete(t.homework_md)
    mdDelete(t.review_md)
    d.prepare('DELETE FROM learn_tasks WHERE id = ?').run(taskId)
    return true
  })
  ipcMain.handle('learn:mark', (_e, id: number, action: 'learn' | 'remember' | 'forget') => {
    const d = getDb()
    const n = d
      .prepare('SELECT state, review_stage, next_review_at FROM learn_nodes WHERE id = ? AND deleted_at IS NULL')
      .get(id) as
      | { state: string; review_stage: number; next_review_at: string | null }
      | undefined
    if (!n) throw new Error('NOT_FOUND')
    const today = localDateStr()
    if (action === 'learn') {
      if (n.state !== 'todo') return false
      // 学会了：进第 1 档，次日复习（设计 §二状态机）
      d.prepare(
        "UPDATE learn_nodes SET state = 'learned', review_stage = 1, next_review_at = ? WHERE id = ?"
      ).run(addDaysLocal(1), id)
      return true
    }
    // remember/forget 仅到期卡可用（渲染层双钮也只在到期卡显示）
    if (
      n.state !== 'learned' ||
      n.review_stage < 1 ||
      n.review_stage > 4 ||
      n.next_review_at == null ||
      n.next_review_at > today
    ) {
      return false
    }
    if (action === 'forget') {
      // 忘记了：重置回第 1 档，明天再来
      d.prepare('UPDATE learn_nodes SET review_stage = 1, next_review_at = ? WHERE id = ?').run(
        addDaysLocal(1),
        id
      )
      return true
    }
    const nextStage = n.review_stage + 1
    if (nextStage >= 5) {
      // 走完 15 天档：毕业，不再进复习
      d.prepare('UPDATE learn_nodes SET review_stage = 5, next_review_at = NULL WHERE id = ?').run(id)
    } else {
      const gap = nextStage === 2 ? 3 : nextStage === 3 ? 7 : 15
      d.prepare('UPDATE learn_nodes SET review_stage = ?, next_review_at = ? WHERE id = ?').run(
        nextStage,
        addDaysLocal(gap),
        id
      )
    }
    return true
  })
  ipcMain.handle('learn:stockCheck', () => {
    void ensureLearnStock()
    return true
  })
  ipcMain.handle('learn:highlights', () =>
    getDb()
      .prepare(
        'SELECT h.*, n.title AS title FROM learn_highlights h JOIN learn_nodes n ON h.node_id = n.id WHERE n.deleted_at IS NULL ORDER BY h.id DESC'
      )
      .all()
  )
  ipcMain.handle('learn:addHighlight', (_e, nodeId: number, text: string) => {
    const d = getDb()
    const dup = d
      .prepare('SELECT id FROM learn_highlights WHERE node_id = ? AND text = ?')
      .get(nodeId, text)
    if (dup) return false
    d.prepare('INSERT INTO learn_highlights (node_id, text, created_at) VALUES (?, ?, ?)').run(
      nodeId,
      text,
      nowIso()
    )
    return true
  })
  ipcMain.handle('learn:deleteHighlight', (_e, id: number) => {
    getDb().prepare('DELETE FROM learn_highlights WHERE id = ?').run(id)
    return true
  })

  // ---------- 深挖（优化建议区 260912）：生成 → 确认 → 原子写入卡片 md ----------
  ipcMain.handle('learn:dig', async (_e, jobId: string, nodeId: number) => {
    const ac = beginJob(jobId)
    try {
      return { content: await digLearnCard(nodeId, ac.signal) }
    } finally {
      endJob(jobId)
    }
  })
  // 原子写入：读全文 → 末尾追加日期小节 → 写回，收敛主进程单点防渲染层读改写竞态
  ipcMain.handle('learn:digApply', (_e, nodeId: number, content: string) => {
    const path = `md/learn/${nodeId}.md`
    let md = ''
    try {
      md = mdRead(path)
    } catch {
      md = ''
    }
    const c = String(content ?? '').trim()
    if (!c) throw new Error('EMPTY_CONTENT')
    const next = `${md.replace(/\s*$/, '')}\n\n## 深挖（${yyMMdd()}）\n\n${c}\n`
    mdWrite(path, next)
    return { md: next }
  })

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

  // ---------- 画布（DB v25，新功能开发区 260909）：右缘第三面板的 Excalidraw 画布 ----------
  ipcMain.handle('canvas:list', () =>
    getDb()
      .prepare(
        'SELECT id, title, path, created_at, updated_at FROM canvases WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC'
      )
      .all()
  )
  /** 空白画布标准 .excalidraw JSON（主进程不依赖 Excalidraw 包；格式与官方 serializeAsJSON 一致） */
  const EMPTY_CANVAS_JSON = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'bugzi_workspace',
    elements: [],
    appState: { viewBackgroundColor: '#ffffff', gridSize: null }
  })
  ipcMain.handle('canvas:create', () => {
    const d = getDb()
    const now = nowIso()
    // 自动命名「未命名画布 N」：N 取存量行数+1（标题可改，重复无害）
    const n = (d.prepare('SELECT COUNT(*) AS c FROM canvases').get() as { c: number }).c
    const r = d
      .prepare('INSERT INTO canvases (title, path, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(`未命名画布 ${n + 1}`, 'PENDING', now, now)
    const id = Number(r.lastInsertRowid)
    const p = `canvas/${id}.excalidraw`
    d.prepare('UPDATE canvases SET path = ? WHERE id = ?').run(p, id)
    mdCreate(p, EMPTY_CANVAS_JSON)
    return id
  })
  ipcMain.handle('canvas:rename', (_e, id: number, title: string) => {
    // 改名不触碰 updated_at（口径同草稿/会话，列表顺序稳定）
    getDb()
      .prepare('UPDATE canvases SET title = ? WHERE id = ?')
      .run(title.trim().slice(0, 50) || '未命名画布', id)
    return true
  })
  ipcMain.handle('canvas:save', (_e, id: number, json: string) => {
    const d = getDb()
    const row = d.prepare('SELECT path FROM canvases WHERE id = ?').get(id) as
      | { path: string }
      | undefined
    if (!row) throw new Error('NOT_FOUND')
    mdWrite(row.path, json)
    d.prepare('UPDATE canvases SET updated_at = ? WHERE id = ?').run(nowIso(), id)
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

  // ---------- 书架（DB v19，书架 specs）：本地电子书阅读，零 AI（无 jobId 取消通道） ----------
  ipcMain.handle('books:list', () => listBooks())
  /** 系统对话框多选 epub/pdf（取消返回 []） */
  ipcMain.handle('books:browse', async () => {
    const r = await dialog.showOpenDialog(win()!, {
      title: '导入书籍',
      filters: [{ name: '电子书', extensions: ['epub', 'pdf'] }],
      properties: ['openFile', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('books:import', (_e, paths: string[], force?: boolean) => importBooks(paths, force))
  ipcMain.handle('books:readFile', (_e, id: number) => readBookFile(id))
  ipcMain.handle(
    'books:saveProgress',
    (_e, id: number, p: { cfi?: string | null; page?: number | null; percent: number }) => {
      saveProgress(id, p)
      return true
    }
  )
  ipcMain.handle('books:delete', (_e, id: number) => {
    deleteBook(id)
    return true
  })

  // ---------- 书架划词笔记（优化第1轮 §8.5，DB v24）：高光/批注，仅 epub ----------
  ipcMain.handle('books:notesList', (_e, bookId: number) => listNotes(bookId))
  ipcMain.handle(
    'books:noteAdd',
    (_e, bookId: number, n: { cfiRange: string; quote: string; note?: string }) => addNote(bookId, n)
  )
  ipcMain.handle('books:noteUpdate', (_e, noteId: number, note: string) => {
    updateNote(noteId, note)
    return true
  })
  ipcMain.handle('books:noteRemove', (_e, noteId: number) => {
    removeNote(noteId)
    return true
  })

  // ---------- 书架 v2.0（DB v29，2026-09-10-书架v2-design.md）：书签 / 每书偏好 / 阅读统计 / 笔记总览 ----------
  ipcMain.handle('books:marksList', (_e, bookId: number) => listMarks(bookId))
  ipcMain.handle(
    'books:markAdd',
    (_e, bookId: number, m: { cfi?: string | null; page?: number | null; label: string }) =>
      addMark(bookId, m)
  )
  ipcMain.handle('books:markRemove', (_e, markId: number) => {
    removeMark(markId)
    return true
  })
  ipcMain.handle(
    'books:markUpdate',
    (_e, markId: number, m: { label?: string; note?: string }) => updateMark(markId, m)
  )
  ipcMain.handle(
    'books:setReadingPref',
    (
      _e,
      bookId: number,
      p: { mode?: 'scroll' | 'page'; fontScale?: number | null; fontFamily?: string | null }
    ) => {
      setReadingPref(bookId, p)
      return true
    }
  )
  ipcMain.handle('books:addReadTime', (_e, bookId: number, seconds: number) => {
    addReadTime(bookId, seconds)
    return true
  })
  ipcMain.handle('books:readStats', () => readStats())
  ipcMain.handle('books:notesOverviewMd', (_e, bookId: number) => notesOverview(bookId).md)
  ipcMain.handle('books:exportNotes', async (_e, bookId: number) => {
    const { title, md } = notesOverview(bookId)
    const safe = title.replace(/[\\/:*?"<>|]/g, '_')
    const r = await dialog.showSaveDialog(win()!, {
      title: '导出读书笔记',
      defaultPath: `《${safe}》读书笔记.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (r.canceled || !r.filePath) return null
    exportNotesFile(bookId, r.filePath)
    return r.filePath
  })

  // ---------- 信息源（DB v20，信息源 specs §2/§3/§4）：RSS 聚合 + AI 总结按需缓存 ----------
  /** 源列表 + 未读数（首次幂等 seed 三源，probe 真名） */
  ipcMain.handle('feeds:list', async () => listFeeds())
  ipcMain.handle('feeds:fetchAll', async () => fetchAllFeeds())
  /** 验证订阅并取源名（添加弹窗「验证」；失败抛带 message Error） */
  ipcMain.handle('feeds:probe', (_e, url: string) => probeFeed(url))
  /** 入库并立即拉一次 */
  ipcMain.handle('feeds:add', (_e, url: string) => addFeed(url))
  ipcMain.handle('feeds:rename', (_e, id: number, title: string) => {
    renameFeed(id, title)
    return true
  })
  /** 删源连文章（前端二次确认后调用；显式两步，不依赖外键级联） */
  ipcMain.handle('feeds:remove', (_e, id: number) => {
    removeFeed(id)
    return true
  })
  /** 文章列表（feedId=null 全部；轻量行 + 剥标签预览） */
  ipcMain.handle(
    'articles:list',
    (_e, feedId: number | null, view: FeedView, sinceDays: number) => listArticles(feedId, view, sinceDays)
  )
  /** 打开文章：懒抓正文 + 全量返回（260911 起不再自动标已读——已读判定唯一入口是 setRead） */
  ipcMain.handle('articles:open', (_e, id: number) => openArticle(id))
  /** 显式已读/再看看（read=false 清空 read_at，行回收件箱） */
  ipcMain.handle('articles:setRead', (_e, id: number, read: boolean) => {
    setArticleRead(id, read)
    return true
  })
  /** 收藏/取消收藏（取消后按已读状态回流收件箱/已归档） */
  ipcMain.handle('articles:setFavorite', (_e, id: number, fav: boolean) => {
    setArticleFavorite(id, fav)
    return true
  })
  /** 全部标已读（feedId=null 全部源） */
  ipcMain.handle('articles:markAllRead', (_e, feedId: number | null) => {
    markAllRead(feedId)
    return true
  })
  /** AI 总结（按需 + 缓存）：jobId 首参 + beginJob/endJob 全局取消接线（260908 机制） */
  ipcMain.handle('articles:summarize', async (_e, jobId: string, id: number) => {
    const ac = beginJob(jobId)
    try {
      return await summarizeArticle(id, ac.signal)
    } finally {
      endJob(jobId)
    }
  })

  // ---------- 收藏夹（DB v28，收藏夹 specs §2-§4）：纯链接收藏，纯本地零 AI ----------
  /** 全量列表（幂等 seed「未分类」）：categories 按序 + items 置顶优先/时间倒序 */
  ipcMain.handle('favorites:list', async () => listFavorites())
  /** 新增收藏（服务层校验 URL/名称/分类，失败抛带 message Error） */
  ipcMain.handle(
    'favorites:addItem',
    (_e, name: string, url: string, descMd: string, categoryId: number) => addFavoriteItem(name, url, descMd, categoryId)
  )
  /** 局部更新（每次回写 updated_at） */
  ipcMain.handle('favorites:updateItem', (_e, id: number, patch: FavoriteItemPatch) => updateFavoriteItem(id, patch))
  /** 删收藏（前端二次确认后调用，直接删不入回收站） */
  ipcMain.handle('favorites:deleteItem', (_e, id: number) => {
    deleteFavoriteItem(id)
    return true
  })
  /** 新建分类（parentId=null 大类；子类下再建抛错——两级硬限制） */
  ipcMain.handle('favorites:addCategory', (_e, name: string, parentId: number | null) => addCategory(name, parentId))
  /** 改名（「未分类」抛错） */
  ipcMain.handle('favorites:renameCategory', (_e, id: number, name: string) => {
    renameCategory(id, name)
    return true
  })
  /** 同级上下移（交换 sort；到头幂等成功） */
  ipcMain.handle('favorites:moveCategory', (_e, id: number, dir: 'up' | 'down') => {
    moveCategory(id, dir)
    return true
  })
  /** 删分类（单事务：子类上移一级 + 直属条目入未分类；返回去向计数供文案） */
  ipcMain.handle('favorites:deleteCategory', (_e, id: number) => deleteCategory(id))
  /** 抓取页面 meta（任何失败返回空对象不抛错，渲染层手填兜底） */
  ipcMain.handle('favorites:fetchMeta', (_e, url: string) => fetchFavoriteMeta(url))

  // ---------- 账本（DB v21，账本 specs §2-§4）：纯本地零 AI ----------
  /** 账户列表（含实时余额） */
  ipcMain.handle('ledger:accounts:list', () => listAccounts())
  /** 新建/更新账户（名称 + 期初余额；重名抛错） */
  ipcMain.handle(
    'ledger:accounts:save',
    (_e, id: number | null, name: string, initialBalanceCents: number) => {
      saveAccount(id, name, initialBalanceCents)
      return true
    }
  )
  /** 删账户：入回收站 + 级联软删名下流水（cascaded 供确认文案/toast） */
  ipcMain.handle('ledger:accounts:remove', (_e, id: number) => {
    const r = removeAccount(id)
    win()?.webContents.send('recycle:changed')
    return r
  })
  /** 分类列表（未删全量，前端分支出/收入两组） */
  ipcMain.handle('ledger:categories:list', () => listCategories())
  /** 新建/更新分类（同 kind 查重） */
  ipcMain.handle(
    'ledger:categories:save',
    (_e, id: number | null, name: string, kind: 'expense' | 'income') => {
      saveCategory(id, name, kind)
      return true
    }
  )
  /** 删分类：在用流水断链为未分类（detached 供确认文案）+ 入回收站 */
  ipcMain.handle('ledger:categories:remove', (_e, id: number) => {
    const r = removeCategory(id)
    win()?.webContents.send('recycle:changed')
    return r
  })
  /** 流水列表（month='YYYY-MM'；categoryId 筛选占比条下钻） */
  ipcMain.handle('ledger:tx:list', (_e, month: string, categoryId: number | null) =>
    listTx(month, categoryId)
  )
  /** 新建/更新流水（校验失败抛带 message Error） */
  ipcMain.handle('ledger:tx:save', (_e, id: number | null, tx: LedgerTxInput) => {
    saveTx(id, tx)
    return true
  })
  /** 删流水：入站快照冗余分类/账户显示名（specs §5） */
  ipcMain.handle('ledger:tx:remove', (_e, id: number) => {
    removeTx(id)
    win()?.webContents.send('recycle:changed')
    return true
  })
  /** 月度统计：收支合计 + 支出分类排行 */
  ipcMain.handle('ledger:stats', (_e, month: string) => stats(month))

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

  // ---------- 万象库·知识问答（2026-09-12-知识问答标签页-design.md §四：安静模式，onProgress 仅 console） ----------
  ipcMain.handle('qa:list', () =>
    getDb().prepare('SELECT * FROM qa_records WHERE deleted_at IS NULL ORDER BY id DESC').all()
  )
  ipcMain.handle('qa:get', (_e, id: number) =>
    getDb().prepare('SELECT * FROM qa_records WHERE id = ?').get(id)
  )
  ipcMain.handle('qa:run', async (_e, jobId: string, question: string) => {
    const ac = beginJob(jobId)
    try {
      return await runQaAnswer(question, ac.signal)
    } finally {
      endJob(jobId)
    }
  })

  // ---------- 致知己（DB v9，致知己 specs §2：问题 + 多版本答案，AI 只追问不代笔） ----------
  ipcMain.handle('zhijiji:list', () => {
    const rows = getDb()
      .prepare(
        `SELECT q.id, q.title, q.tags, q.origin, q.stars, q.star_note, q.created_at, q.updated_at,
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
            scene: 'zhijiji:v0',
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

  // ---------- 致知己问题分级（优化建议区 260912）：来源 + 星级 + AI 出题 ----------
  ipcMain.handle('zhijiji:suggestQuestions', async (_e, jobId: string) => {
    const ac = beginJob(jobId)
    try {
      return await suggestZhijiQuestions(ac.signal)
    } finally {
      endJob(jobId)
    }
  })
  // 候选采纳批量入库：origin='ai' + 生成时评星落库；每条开空白 v1（同手动创建的空白路径）
  ipcMain.handle('zhijiji:adoptQuestions', (_e, candidates: ZhijijiQuestionCandidate[]) => {
    const d = getDb()
    const now = nowIso()
    const adopted: number[] = []
    for (const c of candidates) {
      const t = String(c?.title ?? '').trim()
      if (!t) continue
      const stars = Math.min(5, Math.max(1, Math.round(Number(c.stars) || 3)))
      const r = d
        .prepare(
          "INSERT INTO zhijiji_questions (title, tags, origin, stars, star_note, created_at, updated_at) VALUES (?, '[]', 'ai', ?, ?, ?, ?)"
        )
        .run(t, stars, String(c.note ?? '').trim() || null, now, now)
      const qid = Number(r.lastInsertRowid)
      const mdPath = `md/zhijiji/${qid}-v1.md`
      mdCreate(mdPath, '')
      d.prepare(
        'INSERT INTO zhijiji_versions (question_id, seq, date, md_path, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?)'
      ).run(qid, yyMMdd(), mdPath, now, now)
      adopted.push(qid)
    }
    return adopted
  })
  // 单题 AI 评星（手动新问题创建后异步调用）：仅写 stars IS NULL 行，不覆盖用户已改的星
  ipcMain.handle('zhijiji:rateQuestion', async (_e, jobId: string, questionId: number) => {
    const row = getDb()
      .prepare('SELECT id, title FROM zhijiji_questions WHERE id = ? AND deleted_at IS NULL')
      .get(questionId) as { id: number; title: string } | undefined
    if (!row) throw new Error('NOT_FOUND')
    const ac = beginJob(jobId)
    try {
      const [r] = await rateZhijiQuestions([row], ac.signal)
      if (!r) throw new Error('LLM 未返回评星')
      const res = getDb()
        .prepare('UPDATE zhijiji_questions SET stars = ?, star_note = ? WHERE id = ? AND stars IS NULL')
        .run(r.stars, r.note, questionId)
      if (res.changes === 0) return null // 用户已手动改星，评星结果弃用
      return { stars: r.stars, note: r.note }
    } finally {
      endJob(jobId)
    }
  })
  // 存量补评：全部未评星题一次调用批量评完
  ipcMain.handle('zhijiji:ratePending', async (_e, jobId: string) => {
    const rows = getDb()
      .prepare('SELECT id, title FROM zhijiji_questions WHERE stars IS NULL AND deleted_at IS NULL')
      .all() as { id: number; title: string }[]
    if (rows.length === 0) return 0
    const ac = beginJob(jobId)
    try {
      const ratings = await rateZhijiQuestions(rows, ac.signal)
      let n = 0
      for (const r of ratings) {
        const res = getDb()
          .prepare('UPDATE zhijiji_questions SET stars = ?, star_note = ? WHERE id = ? AND stars IS NULL')
          .run(r.stars, r.note, r.id)
        n += Number(res.changes)
      }
      return n
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('zhijiji:setStars', (_e, id: number, stars: number | null) => {
    const v = stars == null ? null : Math.min(5, Math.max(1, Math.round(Number(stars))))
    getDb()
      .prepare('UPDATE zhijiji_questions SET stars = ? WHERE id = ?')
      .run(v, id)
    return true
  })

  // ---------- 致知己·预言家（DB v36，2026-09-12 设计 §三） ----------
  ipcMain.handle('prophet:list', () =>
    getDb().prepare('SELECT * FROM prophet_records WHERE deleted_at IS NULL ORDER BY updated_at DESC').all()
  )
  ipcMain.handle('prophet:create', (_e, claim: string, note: string) => {
    const c = claim.trim()
    if (!c) throw new Error('CLAIM_REQUIRED')
    const now = nowIso()
    const r = getDb()
      .prepare(
        "INSERT INTO prophet_records (claim, note, status, judgment_note, created_at, updated_at) VALUES (?, ?, 'open', '', ?, ?)"
      )
      .run(c, note.trim(), now, now)
    return { id: Number(r.lastInsertRowid) }
  })
  ipcMain.handle('prophet:analyze', async (_e, jobId: string, id: number) => {
    const row = getDb().prepare('SELECT claim, note FROM prophet_records WHERE id = ?').get(id) as
      | { claim: string; note: string }
      | undefined
    if (!row) throw new Error('NOT_FOUND')
    const ac = beginJob(jobId)
    try {
      return await runProphetAnalysis(id, row.claim, row.note, (msg) => pushAiSystemMessage(msg, 'prophet'), ac.signal)
    } finally {
      endJob(jobId)
    }
  })
  ipcMain.handle('prophet:judge', (_e, id: number, judgment: string, judgmentNote: string) => {
    if (judgment !== 'reasonable' && judgment !== 'unreasonable' && judgment !== 'uncertain') {
      throw new Error('BAD_JUDGMENT')
    }
    const now = nowIso()
    getDb()
      .prepare(
        "UPDATE prophet_records SET status = 'judged', judgment = ?, judgment_note = ?, judged_at = ?, updated_at = ? WHERE id = ?"
      )
      .run(judgment, judgmentNote.trim(), now, now, id)
    return true
  })
  ipcMain.handle('prophet:discard', (_e, id: number) => {
    discardToRecycle('prophet', id)
    win()?.webContents.send('recycle:changed')
    return true
  })

  // ---------- 致知己·十二问题（DB v36，2026-09-12 设计 §四） ----------
  ipcMain.handle('twelve:list', () =>
    getDb()
      .prepare(
        `SELECT q.id, q.title, q.ord, q.created_at, q.updated_at,
          (SELECT COUNT(*) FROM twelve_thoughts t WHERE t.question_id = q.id) AS thought_count,
          (SELECT MAX(t.created_at) FROM twelve_thoughts t WHERE t.question_id = q.id) AS last_thought_at
        FROM twelve_questions q WHERE q.deleted_at IS NULL ORDER BY q.ord ASC`
      )
      .all()
  )
  ipcMain.handle('twelve:createQuestion', (_e, title: string) => {
    const t = title.trim()
    if (!t) throw new Error('TITLE_REQUIRED')
    const d = getDb()
    const n = d.prepare('SELECT COUNT(*) AS c FROM twelve_questions WHERE deleted_at IS NULL').get() as {
      c: number
    }
    if (n.c >= 12) throw new Error('TWELVE_FULL')
    const now = nowIso()
    const m = d.prepare('SELECT COALESCE(MAX(ord), 0) AS m FROM twelve_questions').get() as { m: number }
    const r = d
      .prepare('INSERT INTO twelve_questions (title, ord, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(t, m.m + 1, now, now)
    return { id: Number(r.lastInsertRowid) }
  })
  ipcMain.handle('twelve:renameQuestion', (_e, id: number, title: string) => {
    const t = title.trim()
    if (!t) return false
    getDb().prepare('UPDATE twelve_questions SET title = ?, updated_at = ? WHERE id = ?').run(t, nowIso(), id)
    return true
  })
  ipcMain.handle('twelve:thoughts', (_e, questionId: number) =>
    getDb()
      .prepare('SELECT * FROM twelve_thoughts WHERE question_id = ? ORDER BY created_at DESC, id DESC')
      .all(questionId)
  )
  ipcMain.handle('twelve:addThought', (_e, questionId: number, content: string) => {
    const c = content.trim()
    if (!c) throw new Error('CONTENT_REQUIRED')
    const d = getDb()
    const now = nowIso()
    const r = d
      .prepare('INSERT INTO twelve_thoughts (question_id, content, created_at) VALUES (?, ?, ?)')
      .run(questionId, c, now)
    d.prepare('UPDATE twelve_questions SET updated_at = ? WHERE id = ?').run(now, questionId)
    return { id: Number(r.lastInsertRowid), question_id: questionId, content: c, created_at: now }
  })
  ipcMain.handle('twelve:deleteThought', (_e, id: number) => {
    getDb().prepare('DELETE FROM twelve_thoughts WHERE id = ?').run(id)
    return true
  })
  ipcMain.handle('twelve:discardQuestion', (_e, id: number) => {
    discardToRecycle('twelve_question', id)
    win()?.webContents.send('recycle:changed')
    return true
  })

  // ---------- 推理角（DB v12，推理角 specs §2/§4） ----------
  ipcMain.handle('turtle:generate', async (_e, jobId: string, preference: string) => {
    // v1.3 配套（260910）：存货充足（fresh ≥ 3 碗，按钮批数）秒回不调 LLM——汤库列表里的
    // fresh 汤即后台泵已出好的题，点汤开局本就零等待；存量不足才现场生成（难度偏好仅对
    // 现场生成生效，存货为泵随机难度——偏好严格的用户等存量耗尽自然回落现场生成）。
    const fresh = freshSoupCount()
    if (fresh >= 3) return { generated: 0, inserted: 0, stockServed: fresh }
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
      // 开新局 = fresh 存量减一（v1.3 题库预生成）：后台补货（续局/终局回看不减 fresh 不触发）
      void ensureReasoningStock()
    }
    // 恢复对局：清残留计时段——同 run 内恢复前必有 pause 已结算（清空幂等无害）；
    // 跨 run 即崩溃自愈（异常退出残留的开段直接丢弃，不把离线时间计入）
    d.prepare('UPDATE turtle_games SET segment_start_at = NULL WHERE id = ?').run(game.id)
    return turtleGamePayload(game.id)
  })
  ipcMain.handle('turtle:game', (_e, gameId: number) => turtleGamePayload(gameId))

  // ---------- 海龟汤净用时记账（优化建议区第26轮）：渲染层边界事件，主进程记账 ----------
  // start/pause 均对非 playing 局静默 no-op（终局竞态下渲染层迟到的 pause 不抛错）
  ipcMain.handle('turtle:timerStart', (_e, gameId: number) => {
    getDb()
      .prepare(
        "UPDATE turtle_games SET segment_start_at = ? WHERE id = ? AND status = 'playing' AND segment_start_at IS NULL AND deleted_at IS NULL"
      )
      .run(nowIso(), gameId)
    return true
  })
  ipcMain.handle('turtle:timerPause', (_e, gameId: number) => {
    const d = getDb()
    const game = d
      .prepare("SELECT * FROM turtle_games WHERE id = ? AND status = 'playing' AND deleted_at IS NULL")
      .get(gameId) as TurtleGameRow | undefined
    if (game) settleGameSegment(d, game)
    return true
  })
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
      const fin = await finishTurtleGame(gameId, 'solved')
      return {
        solved: true,
        bottom: fin.bottom,
        hits: verdict.hits,
        misses: verdict.misses,
        feedback: verdict.feedback,
        durationMs: fin.durationMs
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
      return await finishTurtleGame(gameId, 'abandoned')
    } finally {
      endJob(jobId)
    }
  })
  // 复盘报告懒生成（优化建议区第26轮）：终局秒回不生成；点「查看复盘」时 ensure——
  // 已有 md 直接返回（旧记录零变化），无则生成点评→拼 md→写盘→回填路径；失败可重试
  ipcMain.handle('turtle:report', async (_e, jobId: string, gameId: number) => {
    const ac = beginJob(jobId)
    try {
      const d = getDb()
      const game = d
        .prepare('SELECT * FROM turtle_games WHERE id = ? AND deleted_at IS NULL')
        .get(gameId) as TurtleGameRow | undefined
      if (!game) throw new Error('NOT_FOUND')
      if (game.status === 'playing') throw new Error('PLAYING')
      if (game.md_path) return game.md_path
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
      const transcript = msgs.map(fmtTurtleMsg).join('\n\n')
      const review = await soupReview(
        { surface: soup.surface, bottom: soup.bottom, analysis: soup.analysis },
        transcript,
        game.status === 'solved' ? 'solved' : 'abandoned',
        game.question_count,
        ac.signal
      )
      const lastGuess = [...msgs].reverse().find((m) => m.type === 'guess')
      const mdPath = `md/turtle/${gameId}.md`
      mdWrite(
        mdPath,
        `# ${soup.title}（${DIFFICULTY_ZH[soup.difficulty] ?? soup.difficulty} · ${soup.theme_tag}）\n\n> ${
          game.status === 'solved' ? '已破汤' : '弃汤'
        } · 提问 ${game.question_count} 次 · 用时 ${fmtDuration(game.duration_ms ?? 0)}\n\n## 汤面\n\n${
          soup.surface
        }\n\n## 汤底\n\n${soup.bottom}\n\n## 问答全程\n\n${transcript}\n${
          lastGuess ? `\n## 最终推理\n\n${lastGuess.content}\n` : ''
        }\n## AI 点评\n\n${review}\n`
      )
      d.prepare('UPDATE turtle_games SET md_path = ?, updated_at = ? WHERE id = ?').run(
        mdPath,
        nowIso(),
        gameId
      )
      return mdPath
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
  // 题库补充泵触发（v1.3）：进入推理角模块时调（覆盖「LLM 事后才配置好」场景）。
  // fire-and-forget 秒回；存量达标即 no-op，泵内部静默失败。
  ipcMain.handle('reasoning:stockCheck', () => {
    void ensureReasoningStock()
    return true
  })

  // ---------- 思维墙（v1.3 题库预生成：从 wall_pool 转正秒开，池空才现场出题；specs §2/§4） ----------
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
        // 题型轮换：近 2 日已出题型不再出（三题型以上池保证至少剩一种可选；池选题与兜底生成共用）
        const recentTypes = (
          d
            .prepare('SELECT puzzle_type FROM wall_puzzles ORDER BY date DESC LIMIT 2')
            .all() as { puzzle_type: string }[]
        ).map((r) => r.puzzle_type)
        // v1.3：优先从池中选，四级放宽——①难度匹配且题型避近 2 日 ②仅按难度 ③池内任意
        // ④池空（undefined）→ 兜底现场生成；命中即同事务转正，零 LLM 调用，秒开
        const pooled =
          pickPoolPuzzle(d, { difficulty, avoidTypes: recentTypes }) ??
          pickPoolPuzzle(d, { difficulty }) ??
          pickPoolPuzzle(d, {})
        if (pooled) {
          const now = nowIso()
          d.exec('BEGIN')
          try {
            d.prepare(
              'INSERT INTO wall_puzzles (date, puzzle_text, answer_standard, standard_reasoning, hints, puzzle_type, difficulty, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(
              today,
              pooled.puzzle_text,
              pooled.answer_standard,
              pooled.standard_reasoning,
              pooled.hints,
              pooled.puzzle_type,
              pooled.difficulty,
              'answering',
              now,
              now
            )
            d.prepare('DELETE FROM wall_pool WHERE id = ?').run(pooled.id)
            d.exec('COMMIT')
          } catch (e) {
            d.exec('ROLLBACK')
            throw e
          }
          row = d.prepare('SELECT * FROM wall_puzzles WHERE date = ?').get(today)
          void ensureReasoningStock()
        } else {
          // 池空兜底：现场两阶段生成（现有管线原样，「题库见底，现场出题中…」loading 仅此场景出现）
          const candidates = WALL_TYPE_LIST.filter((t) => !recentTypes.includes(t))
          const type = candidates[Math.floor(Math.random() * candidates.length)] ?? WALL_TYPE_LIST[0]
          // 避免重复：近 20 题题面摘要入避免清单（防同构重出）
          const avoid = (
            d
              .prepare('SELECT puzzle_text FROM wall_puzzles ORDER BY date DESC LIMIT 20')
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
          void ensureReasoningStock()
        }
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
        WALL_TYPE_ZH[row.puzzle_type] ?? row.puzzle_type,
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
  // 会话级作答态暂存主进程内存（practiceBank）；题目本体生成即入题库 wall_bank（todo 态，
  // 260909 优化：练习题不再用完即弃）——练习场判答回写终态与详情 md，弃做的题留在题库可回补。
  // v1.3 题库预生成：优先从 wall_pool 按难度/题型筛选取题（随机=不限），秒回；无匹配兜底现场生成。
  ipcMain.handle('wall:practiceNew', async (_e, jobId: string, pref: string, typePref?: string) => {
    const ac = beginJob(jobId)
    try {
      const difficulty =
        pref === 'easy' || pref === 'medium' || pref === 'hard'
          ? pref
          : (['easy', 'medium', 'hard'] as const)[Math.floor(Math.random() * 3)] // 随机
      // 题型自选（v1.2）：随机 | 四思维游戏题型之一（防重复注入见 wall_puzzles 近题避免清单——练习不落 wall_puzzles，无历史可避）
      const type: WallPuzzleType | undefined = WALL_TYPE_LIST.find((t) => t === typePref)
      // v1.3：池优先（pref 随机 = 不限难度）；取走即消耗——同事务 DELETE 池行 + 入题库 todo 态
      const pooled = pickPoolPuzzle(getDb(), {
        difficulty: pref === 'random' ? undefined : difficulty,
        type
      })
      if (pooled) {
        const d = getDb()
        const typeZh = WALL_TYPE_ZH[pooled.puzzle_type] ?? pooled.puzzle_type
        const diffZh = DIFFICULTY_ZH[pooled.difficulty] ?? pooled.difficulty
        const hints = parseWallHints(pooled.hints)
        const now = nowIso()
        d.exec('BEGIN')
        let bankId: number
        try {
          d.prepare('DELETE FROM wall_pool WHERE id = ?').run(pooled.id)
          const r = d
            .prepare(
              'INSERT INTO wall_bank (title, tag, difficulty, puzzle_text, answer_standard, solution, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .run(
              bankTitle(pooled.title, pooled.puzzle_text),
              typeZh,
              pooled.difficulty,
              pooled.puzzle_text,
              pooled.answer_standard,
              pooled.standard_reasoning,
              `AI 练习场生成（${now.slice(0, 10)}）`,
              'todo',
              now,
              now
            )
          d.exec('COMMIT')
          bankId = Number(r.lastInsertRowid)
        } catch (e) {
          d.exec('ROLLBACK')
          throw e
        }
        const id = ++practiceSeq
        practiceBank.set(id, {
          bankId,
          puzzle: pooled.puzzle_text,
          answer: pooled.answer_standard,
          reasoning: pooled.standard_reasoning,
          hints,
          hintsUsed: 0,
          typeZh,
          diffZh
        })
        // 长会话防累积：只留最近 10 条。Map 按插入序遍历，删最旧不伤当前题（当前题必是最新插入）
        for (const old of practiceBank.keys()) {
          if (practiceBank.size <= 10) break
          practiceBank.delete(old)
        }
        void ensureReasoningStock()
        return { id, puzzle: pooled.puzzle_text, typeZh, diffZh, hintsTotal: hints.length }
      }
      // 兜底：池中无匹配（如指定题型但池里没有）→ 现场两阶段生成（现状链路）
      const draft = await generateWallPuzzle(difficulty, { type: type ?? undefined }, ac.signal)
      const typeZh = WALL_TYPE_ZH[draft.type] ?? draft.type
      // 生成即入题库（260909）：todo 态起步，与人工策展种子同表同规则（一题一命、不进回收站）
      const now = nowIso()
      const r = getDb()
        .prepare(
          'INSERT INTO wall_bank (title, tag, difficulty, puzzle_text, answer_standard, solution, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          bankTitle(draft.title, draft.puzzle),
          typeZh,
          draft.difficulty,
          draft.puzzle,
          draft.answer,
          draft.reasoning,
          `AI 练习场生成（${now.slice(0, 10)}）`,
          'todo',
          now,
          now
        )
      const bankId = Number(r.lastInsertRowid)
      const id = ++practiceSeq
      practiceBank.set(id, {
        bankId,
        puzzle: draft.puzzle,
        answer: draft.answer,
        reasoning: draft.reasoning,
        hints: draft.hints,
        hintsUsed: 0,
        typeZh,
        diffZh: DIFFICULTY_ZH[draft.difficulty] ?? draft.difficulty
      })
      // 长会话防累积：只留最近 10 条。Map 按插入序遍历，删最旧不伤当前题（当前题必是最新插入）
      for (const old of practiceBank.keys()) {
        if (practiceBank.size <= 10) break
        practiceBank.delete(old)
      }
      void ensureReasoningStock()
      return {
        id,
        puzzle: draft.puzzle,
        typeZh,
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
      const verdict = await judgeWallAnswer(
        entry.puzzle,
        entry.answer,
        entry.reasoning,
        a,
        entry.typeZh,
        ac.signal
      )
      practiceBank.delete(practiceId) // 一题一命：判答即终局，对错都揭示答案与讲解
      // 回写题库终态 + 详情 md（生成即入库的行；若该题已在题库侧作答/看解答过则跳过）
      const bankRow = getDb()
        .prepare('SELECT * FROM wall_bank WHERE id = ?')
        .get(entry.bankId) as
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
          }
        | undefined
      if (bankRow && bankRow.status === 'todo') {
        const mdPath = writeBankMd(bankRow, a, verdict.correct, verdict.explanation)
        getDb()
          .prepare('UPDATE wall_bank SET status = ?, my_answer = ?, md_path = ?, updated_at = ? WHERE id = ?')
          .run(verdict.correct ? 'solved' : 'failed', a, mdPath, nowIso(), entry.bankId)
      }
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

  // ---------- 思维墙·题库（v1.2 精选题库，260909 改名并收入练习场生成题）----------
  // 人工策展存量难题 + 练习场 AI 生成题同表（source 区分）；AI 只判答不出题；
  // 作答/看解答均为终态（墙是真实历史，不可重做）。
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
      // wall_bank 无 puzzle_type，tag 即题型/内容标签（v1.6 新种子 tag=四题型中文名）
      const verdict = await judgeWallAnswer(
        row.puzzle_text,
        row.answer_standard,
        row.solution,
        a,
        row.tag,
        ac.signal
      )
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

  // ---------- AI 使用统计（260910 推理角效率优化） ----------
  ipcMain.handle('llmUsage:stats', (_e, range: 'today' | 'month' | 'all') => {
    const now = new Date()
    let since: string | null = null
    if (range === 'today') {
      since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    } else if (range === 'month') {
      since = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    }
    const sql = `SELECT scene,
        COUNT(*) AS calls,
        SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures,
        CAST(AVG(duration_ms) AS INTEGER) AS avg_ms,
        SUM(prompt_tokens + completion_tokens) AS tokens,
        SUM(tokens_estimated) AS est_rows
      FROM llm_usage${since ? ' WHERE created_at >= ?' : ''}
      GROUP BY scene ORDER BY tokens DESC`
    const rows = (
      since ? getDb().prepare(sql).all(since) : getDb().prepare(sql).all()
    ) as {
      scene: string
      calls: number
      failures: number
      avg_ms: number
      tokens: number
      est_rows: number
    }[]
    const mapped = rows.map((r) => ({
      scene: r.scene,
      calls: r.calls,
      failures: r.failures,
      avgMs: r.avg_ms,
      tokens: r.tokens,
      estRows: r.est_rows
    }))
    return {
      totals: {
        calls: mapped.reduce((n, r) => n + r.calls, 0),
        failures: mapped.reduce((n, r) => n + r.failures, 0),
        tokens: mapped.reduce((n, r) => n + r.tokens, 0)
      },
      rows: mapped
    }
  })

  // 调用记录（260910 AI 使用明细）：最近 30 条；库内全量保留，仅 UI 截断，与时间范围无关
  ipcMain.handle('llmUsage:records', () => {
    const rows = getDb()
      .prepare(
        `SELECT id, created_at, scene, config_name, model, ok, duration_ms, prompt_tokens, completion_tokens, tokens_estimated, error_brief
        FROM llm_usage ORDER BY id DESC LIMIT 30`
      )
      .all() as {
      id: number
      created_at: string
      scene: string
      config_name: string
      model: string
      ok: number
      duration_ms: number
      prompt_tokens: number
      completion_tokens: number
      tokens_estimated: number
      error_brief: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      scene: r.scene,
      configName: r.config_name,
      model: r.model,
      ok: r.ok === 1,
      durationMs: r.duration_ms,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      tokensEstimated: r.tokens_estimated === 1,
      errorBrief: r.error_brief
    }))
  })

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
  /** 累计净用时 ms（v18；终局结算进 duration_ms） */
  active_ms: number
  /** 当前计时段起点（NULL=暂停中；SELECT * 反序列化可空） */
  segment_start_at: string | null
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
  // v1.2 洞察题型池（仅历史行显示用，不再生成）
  insight_invariant: '不变量与构造',
  strategy_protocol: '策略协议设计',
  counter_probability: '反直觉概率',
  // v1.6 思维游戏题型池（现行）
  detective_case: '侦探断案',
  lateral_puzzle: '情境谜题',
  word_logic: '文字谜题',
  life_logic: '生活逻辑'
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

/** 结算局的未闭合计时段并返回最新累计净用时（timerPause / 终局 / 退出兜底共用） */
function settleGameSegment(d: ReturnType<typeof getDb>, game: TurtleGameRow): number {
  if (!game.segment_start_at) return game.active_ms
  const add = Math.max(0, Date.now() - new Date(game.segment_start_at).getTime())
  const total = game.active_ms + add
  d.prepare('UPDATE turtle_games SET active_ms = ?, segment_start_at = NULL WHERE id = ?').run(
    total,
    game.id
  )
  return total
}

/** 退出兜底：结算所有进行中局的开着计时段（崩溃场景无此钩子，残留段由 openSoup 恢复时丢弃自愈） */
export function settleTurtleTimers(): void {
  const d = getDb()
  const rows = d
    .prepare(
      "SELECT * FROM turtle_games WHERE status = 'playing' AND segment_start_at IS NOT NULL AND deleted_at IS NULL"
    )
    .all() as unknown as TurtleGameRow[]
  for (const g of rows) settleGameSegment(d, g)
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

/** 问答流消息 → 复盘 md 行（原 finishTurtleGame 内 fmtMsg 提出，report 拼装用） */
function fmtTurtleMsg(m: { type: string; content: string }): string {
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
    // 终局回看（问题疑惑区第8轮）：额外暴露汤底与复盘路径；进行中暴露计时种子。
    // 复盘 md 懒生成（优化建议区第26轮）后 md_path 可能为 null（点「查看复盘」时现场生成）
    ...(game.status === 'playing'
      ? { activeMs: game.active_ms }
      : { bottom: soup.bottom, mdPath: game.md_path, durationMs: game.duration_ms })
  }
}

/**
 * 终局链（优化建议区第26轮拆分）：结算计时 → 更新局行与汤状态，**秒回**。
 * 不再调 LLM、不写 md——复盘报告（含 AI 点评）由 turtle:report 按需懒生成。
 */
async function finishTurtleGame(
  gameId: number,
  result: 'solved' | 'abandoned'
): Promise<{ bottom: string; durationMs: number }> {
  const d = getDb()
  const game = d
    .prepare('SELECT * FROM turtle_games WHERE id = ? AND deleted_at IS NULL')
    .get(gameId) as TurtleGameRow | undefined
  if (!game) throw new Error('NOT_FOUND')
  const soup = d
    .prepare('SELECT bottom FROM turtle_soups WHERE id = ?')
    .get(game.soup_id) as { bottom: string } | undefined
  if (!soup) throw new Error('NOT_FOUND')
  // 结算未闭合计时段：duration_ms = 净用时（渲染层 pause 可能晚于终局到达，以此处为准）
  const duration = settleGameSegment(d, game)
  const now = nowIso()
  d.prepare(
    'UPDATE turtle_games SET status = ?, ended_at = ?, duration_ms = ?, updated_at = ? WHERE id = ?'
  ).run(result, now, duration, now, gameId)
  d.prepare('UPDATE turtle_soups SET status = ?, updated_at = ? WHERE id = ?').run(
    result,
    now,
    game.soup_id
  )
  return { bottom: soup.bottom, durationMs: duration }
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

// ---------- 思维墙·练习场（作答态会话级暂存；题目本体在 wall_bank，不计入墙/连胜/月历） ----------

interface PracticeEntry {
  /** 生成即入库的 wall_bank 行 id（判答回写终态与 md 用） */
  bankId: number
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

/** wall_pool 行（v1.3 预生成题池：未消费的储备，无 deleted_at、不进回收站） */
interface WallPoolRow {
  id: number
  title: string
  puzzle_text: string
  answer_standard: string
  standard_reasoning: string
  hints: string
  puzzle_type: string
  difficulty: string
  created_at: string
}

/**
 * 从 wall_pool 按条件随机选一道（v1.3）：难度/题型/题型避让均可省略，无匹配返回 undefined。
 * 只选不删——池行删除与转正（每日题）/入题库（练习场）由调用方同事务完成（防半途丢失）。
 */
function pickPoolPuzzle(
  d: ReturnType<typeof getDb>,
  cond: { difficulty?: string; type?: WallPuzzleType; avoidTypes?: string[] }
): WallPoolRow | undefined {
  const rows = d.prepare('SELECT * FROM wall_pool').all() as unknown as WallPoolRow[]
  const match = rows.filter(
    (r) =>
      (cond.difficulty === undefined || r.difficulty === cond.difficulty) &&
      (cond.type === undefined || r.puzzle_type === cond.type) &&
      !(cond.avoidTypes?.includes(r.puzzle_type) ?? false)
  )
  return match.length ? match[Math.floor(Math.random() * match.length)] : undefined
}

/** 练习题入题库标题：LLM 短标题（池行预生成或现场草稿）优先，未给时兜底取题面首行（去 md 记号截 16 字） */
function bankTitle(title: string | undefined, puzzle: string): string {
  const t = (title ?? '').trim()
  if (t) return t
  const firstLine = puzzle
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s !== '')
  return (firstLine ?? '练习题').replace(/[*_`>#]/g, '').slice(0, 16)
}

/** 题库详情 md（作答终局 / 看解答 / 练习场判答回写共用，局终一次写入 md/wall/bank/{id}.md） */
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
