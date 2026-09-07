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
    discard: (
      table:
        | 'mottos'
        | 'wiki_entries'
        | 'inspirations'
        | 'verify_records'
        | 'zhijiji_questions'
        | 'turtle_soups'
        | 'turtle_games'
        | 'drafts',
      id: number
    ): Promise<boolean> => ipcRenderer.invoke('item:discard', table, id),
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
      {
        id: number
        source:
          | 'mottos'
          | 'wiki'
          | 'inspirations'
          | 'verify'
          | 'zhijiji'
          | 'reasoning_soup'
          | 'reasoning_game'
          | 'drafts'
        item_id: number
        payload: string
        created_at: string
      }[]
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
      sessionId: number,
      channel?: string
    ): Promise<{ id: number; role: string; content: string }> =>
      ipcRenderer.invoke('ai:chat', message, currentModule, sessionId, channel),
    configured: (): Promise<boolean> => ipcRenderer.invoke('ai:configured'),
    pushSystem: (content: string): Promise<boolean> => ipcRenderer.invoke('ai:pushSystem', content),
    deleteMessage: (id: number): Promise<boolean> => ipcRenderer.invoke('ai:deleteMessage', id),
    /** 改写消息内容（画像建议「加入/忽略」后剥除协议标记行） */
    editMessage: (id: number, content: string): Promise<boolean> =>
      ipcRenderer.invoke('ai:editMessage', id, content),
    onMessage: (cb: (msg: unknown) => void): (() => void) => {
      const listener = (_e: unknown, msg: unknown): void => {
        cb(msg)
      }
      ipcRenderer.on('ai:message', listener)
      return () => ipcRenderer.removeListener('ai:message', listener)
    }
  },
  aiSession: {
    /** 会话列表（最近活跃在前，按频道隔离） */
    list: (channel?: string): Promise<
      { id: number; title: string; channel: string; created_at: string; updated_at: string }[]
    > => ipcRenderer.invoke('aiSession:list', channel),
    create: (channel?: string): Promise<{
      id: number
      title: string
      channel: string
      created_at: string
      updated_at: string
    }> => ipcRenderer.invoke('aiSession:create', channel),
    rename: (id: number, title: string): Promise<boolean> =>
      ipcRenderer.invoke('aiSession:rename', id, title),
    /** 删除会话（连同消息）；删的是该频道激活会话时主进程在同频道内自动切换/清除激活 */
    delete: (id: number, channel?: string): Promise<boolean> =>
      ipcRenderer.invoke('aiSession:delete', id, channel),
    active: (channel?: string): Promise<number | null> => ipcRenderer.invoke('aiSession:active', channel),
    /** /compact：把该会话历史压成前情摘要另存新会话（原会话保留），返回新会话 */
    compact: (sessionId: number): Promise<{
      id: number
      title: string
      channel: string
      created_at: string
      updated_at: string
    }> => ipcRenderer.invoke('aiSession:compact', sessionId),
    /** /clear：清空该会话全部消息（会话保留，上下文与存储一并清零） */
    clear: (sessionId: number): Promise<boolean> => ipcRenderer.invoke('aiSession:clear', sessionId)
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
    /** 「来5条灵感」：两阶段生成（发散 12 → 配额自评 5）入草稿区；winds 为本批风向（specs §6.2 + 优化建议区任务2） */
    generate: (): Promise<{ generated: number; inserted: number; winds: string[] }> =>
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
  zhijiji: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('zhijiji:list'),
    /** 新问题：默认建空白 v1；aiInit=true 时 LLM 先生成初始参考答案（v0），失败抛错不创建 */
    createQuestion: (
      title: string,
      tags?: string[],
      aiInit?: boolean
    ): Promise<{ questionId: number; versionId: number; mdPath: string }> =>
      ipcRenderer.invoke('zhijiji:createQuestion', title, tags, aiInit),
    versions: (questionId: number): Promise<unknown[]> => ipcRenderer.invoke('zhijiji:versions', questionId),
    /** 保存为新版本：seq=max+1、date=当日，返回新版本标识 */
    saveNewVersion: (questionId: number, content: string): Promise<{ versionId: number; seq: number; date: string }> =>
      ipcRenderer.invoke('zhijiji:saveNewVersion', questionId, content),
    /** 覆盖当前版本：序号不变、日期更新为覆盖当日 */
    overwriteVersion: (versionId: number, content: string): Promise<boolean> =>
      ipcRenderer.invoke('zhijiji:overwriteVersion', versionId, content),
    renameQuestion: (id: number, title: string): Promise<boolean> =>
      ipcRenderer.invoke('zhijiji:renameQuestion', id, title),
    discard: (id: number): Promise<boolean> => ipcRenderer.invoke('item:discard', 'zhijiji_questions', id)
  },
  turtle: {
    /** 「来 3 碗汤」：难度偏好可选（random 默认），3 碗三件套入库汤库 */
    generate: (
      preference?: 'random' | 'easy' | 'medium' | 'hard'
    ): Promise<{ generated: number; inserted: number }> =>
      ipcRenderer.invoke('turtle:generate', preference ?? 'random'),
    listSoups: (difficulty?: string): Promise<unknown[]> =>
      ipcRenderer.invoke('turtle:listSoups', difficulty),
    /** 开局/续局：fresh 建新局、playing 返回现有局；终态汤抛 SOUP_FINISHED */
    openSoup: (soupId: number): Promise<unknown> => ipcRenderer.invoke('turtle:openSoup', soupId),
    game: (gameId: number): Promise<unknown> => ipcRenderer.invoke('turtle:game', gameId),
    /** 提问 → 裁判只答是/否/与汤无关（invalid=非判断句引导，不计有效问答） */
    ask: (
      gameId: number,
      question: string
    ): Promise<{ type: 'yes' | 'no' | 'irrelevant' | 'invalid'; reply: string; questionCount: number }> =>
      ipcRenderer.invoke('turtle:ask', gameId, question),
    /** 猜汤底：未破给方向反馈；破汤由主进程完成终局链（点评+存档）后返回 */
    guess: (
      gameId: number,
      reasoning: string
    ): Promise<{
      solved: boolean
      bottom?: string
      hits: string[]
      misses: string[]
      feedback: string
      mdPath?: string
    }> => ipcRenderer.invoke('turtle:guess', gameId, reasoning),
    /** 放弃（前端二次确认后调用）：揭示汤底 + 终局链 */
    abandon: (gameId: number): Promise<{ bottom: string; mdPath: string }> =>
      ipcRenderer.invoke('turtle:abandon', gameId),
    /** 汤入回收站（进行中的汤抛 PLAYING） */
    discardSoup: (soupId: number): Promise<boolean> =>
      ipcRenderer.invoke('turtle:discardSoup', soupId),
    /** 对局记录入回收站（仅终局局） */
    discardGame: (gameId: number): Promise<boolean> =>
      ipcRenderer.invoke('turtle:discardGame', gameId),
    /** 终局局列表（ended_at 倒序，含汤名/难度） */
    listGames: (): Promise<unknown[]> => ipcRenderer.invoke('turtle:listGames')
  },
  wall: {
    /** 打开现出：无当日题则现场生成（LLM 未配置抛 LLM_NOT_CONFIGURED） */
    ensureToday: (): Promise<unknown> => ipcRenderer.invoke('wall:ensureToday'),
    /** 提交作答：判对错（宽松等价）+ 讲解 + 写详情 md；答错即终局 */
    answer: (
      puzzleId: number,
      myAnswer: string
    ): Promise<{ correct: boolean; standardAnswer: string; explanation: string; mdPath: string }> =>
      ipcRenderer.invoke('wall:answer', puzzleId, myAnswer),
    /** 取下一级提示（库存直取不调 LLM）；用尽返回 null */
    hint: (puzzleId: number): Promise<{ level: number; text: string } | null> =>
      ipcRenderer.invoke('wall:hint', puzzleId),
    /** 月历数据：连胜 + 当月对/错计数 + 各日格态 */
    month: (
      year: number,
      month: number
    ): Promise<{ streak: number; correct: number; wrong: number; days: unknown[] }> =>
      ipcRenderer.invoke('wall:month', year, month),
    recordPath: (date: string): Promise<string | null> => ipcRenderer.invoke('wall:recordPath', date),
    /** 练习场：随时出一道（pref: random|easy|medium|hard；typePref: 题型可选；不计入墙与连胜） */
    practiceNew: (pref: string, typePref?: string): Promise<unknown> =>
      ipcRenderer.invoke('wall:practiceNew', pref, typePref),
    /** 练习场判答（一题一命，判答即终局；无 md 落盘） */
    practiceAnswer: (
      practiceId: number,
      myAnswer: string
    ): Promise<{ correct: boolean; standardAnswer: string; explanation: string }> =>
      ipcRenderer.invoke('wall:practiceAnswer', practiceId, myAnswer),
    /** 练习场取下一级提示（内存直取不调 LLM）；用尽返回 null */
    practiceHint: (practiceId: number): Promise<{ level: number; text: string } | null> =>
      ipcRenderer.invoke('wall:practiceHint', practiceId),
    /** 精选题库：列表（不泄答案与论证） */
    bankList: (): Promise<unknown[]> => ipcRenderer.invoke('wall:bankList'),
    /** 精选题库：打开一题（不泄答案与论证） */
    bankOpen: (bankId: number): Promise<unknown> => ipcRenderer.invoke('wall:bankOpen', bankId),
    /** 精选题库：提交作答（终态；判答 + 写详情 md） */
    bankAnswer: (
      bankId: number,
      myAnswer: string
    ): Promise<{ correct: boolean; standardAnswer: string; explanation: string; mdPath: string }> =>
      ipcRenderer.invoke('wall:bankAnswer', bankId, myAnswer),
    /** 精选题库：看解答（终态，不判答直接揭示；写详情 md） */
    bankReveal: (
      bankId: number
    ): Promise<{ standardAnswer: string; solution: string; mdPath: string }> =>
      ipcRenderer.invoke('wall:bankReveal', bankId)
  },
  draft: {
    /** 某频道草稿列表（updated_at 倒序） */
    list: (channel?: string): Promise<
      { id: number; title: string; channel: string; md_path: string; created_at: string; updated_at: string }[]
    > => ipcRenderer.invoke('draft:list', channel ?? 'general'),
    /** 新建草稿（归属频道；海龟汤联动预填标题与正文模板），返回新草稿 id */
    create: (channel: string, title?: string | null, content?: string | null): Promise<number> =>
      ipcRenderer.invoke('draft:create', channel, title ?? null, content ?? null),
    /** 改标题（不动 updated_at，列表顺序稳定） */
    rename: (id: number, title: string): Promise<boolean> =>
      ipcRenderer.invoke('draft:rename', id, title),
    /** 保存正文（md.write + 触碰 updated_at 浮回列表顶部） */
    save: (id: number, content: string): Promise<boolean> =>
      ipcRenderer.invoke('draft:save', id, content),
    /** 大窗编辑（MdDialog 自行保存）后的触碰：只 bump updated_at */
    touch: (id: number): Promise<boolean> => ipcRenderer.invoke('draft:touch', id),
    /** 草稿入回收站（前端二次确认后调用） */
    discard: (id: number): Promise<boolean> => ipcRenderer.invoke('item:discard', 'drafts', id)
  },
  profile: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('profile:list'),
    /** source: manual（手填，默认）| ai（对话中提炼经确认入档） */
    add: (category: string, content: string, source?: 'manual' | 'ai'): Promise<number> =>
      ipcRenderer.invoke('profile:add', category, content, source),
    update: (id: number, category: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke('profile:update', id, category, content),
    delete: (id: number): Promise<boolean> => ipcRenderer.invoke('profile:delete', id)
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
