// 渲染层全局 window.api 类型（preload 桥）
export type ModuleId = 'mottos' | 'wiki' | 'inspirations' | 'verify' | 'recycle' | 'profile'

export interface MottoRecord {
  id: number
  content: string
  source: string
  status: 'draft' | 'settled' | 'formal'
  note_path: string | null
  origin: 'manual' | 'ai'
  /** 区内排序（越小越靠前，DB v3） */
  sort: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface WikiSection {
  id: number
  name: string
  sort: number
  created_at: string
}

export interface WikiEntry {
  id: number
  section_id: number
  term: string
  summary: string
  md_path: string
  origin: 'ai' | 'manual'
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface WikiHighlightRow {
  id: number
  entry_id: number
  text: string
  created_at: string
  term: string
}

export interface InspirationRecord {
  id: number
  title: string
  status: 'draft' | 'project' | 'develop' | 'archive'
  md_path: string
  sort: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface VerifyRecord {
  id: number
  claim: string
  analysis: string
  credibility: number
  md_path: string
  created_at: string
  deleted_at: string | null
}

export interface RecycleRow {
  id: number
  source: 'mottos' | 'wiki' | 'inspirations' | 'verify'
  item_id: number
  payload: string
  created_at: string
}

export interface AiMessageRow {
  id: number
  role: 'user' | 'assistant' | 'system'
  ai_module: string | null
  content: string
  created_at: string
}

export interface LlmConfig {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
}

export interface McpConfig {
  id: string
  name: string
  url: string
  enabled: boolean
  /** 鉴权方式（可选，缺省 none；bearer 时请求带 Authorization 头） */
  authType?: 'none' | 'bearer'
  /** bearer 鉴权的 API Key */
  apiKey?: string
}

/** AI 辅助 MCP 配置：需填写的密钥信息 */
export interface McpResearchKey {
  name: string
  description: string
  /** 申请入口链接 */
  applyUrl: string
}

/** AI 辅助 MCP 配置：研究结果 */
export interface McpResearch {
  title: string
  description: string
  /** 远程端点模板；含 {apiKey} 占位符时用用户填写的 key 替换后存储 */
  urlTemplate: string
  authType: 'none' | 'bearer'
  keys: McpResearchKey[]
  docsUrl: string
  source: 'registry' | 'docs' | 'llm'
  notes: string
}

// preload 暴露的完整 API 形状（与 electron/preload.ts 保持同步）
export interface Api {
  settings: {
    getAll(): Promise<Record<string, string>>
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<boolean>
  }
  md: {
    read(path: string): Promise<string>
    write(path: string, content: string): Promise<boolean>
    create(path: string, content: string): Promise<boolean>
    delete(path: string): Promise<boolean>
  }
  image: {
    pick(kind: 'avatar' | 'bg-light' | 'bg-dark'): Promise<boolean | null>
  }
  item: {
    discard(
      table: 'mottos' | 'wiki_entries' | 'inspirations' | 'verify_records',
      id: number
    ): Promise<boolean>
    onRecycleChanged(cb: () => void): () => void
  }
  recycle: {
    list(): Promise<RecycleRow[]>
    restore(id: number): Promise<{ source: string; item_id: number }>
    delete(id: number): Promise<boolean>
  }
  ai: {
    messages(): Promise<AiMessageRow[]>
    chat(message: string, currentModule: string): Promise<{ id: number; role: string; content: string }>
    configured(): Promise<boolean>
    pushSystem(content: string): Promise<boolean>
    onMessage(cb: (msg: AiMessageRow) => void): () => void
  }
  mottos: {
    list(status?: string): Promise<MottoRecord[]>
    create(content: string, source: string, status: string): Promise<number>
    update(id: number, content: string, source: string): Promise<boolean>
    setStatus(id: number, status: string): Promise<boolean>
    /** 区内重排（sort 覆盖为 0..n-1） */
    reorder(moves: { id: number; sort: number }[]): Promise<boolean>
    discard(id: number): Promise<boolean>
    generate(): Promise<{ generated: number; inserted: number }>
    normalize(s: string): Promise<string>
  }
  wiki: {
    sections(): Promise<WikiSection[]>
    createSection(name: string): Promise<number>
    renameSection(id: number, name: string): Promise<boolean>
    deleteSection(id: number): Promise<boolean>
    entries(sectionId: number): Promise<WikiEntry[]>
    entry(id: number): Promise<WikiEntry>
    updateEntry(id: number, term: string, summary: string): Promise<boolean>
    generate(
      term: string | null,
      sectionId: number | null
    ): Promise<
      { ok: true; data: { entryId: number; term: string; summary: string } } | { ok: false; conflict: string }
    >
    highlights(): Promise<WikiHighlightRow[]>
    addHighlight(entryId: number, text: string): Promise<boolean>
    deleteHighlight(id: number): Promise<boolean>
    discardEntry(id: number): Promise<boolean>
  }
  inspirations: {
    list(): Promise<InspirationRecord[]>
    create(title: string, status: string): Promise<number>
    updateTitle(id: number, title: string): Promise<boolean>
    move(id: number, status: string, sort: number): Promise<boolean>
    reorder(moves: { id: number; status: string; sort: number }[]): Promise<boolean>
    discard(id: number): Promise<boolean>
  }
  verify: {
    list(): Promise<VerifyRecord[]>
    get(id: number): Promise<VerifyRecord>
    findDuplicate(claim: string): Promise<{ id: number; claim: string; created_at: string } | null>
    run(claim: string): Promise<{ recordId: number; credibility: number }>
    discard(id: number): Promise<boolean>
  }
  llm: {
    test(config: LlmConfig): Promise<void>
    models(config: LlmConfig): Promise<string[]>
  }
  mcp: {
    listEnabled(): Promise<{ name: string; url: string; enabled: boolean }[]>
    /** AI 辅助配置：研究 MCP 配置元数据（Registry/文档/LLM 三步降级） */
    research(name: string): Promise<McpResearch>
    /** 测试连接：initialize + tools/list，返回工具名列表 */
    test(config: {
      name: string
      url: string
      authType?: 'none' | 'bearer'
      apiKey?: string
    }): Promise<{ tools: string[] }>
  }
  storage: {
    /** 当前数据存储目录（绝对路径） */
    currentDir(): Promise<string>
    /** 选择目录（系统对话框），返回绝对路径或 null */
    pickDir(): Promise<string | null>
    /** 迁移数据到新目录；成功后需重启 App 生效 */
    migrate(newDir: string): Promise<boolean>
    /** 在资源管理器中打开目录 */
    openDir(dir: string): Promise<boolean>
    /** 迁移完成后重启 App */
    relaunch(): Promise<boolean>
  }
  shell: {
    openExternal(url: string): Promise<boolean>
  }
  clipboard: {
    /** 写文本入系统剪贴板（格言复制等） */
    writeText(text: string): Promise<boolean>
  }
}

declare global {
  interface Window {
    api: Api
  }
}
