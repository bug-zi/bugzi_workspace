// 渲染层全局 window.api 类型（preload 桥）
export type ModuleId = 'mottos' | 'wiki' | 'inspirations' | 'verify' | 'zhijiji' | 'recycle' | 'profile'

/** AI 边栏频道（DB v9 频道制） */
export type AiChannel = 'assistant' | 'motto' | 'wiki' | 'zhijiji' | 'verify'

export interface MottoRecord {
  id: number
  content: string
  source: string
  status: 'draft' | 'settled' | 'formal'
  note_path: string | null
  origin: 'manual' | 'ai'
  /** 区内排序（越小越靠前，DB v3） */
  sort: number
  /** 标签（DB v5，JSON 列解析而来；可能为空数组） */
  tags: string[]
  /** 生成类型（DB v6）：excerpt=现实摘录 | composed=AI 编撰（DB v10 起出处署名 debugzi） | null=手动录入/未知 */
  gen_kind: 'excerpt' | 'composed' | null
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

/** 测一测题目（wiki.quiz 返回） */
export interface WikiQuizQuestion {
  /** 来源词条 id */
  entryId: number
  /** 来源词条名 */
  term: string
  question: string
  options: string[]
  /** 正确选项下标 0..3 */
  answer: number
}

export interface InspirationRecord {
  id: number
  title: string
  status: 'draft' | 'project' | 'develop' | 'archive'
  md_path: string
  sort: number
  /** 来源（DB v7）：manual=手动新建 | ai=「来5条灵感」生成（列表 AI 徽标依据） */
  origin: 'manual' | 'ai'
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
  source: 'mottos' | 'wiki' | 'inspirations' | 'verify' | 'zhijiji'
  item_id: number
  payload: string
  created_at: string
}

/** 致知己问题（DB v9；列表行聚合版本数） */
export interface ZhijijiQuestion {
  id: number
  title: string
  tags: string[]
  version_count: number
  created_at: string
  updated_at: string
}

/** 致知己答案版本（DB v9；标识 v{seq}-{date}） */
export interface ZhijijiVersion {
  id: number
  question_id: number
  seq: number
  /** YYMMDD，该版本内容最后写入日（覆盖时更新为覆盖当日） */
  date: string
  md_path: string
  created_at: string
  updated_at: string
}

/** 我的画像条目（DB v9） */
export interface ProfileFactRow {
  id: number
  category: string
  content: string
  /** manual=个人中心手填 | ai=对话中提炼经确认入档 */
  source: 'manual' | 'ai'
  created_at: string
  updated_at: string
}

export interface AiMessageRow {
  id: number
  /** 所属会话 */
  session_id: number
  role: 'user' | 'assistant' | 'system'
  ai_module: string | null
  content: string
  created_at: string
}

export interface AiSessionRow {
  id: number
  title: string
  /** 所属频道（DB v9） */
  channel: AiChannel
  created_at: string
  updated_at: string
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
      table: 'mottos' | 'wiki_entries' | 'inspirations' | 'verify_records' | 'zhijiji_questions',
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
    messages(sessionId: number): Promise<AiMessageRow[]>
    chat(
      message: string,
      currentModule: string,
      sessionId: number,
      channel?: AiChannel
    ): Promise<{ id: number; role: string; content: string }>
    configured(): Promise<boolean>
    pushSystem(content: string): Promise<boolean>
    deleteMessage(id: number): Promise<boolean>
    /** 改写消息内容（画像建议「加入/忽略」后剥除协议标记行） */
    editMessage(id: number, content: string): Promise<boolean>
    onMessage(cb: (msg: AiMessageRow) => void): () => void
  }
  aiSession: {
    /** 会话列表（最近活跃在前，按频道隔离） */
    list(channel?: AiChannel): Promise<AiSessionRow[]>
    create(channel?: AiChannel): Promise<AiSessionRow>
    rename(id: number, title: string): Promise<boolean>
    /** 删除会话（连同消息）；删的是该频道激活会话时主进程在同频道内自动切换/清除激活 */
    delete(id: number, channel?: AiChannel): Promise<boolean>
    active(channel?: AiChannel): Promise<number | null>
    /** /compact：把该会话历史压成前情摘要另存新会话（原会话保留），返回新会话 */
    compact(sessionId: number): Promise<AiSessionRow>
    /** /clear：清空该会话全部消息（会话保留，上下文与存储一并清零） */
    clear(sessionId: number): Promise<boolean>
  }
  zhijiji: {
    list(): Promise<ZhijijiQuestion[]>
    /** 新问题：默认建空白 v1（直开编辑态）；aiInit=true 时 LLM 先生成初始参考答案（v0），失败抛错不创建 */
    createQuestion(
      title: string,
      tags?: string[],
      aiInit?: boolean
    ): Promise<{ questionId: number; versionId: number; mdPath: string }>
    versions(questionId: number): Promise<ZhijijiVersion[]>
    /** 保存为新版本：seq=max+1、date=当日 */
    saveNewVersion(
      questionId: number,
      content: string
    ): Promise<{ versionId: number; seq: number; date: string }>
    /** 覆盖当前版本：序号不变、日期更新为覆盖当日 */
    overwriteVersion(versionId: number, content: string): Promise<boolean>
    renameQuestion(id: number, title: string): Promise<boolean>
    discard(id: number): Promise<boolean>
  }
  profile: {
    list(): Promise<ProfileFactRow[]>
    /** source: manual（手填，默认）| ai（对话中提炼经确认入档） */
    add(category: string, content: string, source?: 'manual' | 'ai'): Promise<number>
    update(id: number, category: string, content: string): Promise<boolean>
    delete(id: number): Promise<boolean>
  }
  mottos: {
    list(status?: string): Promise<MottoRecord[]>
    create(content: string, source: string, status: string, tags?: string[]): Promise<number>
    update(id: number, content: string, source: string, tags?: string[]): Promise<boolean>
    setStatus(id: number, status: string): Promise<boolean>
    /** 覆盖式设置标签（v2.0，传空数组即清空） */
    setTags(id: number, tags: string[]): Promise<boolean>
    /** 区内重排（sort 覆盖为 0..n-1） */
    reorder(moves: { id: number; sort: number }[]): Promise<boolean>
    discard(id: number): Promise<boolean>
    generate(): Promise<{
      generated: number
      inserted: number
      excerptInserted: number
      composedInserted: number
    }>
    normalize(s: string): Promise<string>
    /** 未删除区内判重（v2.0：规范化一致或包含关系） */
    checkDuplicate(content: string): Promise<boolean>
    /** 直接删除：越过回收站彻底删除（含笔记 md），需前端二次确认 */
    deleteForever(id: number): Promise<boolean>
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
    /** 随机词条名（指定板块用板块，未指定随机挑；只构思词条名不生成卡片） */
    suggestTerm(sectionId: number | null): Promise<string>
    /** 测一测：随机 5 张卡片各出 1 道四选一 */
    quiz(): Promise<WikiQuizQuestion[]>
    /** 直接删除词条（生成审核流）：彻底删除卡片 md + 高光 + 词条，需前端二次确认 */
    deleteForeverEntry(id: number): Promise<boolean>
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
    /** 「来5条灵感」：已有灵感画像 → LLM 生成 5 条入草稿区（specs §6.2） */
    generate(): Promise<{ generated: number; inserted: number }>
    /** AI 完善：生成扩展建议 md（不写库），预览确认后走 appendRefine */
    refine(id: number): Promise<string>
    /** 确认追加：以「## AI 补充 · 时间」段追加到该条 md 末尾 */
    appendRefine(id: number, content: string): Promise<boolean>
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
