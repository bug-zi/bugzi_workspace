// preload：contextBridge 暴露类型化 IPC API（window.api.*）
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  settings: {
    getAll: (): Promise<Record<string, string>> => ipcRenderer.invoke('settings:getAll'),
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string): Promise<boolean> => ipcRenderer.invoke('settings:set', key, value)
  },
  md: {
    read: (path: string): Promise<string> => ipcRenderer.invoke('md:read', path),
    write: (path: string, content: string): Promise<boolean> => ipcRenderer.invoke('md:write', path, content),
    create: (path: string, content: string): Promise<boolean> => ipcRenderer.invoke('md:create', path, content),
    delete: (path: string): Promise<boolean> => ipcRenderer.invoke('md:delete', path)
  },
  image: {
    /** 选择并落盘图片；kind: avatar | bg-light | bg-dark */
    pick: (kind: 'avatar' | 'bg-light' | 'bg-dark'): Promise<boolean | null> =>
      ipcRenderer.invoke('image:pick', kind)
  },
  item: {
    discard: (table: 'mottos' | 'wiki_entries' | 'inspirations' | 'verify_records', id: number): Promise<boolean> =>
      ipcRenderer.invoke('item:discard', table, id),
    onRecycleChanged: (cb: () => void): (() => void) => {
      const listener = (): void => {
        cb()
      }
      ipcRenderer.on('recycle:changed', listener)
      return () => ipcRenderer.removeListener('recycle:changed', listener)
    }
  },
  recycle: {
    list: (): Promise<
      { id: number; source: 'mottos' | 'wiki' | 'inspirations' | 'verify'; item_id: number; payload: string; created_at: string }[]
    > => ipcRenderer.invoke('recycle:list'),
    restore: (id: number): Promise<{ source: string; item_id: number }> =>
      ipcRenderer.invoke('recycle:restore', id),
    delete: (id: number): Promise<boolean> => ipcRenderer.invoke('recycle:delete', id)
  },
  ai: {
    messages: (
      sessionId: number
    ): Promise<
      {
        id: number
        session_id: number
        role: 'user' | 'assistant' | 'system'
        ai_module: string | null
        content: string
        created_at: string
      }[]
    > => ipcRenderer.invoke('ai:messages', sessionId),
    chat: (
      message: string,
      currentModule: string,
      sessionId: number
    ): Promise<{ id: number; role: string; content: string }> =>
      ipcRenderer.invoke('ai:chat', message, currentModule, sessionId),
    configured: (): Promise<boolean> => ipcRenderer.invoke('ai:configured'),
    pushSystem: (content: string): Promise<boolean> => ipcRenderer.invoke('ai:pushSystem', content),
    deleteMessage: (id: number): Promise<boolean> => ipcRenderer.invoke('ai:deleteMessage', id),
    onMessage: (cb: (msg: unknown) => void): (() => void) => {
      const listener = (_e: unknown, msg: unknown): void => {
        cb(msg)
      }
      ipcRenderer.on('ai:message', listener)
      return () => ipcRenderer.removeListener('ai:message', listener)
    }
  },
  aiSession: {
    /** 会话列表（最近活跃在前） */
    list: (): Promise<
      { id: number; title: string; created_at: string; updated_at: string }[]
    > => ipcRenderer.invoke('aiSession:list'),
    create: (): Promise<{ id: number; title: string; created_at: string; updated_at: string }> =>
      ipcRenderer.invoke('aiSession:create'),
    rename: (id: number, title: string): Promise<boolean> =>
      ipcRenderer.invoke('aiSession:rename', id, title),
    /** 删除会话（连同消息）；删的是激活会话时主进程自动切换/清除激活 */
    delete: (id: number): Promise<boolean> => ipcRenderer.invoke('aiSession:delete', id),
    active: (): Promise<number | null> => ipcRenderer.invoke('aiSession:active')
  },
  mottos: {
    list: (status?: string): Promise<unknown[]> => ipcRenderer.invoke('mottos:list', status),
    create: (content: string, source: string, status: string, tags?: string[]): Promise<number> =>
      ipcRenderer.invoke('mottos:create', content, source, status, tags),
    update: (id: number, content: string, source: string, tags?: string[]): Promise<boolean> =>
      ipcRenderer.invoke('mottos:update', id, content, source, tags),
    setStatus: (id: number, status: string): Promise<boolean> =>
      ipcRenderer.invoke('mottos:setStatus', id, status),
    /** 覆盖式设置标签（v2.0 §7.1，传空数组即清空） */
    setTags: (id: number, tags: string[]): Promise<boolean> =>
      ipcRenderer.invoke('mottos:setTags', id, tags),
    reorder: (moves: { id: number; sort: number }[]): Promise<boolean> =>
      ipcRenderer.invoke('mottos:reorder', moves),
    discard: (id: number): Promise<boolean> => ipcRenderer.invoke('item:discard', 'mottos', id),
    generate: (): Promise<{
      generated: number
      inserted: number
      excerptInserted: number
      composedInserted: number
    }> => ipcRenderer.invoke('mottos:generate'),
    normalize: (s: string): Promise<string> => ipcRenderer.invoke('mottos:normalize', s),
    /** 未删除区内判重（v2.0 §7.4：规范化一致或包含关系） */
    checkDuplicate: (content: string): Promise<boolean> =>
      ipcRenderer.invoke('mottos:checkDuplicate', content),
    /** 直接删除：越过回收站彻底删除（含笔记 md），需前端二次确认 */
    deleteForever: (id: number): Promise<boolean> => ipcRenderer.invoke('mottos:deleteForever', id)
  },
  wiki: {
    sections: (): Promise<unknown[]> => ipcRenderer.invoke('wiki:sections'),
    createSection: (name: string): Promise<number> => ipcRenderer.invoke('wiki:createSection', name),
    renameSection: (id: number, name: string): Promise<boolean> =>
      ipcRenderer.invoke('wiki:renameSection', id, name),
    deleteSection: (id: number): Promise<boolean> => ipcRenderer.invoke('wiki:deleteSection', id),
    entries: (sectionId: number): Promise<unknown[]> => ipcRenderer.invoke('wiki:entries', sectionId),
    entry: (id: number): Promise<unknown> => ipcRenderer.invoke('wiki:entry', id),
    updateEntry: (id: number, term: string, summary: string): Promise<boolean> =>
      ipcRenderer.invoke('wiki:updateEntry', id, term, summary),
    generate: (
      term: string | null,
      sectionId: number | null
    ): Promise<{ ok: true; data: { entryId: number; term: string; summary: string } } | { ok: false; conflict: string }> =>
      ipcRenderer.invoke('wiki:generate', term, sectionId),
    /** 随机词条名（指定板块用板块，未指定随机挑；只构思词条名不生成卡片） */
    suggestTerm: (sectionId: number | null): Promise<string> =>
      ipcRenderer.invoke('wiki:suggestTerm', sectionId),
    /** 测一测：随机 5 张卡片各出 1 道四选一 */
    quiz: (): Promise<
      { entryId: number; term: string; question: string; options: string[]; answer: number }[]
    > => ipcRenderer.invoke('wiki:quiz'),
    /** 直接删除词条（生成审核流）：彻底删除卡片 md + 高光 + 词条，需前端二次确认 */
    deleteForeverEntry: (id: number): Promise<boolean> =>
      ipcRenderer.invoke('wiki:deleteForeverEntry', id),
    highlights: (): Promise<unknown[]> => ipcRenderer.invoke('wiki:highlights'),
    addHighlight: (entryId: number, text: string): Promise<boolean> =>
      ipcRenderer.invoke('wiki:addHighlight', entryId, text),
    deleteHighlight: (id: number): Promise<boolean> => ipcRenderer.invoke('wiki:deleteHighlight', id),
    discardEntry: (id: number): Promise<boolean> => ipcRenderer.invoke('item:discard', 'wiki_entries', id)
  },
  inspirations: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('inspirations:list'),
    create: (title: string, status: string): Promise<number> =>
      ipcRenderer.invoke('inspirations:create', title, status),
    updateTitle: (id: number, title: string): Promise<boolean> =>
      ipcRenderer.invoke('inspirations:updateTitle', id, title),
    move: (id: number, status: string, sort: number): Promise<boolean> =>
      ipcRenderer.invoke('inspirations:move', id, status, sort),
    reorder: (moves: { id: number; status: string; sort: number }[]): Promise<boolean> =>
      ipcRenderer.invoke('inspirations:reorder', moves),
    discard: (id: number): Promise<boolean> => ipcRenderer.invoke('item:discard', 'inspirations', id),
    /** 「来5条灵感」：已有灵感画像 → LLM 生成 5 条入草稿区（specs §6.2） */
    generate: (): Promise<{ generated: number; inserted: number }> =>
      ipcRenderer.invoke('inspirations:generate'),
    /** AI 完善：生成扩展建议 md（不写库），预览确认后走 appendRefine */
    refine: (id: number): Promise<string> => ipcRenderer.invoke('inspirations:refine', id),
    /** 确认追加：以「## AI 补充 · 时间」段追加到该条 md 末尾 */
    appendRefine: (id: number, content: string): Promise<boolean> =>
      ipcRenderer.invoke('inspirations:appendRefine', id, content)
  },
  verify: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('verify:list'),
    get: (id: number): Promise<unknown> => ipcRenderer.invoke('verify:get', id),
    findDuplicate: (claim: string): Promise<{ id: number; claim: string; created_at: string } | null> =>
      ipcRenderer.invoke('verify:findDuplicate', claim),
    run: (claim: string): Promise<{ recordId: number; credibility: number }> =>
      ipcRenderer.invoke('verify:run', claim),
    discard: (id: number): Promise<boolean> => ipcRenderer.invoke('item:discard', 'verify_records', id)
  },
  llm: {
    test: (config: unknown): Promise<void> => ipcRenderer.invoke('llm:test', config),
    models: (config: unknown): Promise<string[]> => ipcRenderer.invoke('llm:models', config)
  },
  mcp: {
    listEnabled: (): Promise<{ name: string; url: string; enabled: boolean }[]> =>
      ipcRenderer.invoke('mcp:listEnabled'),
    /** AI 辅助配置：研究 MCP 配置元数据（Registry/文档/LLM 三步降级） */
    research: (name: string): Promise<import('../src/shared/types').McpResearch> =>
      ipcRenderer.invoke('mcp:research', name),
    /** 测试连接：initialize + tools/list，返回工具名列表 */
    test: (config: {
      name: string
      url: string
      authType?: 'none' | 'bearer'
      apiKey?: string
    }): Promise<{ tools: string[] }> => ipcRenderer.invoke('mcp:test', config)
  },
  storage: {
    /** 当前数据存储目录（绝对路径） */
    currentDir: (): Promise<string> => ipcRenderer.invoke('storage:currentDir'),
    /** 选择目录（系统对话框），返回绝对路径或 null */
    pickDir: (): Promise<string | null> => ipcRenderer.invoke('storage:pickDir'),
    /** 迁移数据到新目录；成功后需重启 App 生效 */
    migrate: (newDir: string): Promise<boolean> => ipcRenderer.invoke('storage:migrate', newDir),
    /** 在资源管理器中打开目录 */
    openDir: (dir: string): Promise<boolean> => ipcRenderer.invoke('storage:openDir', dir),
    /** 迁移完成后重启 App */
    relaunch: (): Promise<boolean> => ipcRenderer.invoke('storage:relaunch')
  },
  shell: {
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:openExternal', url)
  },
  clipboard: {
    /** 写文本入系统剪贴板（格言复制等） */
    writeText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:writeText', text)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
