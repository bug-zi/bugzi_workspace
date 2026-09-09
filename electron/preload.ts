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
        | 'drafts'
        | 'canvases',
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
          | 'canvases'
          | 'wenbi_journal'
          | 'wenbi_article'
          | 'ledger_tx'
          | 'ledger_account'
          | 'ledger_category'
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
      jobId: string,
      message: string,
      currentModule: string,
      sessionId: number,
      channel?: string
    ): Promise<{ id: number; role: string; content: string }> =>
      ipcRenderer.invoke('ai:chat', jobId, message, currentModule, sessionId, channel),
    configured: (): Promise<boolean> => ipcRenderer.invoke('ai:configured'),
    /** 取消进行中的 AI 任务（false = 任务已结束，静默即可） */
    cancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke('ai:cancel', jobId),
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
    compact: (jobId: string, sessionId: number): Promise<{
      id: number
      title: string
      channel: string
      created_at: string
      updated_at: string
    }> => ipcRenderer.invoke('aiSession:compact', jobId, sessionId),
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
    generate: (jobId: string): Promise<{
      generated: number
      inserted: number
      excerptInserted: number
      composedInserted: number
      patternRejected: number
      /** 命中已删除格言墓碑被剔除的条数（优化建议区第24轮） */
      tombstoneRejected: number
      /** 补足轮最终入库条数（优化建议区第24轮） */
      supplemented: number
      /** 因口语化被剔除的编撰条数（优化建议区第27轮） */
      colloquialRejected: number
    }> => ipcRenderer.invoke('mottos:generate', jobId),
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
      jobId: string,
      term: string | null,
      sectionId: number | null
    ): Promise<{ ok: true; data: { entryId: number; term: string; summary: string } } | { ok: false; conflict: string }> =>
      ipcRenderer.invoke('wiki:generate', jobId, term, sectionId),
    /** 随机词条名（指定板块用板块，未指定随机挑；只构思词条名不生成卡片） */
    suggestTerm: (jobId: string, sectionId: number | null): Promise<string> =>
      ipcRenderer.invoke('wiki:suggestTerm', jobId, sectionId),
    /** 测一测：随机 5 张卡片各出 1 道四选一 */
    quiz: (jobId: string): Promise<
      { entryId: number; term: string; question: string; options: string[]; answer: number }[]
    > => ipcRenderer.invoke('wiki:quiz', jobId),
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
    generate: (jobId: string): Promise<{ generated: number; inserted: number; winds: string[] }> =>
      ipcRenderer.invoke('inspirations:generate', jobId),
    /** AI 完善：生成扩展建议 md（不写库），预览确认后走 appendRefine */
    refine: (jobId: string, id: number): Promise<string> => ipcRenderer.invoke('inspirations:refine', jobId, id),
    /** 确认追加：以「## AI 补充 · 时间」段追加到该条 md 末尾 */
    appendRefine: (id: number, content: string): Promise<boolean> =>
      ipcRenderer.invoke('inspirations:appendRefine', id, content)
  },
  verify: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('verify:list'),
    get: (id: number): Promise<unknown> => ipcRenderer.invoke('verify:get', id),
    findDuplicate: (claim: string): Promise<{ id: number; claim: string; created_at: string } | null> =>
      ipcRenderer.invoke('verify:findDuplicate', claim),
    run: (jobId: string, claim: string): Promise<{ recordId: number; credibility: number }> =>
      ipcRenderer.invoke('verify:run', jobId, claim),
    discard: (id: number): Promise<boolean> => ipcRenderer.invoke('item:discard', 'verify_records', id)
  },
  zhijiji: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('zhijiji:list'),
    /** 新问题：默认建空白 v1；aiInit=true 时 LLM 先生成初始参考答案（v0），失败抛错不创建 */
    createQuestion: (
      jobId: string,
      title: string,
      tags?: string[],
      aiInit?: boolean
    ): Promise<{ questionId: number; versionId: number; mdPath: string }> =>
      ipcRenderer.invoke('zhijiji:createQuestion', jobId, title, tags, aiInit),
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
  reasoning: {
    /** 题库补充泵触发（v1.3）：进入推理角模块时调；存量达标即 no-op，主进程 fire-and-forget */
    stockCheck: (): Promise<boolean> => ipcRenderer.invoke('reasoning:stockCheck'),
    /** 补充泵每补完一批推送（v1.3，照 recycle:changed 模式）：汤库列表渐进刷新 */
    onStockChanged: (cb: () => void): (() => void) => {
      const listener = (): void => {
        cb()
      }
      ipcRenderer.on('reasoning:stockChanged', listener)
      return () => ipcRenderer.removeListener('reasoning:stockChanged', listener)
    }
  },
  turtle: {
    /** 「来 3 碗汤」：难度偏好可选（random 默认），3 碗三件套入库汤库 */
    generate: (
      jobId: string,
      preference?: 'random' | 'easy' | 'medium' | 'hard'
    ): Promise<{ generated: number; inserted: number }> =>
      ipcRenderer.invoke('turtle:generate', jobId, preference ?? 'random'),
    listSoups: (difficulty?: string): Promise<unknown[]> =>
      ipcRenderer.invoke('turtle:listSoups', difficulty),
    /** 开局/续局：fresh 建新局、playing 返回现有局；终态汤抛 SOUP_FINISHED */
    openSoup: (soupId: number): Promise<unknown> => ipcRenderer.invoke('turtle:openSoup', soupId),
    game: (gameId: number): Promise<unknown> => ipcRenderer.invoke('turtle:game', gameId),
    /** 提问 → 裁判只答是/否/与汤无关（invalid=非判断句引导，不计有效问答） */
    ask: (
      jobId: string,
      gameId: number,
      question: string
    ): Promise<{ type: 'yes' | 'no' | 'irrelevant' | 'invalid'; reply: string; questionCount: number }> =>
      ipcRenderer.invoke('turtle:ask', jobId, gameId, question),
    /** 猜汤底：未破给方向反馈；破汤终局链（净用时结算，不生成报告）后返回汤底 */
    guess: (
      jobId: string,
      gameId: number,
      reasoning: string
    ): Promise<{
      solved: boolean
      bottom?: string
      hits: string[]
      misses: string[]
      feedback: string
      durationMs: number
    }> => ipcRenderer.invoke('turtle:guess', jobId, gameId, reasoning),
    /** 放弃（前端二次确认后调用）：秒回汤底（净用时结算，报告点「查看复盘」时生成） */
    abandon: (jobId: string, gameId: number): Promise<{ bottom: string; durationMs: number }> =>
      ipcRenderer.invoke('turtle:abandon', jobId, gameId),
    /** 净用时记账（边界事件）：start=开段（幂等） / pause=结算当前段 */
    timerStart: (gameId: number): Promise<boolean> =>
      ipcRenderer.invoke('turtle:timerStart', gameId),
    timerPause: (gameId: number): Promise<boolean> =>
      ipcRenderer.invoke('turtle:timerPause', gameId),
    /** 复盘报告 ensure：已有 md 直接返回路径，无则现场生成（含 AI 点评，可取消/失败可重试） */
    report: (jobId: string, gameId: number): Promise<string> =>
      ipcRenderer.invoke('turtle:report', jobId, gameId),
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
    ensureToday: (jobId: string): Promise<unknown> => ipcRenderer.invoke('wall:ensureToday', jobId),
    /** 提交作答：判对错（宽松等价）+ 讲解 + 写详情 md；答错即终局 */
    answer: (
      jobId: string,
      puzzleId: number,
      myAnswer: string
    ): Promise<{ correct: boolean; standardAnswer: string; explanation: string; mdPath: string }> =>
      ipcRenderer.invoke('wall:answer', jobId, puzzleId, myAnswer),
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
    /** 练习场：随时出一道（pref: random|easy|medium|hard；typePref: 题型可选；不计入墙与连胜；生成即入题库 todo 态） */
    practiceNew: (jobId: string, pref: string, typePref?: string): Promise<unknown> =>
      ipcRenderer.invoke('wall:practiceNew', jobId, pref, typePref),
    /** 练习场判答（一题一命，判答即终局；回写题库终态与详情 md） */
    practiceAnswer: (
      jobId: string,
      practiceId: number,
      myAnswer: string
    ): Promise<{ correct: boolean; standardAnswer: string; explanation: string }> =>
      ipcRenderer.invoke('wall:practiceAnswer', jobId, practiceId, myAnswer),
    /** 练习场取下一级提示（内存直取不调 LLM）；用尽返回 null */
    practiceHint: (practiceId: number): Promise<{ level: number; text: string } | null> =>
      ipcRenderer.invoke('wall:practiceHint', practiceId),
    /** 题库：列表（不泄答案与论证） */
    bankList: (): Promise<unknown[]> => ipcRenderer.invoke('wall:bankList'),
    /** 题库：打开一题（不泄答案与论证） */
    bankOpen: (bankId: number): Promise<unknown> => ipcRenderer.invoke('wall:bankOpen', bankId),
    /** 题库：提交作答（终态；判答 + 写详情 md） */
    bankAnswer: (
      jobId: string,
      bankId: number,
      myAnswer: string
    ): Promise<{ correct: boolean; standardAnswer: string; explanation: string; mdPath: string }> =>
      ipcRenderer.invoke('wall:bankAnswer', jobId, bankId, myAnswer),
    /** 题库：看解答（终态，不判答直接揭示；写详情 md） */
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
  canvas: {
    /** 画布列表（updated_at 倒序） */
    list: (): Promise<
      { id: number; title: string; path: string; created_at: string; updated_at: string }[]
    > => ipcRenderer.invoke('canvas:list'),
    /** 新建画布（自动命名「未命名画布 N」），返回新画布 id */
    create: (): Promise<number> => ipcRenderer.invoke('canvas:create'),
    /** 改标题（不动 updated_at，列表顺序稳定） */
    rename: (id: number, title: string): Promise<boolean> =>
      ipcRenderer.invoke('canvas:rename', id, title),
    /** 保存场景（.excalidraw JSON 落盘 + 触碰 updated_at 浮回列表顶部） */
    save: (id: number, json: string): Promise<boolean> =>
      ipcRenderer.invoke('canvas:save', id, json),
    /** 画布入回收站（前端二次确认后调用） */
    discard: (id: number): Promise<boolean> => ipcRenderer.invoke('item:discard', 'canvases', id)
  },
  wenbi: {
    /** 浮生记条目列表（created_at 倒序；零 AI 板块） */
    journalList: (): Promise<import('../src/shared/types').WenbiJournalRecord[]> =>
      ipcRenderer.invoke('wenbi:journalList'),
    /** 新建一条记录（返回整行，渲染层据 created_at 拼日期标题并 autoEdit） */
    journalCreate: (): Promise<import('../src/shared/types').WenbiJournalRecord> =>
      ipcRenderer.invoke('wenbi:journalCreate'),
    /** 大事件标记切换 */
    journalSetEvent: (id: number, isEvent: boolean): Promise<boolean> =>
      ipcRenderer.invoke('wenbi:journalSetEvent', id, isEvent),
    /** 记录入回收站（前端二次确认后调用） */
    journalDiscard: (id: number): Promise<boolean> => ipcRenderer.invoke('wenbi:journalDiscard', id),
    /** 文章列表（区内按 sort） */
    articleList: (): Promise<import('../src/shared/types').WenbiArticleRecord[]> =>
      ipcRenderer.invoke('wenbi:articleList'),
    /** 新建文章（返回 id；md 模板 `# 标题`） */
    articleCreate: (zone: string, title: string): Promise<number> =>
      ipcRenderer.invoke('wenbi:articleCreate', zone, title),
    /** 改标题（不动 updated_at） */
    articleRename: (id: number, title: string): Promise<boolean> =>
      ipcRenderer.invoke('wenbi:articleRename', id, title),
    /** 拖拽/菜单移动（bump updated_at） */
    articleMove: (id: number, zone: string, sort: number): Promise<boolean> =>
      ipcRenderer.invoke('wenbi:articleMove', id, zone, sort),
    /** 区内重排归一化（批量） */
    articleReorder: (moves: { id: number; zone: string; sort: number }[]): Promise<boolean> =>
      ipcRenderer.invoke('wenbi:articleReorder', moves),
    /** 编辑保存后触碰（bump updated_at） */
    articleTouch: (id: number): Promise<boolean> => ipcRenderer.invoke('wenbi:articleTouch', id),
    /** 文章入回收站（前端二次确认后调用） */
    articleDiscard: (id: number): Promise<boolean> => ipcRenderer.invoke('wenbi:articleDiscard', id),
    /** 导出 .md（保存对话框；取消返回 null） */
    articleExport: (id: number): Promise<string | null> => ipcRenderer.invoke('wenbi:articleExport', id),
    /** Copilot 协笔：起稿/续写/润色/改写，返回建议文本（不写库）；LLM 未配置抛 LLM_NOT_CONFIGURED */
    copilot: (
      jobId: string,
      id: number,
      action: 'draft' | 'continue' | 'polish' | 'rewrite',
      selection?: string
    ): Promise<string> => ipcRenderer.invoke('wenbi:copilot', jobId, id, action, selection)
  },
  books: {
    /** 书架列表（最近阅读在前） */
    list: (): Promise<import('../src/shared/types').BooksRecord[]> => ipcRenderer.invoke('books:list'),
    /** 系统对话框多选 epub/pdf（取消返回 []） */
    browse: (): Promise<string[]> => ipcRenderer.invoke('books:browse'),
    /** 导入（复制+解析元数据；duplicate 项由渲染层弹确认后携 force 重导） */
    import: (paths: string[], force?: boolean): Promise<import('../src/shared/types').BooksImportResult[]> =>
      ipcRenderer.invoke('books:import', paths, force),
    /** 书籍二进制（喂 epub.js / pdfjs 渲染引擎） */
    readFile: (id: number): Promise<Uint8Array> => ipcRenderer.invoke('books:readFile', id),
    /** 进度保存（渲染层节流 3 秒 + 退出阅读 flush） */
    saveProgress: (
      id: number,
      p: { cfi?: string | null; page?: number | null; percent: number }
    ): Promise<boolean> => ipcRenderer.invoke('books:saveProgress', id, p),
    /** 彻底删除（前端二次确认后调用，连物理文件与笔记） */
    delete: (id: number): Promise<boolean> => ipcRenderer.invoke('books:delete', id),
    /** 划词笔记列表（created_at 倒序，仅 epub 有数据） */
    notesList: (bookId: number): Promise<import('../src/shared/types').BooksNote[]> =>
      ipcRenderer.invoke('books:notesList', bookId),
    /** 新增笔记（note 缺省 '' = 纯高光） */
    noteAdd: (
      bookId: number,
      n: { cfiRange: string; quote: string; note?: string }
    ): Promise<import('../src/shared/types').BooksNote> => ipcRenderer.invoke('books:noteAdd', bookId, n),
    /** 编辑批注内容 */
    noteUpdate: (noteId: number, note: string): Promise<boolean> =>
      ipcRenderer.invoke('books:noteUpdate', noteId, note),
    /** 彻底删除单条笔记（前端二次确认后调用） */
    noteRemove: (noteId: number): Promise<boolean> => ipcRenderer.invoke('books:noteRemove', noteId)
  },
  feeds: {
    /** 源列表 + 未读数（首次幂等 seed 预置三源） */
    list: (): Promise<(import('../src/shared/types').FeedRecord & { unread: number })[]> =>
      ipcRenderer.invoke('feeds:list'),
    /** 并发拉全部源（逐源返回成败，单源失败不阻断） */
    fetchAll: (): Promise<import('../src/shared/types').FeedFetchResult[]> => ipcRenderer.invoke('feeds:fetchAll'),
    /** 验证订阅并取源名（失败抛带 message Error） */
    probe: (url: string): Promise<{ title: string; siteUrl: string }> => ipcRenderer.invoke('feeds:probe', url),
    /** 添加订阅（入库并立即拉一次） */
    add: (url: string): Promise<import('../src/shared/types').FeedRecord & { unread: number }> =>
      ipcRenderer.invoke('feeds:add', url),
    /** 改显示名（拉取永不覆盖） */
    rename: (id: number, title: string): Promise<boolean> => ipcRenderer.invoke('feeds:rename', id, title),
    /** 删源连文章（前端二次确认后调用，彻底删除） */
    remove: (id: number): Promise<boolean> => ipcRenderer.invoke('feeds:remove', id)
  },
  articles: {
    /** 文章列表（feedId=null 全部；view=unread 收件箱/archive 已归档；sinceDays 时间窗口；返回轻量行+窗口外剩余数） */
    list: (
      feedId: number | null,
      view: import('../src/shared/types').FeedView,
      sinceDays: number
    ): Promise<import('../src/shared/types').FeedListView> =>
      ipcRenderer.invoke('articles:list', feedId, view, sinceDays),
    /** 打开文章：标已读 + 懒抓正文 + 全量返回 */
    open: (id: number): Promise<import('../src/shared/types').ArticleRecord> => ipcRenderer.invoke('articles:open', id),
    /** 全部标已读（feedId=null 全部源） */
    markAllRead: (feedId: number | null): Promise<boolean> => ipcRenderer.invoke('articles:markAllRead', feedId),
    /** AI 总结（jobId 首参全局取消接线；有缓存秒回；LLM 未配置抛 LLM_NOT_CONFIGURED） */
    summarize: (jobId: string, id: number): Promise<string> => ipcRenderer.invoke('articles:summarize', jobId, id)
  },
  ledger: {
    /** 账户列表（含实时余额） */
    listAccounts: (): Promise<import('../src/shared/types').LedgerAccountView[]> =>
      ipcRenderer.invoke('ledger:accounts:list'),
    /** 新建/更新账户（名称 + 期初余额；重名抛带 message Error） */
    saveAccount: (
      id: number | null,
      name: string,
      initialBalanceCents: number
    ): Promise<boolean> => ipcRenderer.invoke('ledger:accounts:save', id, name, initialBalanceCents),
    /** 删账户（入回收站 + 级联软删名下流水；返回级联笔数） */
    removeAccount: (id: number): Promise<{ cascaded: number }> =>
      ipcRenderer.invoke('ledger:accounts:remove', id),
    /** 分类列表（未删全量，前端分组） */
    listCategories: (): Promise<import('../src/shared/types').LedgerCategory[]> =>
      ipcRenderer.invoke('ledger:categories:list'),
    /** 新建/更新分类（同 kind 查重） */
    saveCategory: (
      id: number | null,
      name: string,
      kind: 'expense' | 'income'
    ): Promise<boolean> => ipcRenderer.invoke('ledger:categories:save', id, name, kind),
    /** 删分类（在用流水断链为未分类；返回断链笔数） */
    removeCategory: (id: number): Promise<{ detached: number }> =>
      ipcRenderer.invoke('ledger:categories:remove', id),
    /** 流水列表（month='YYYY-MM'；categoryId 筛选） */
    listTx: (
      month: string,
      categoryId: number | null
    ): Promise<import('../src/shared/types').LedgerTxView[]> =>
      ipcRenderer.invoke('ledger:tx:list', month, categoryId),
    /** 新建/更新流水（校验失败抛带 message Error） */
    saveTx: (id: number | null, tx: import('../src/shared/types').LedgerTxInput): Promise<boolean> =>
      ipcRenderer.invoke('ledger:tx:save', id, tx),
    /** 删流水（入回收站） */
    removeTx: (id: number): Promise<boolean> => ipcRenderer.invoke('ledger:tx:remove', id),
    /** 月度统计：收支合计 + 支出分类排行 */
    stats: (month: string): Promise<import('../src/shared/types').LedgerStats> =>
      ipcRenderer.invoke('ledger:stats', month)
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
    test: (jobId: string, config: unknown): Promise<void> => ipcRenderer.invoke('llm:test', jobId, config),
    models: (config: unknown): Promise<string[]> => ipcRenderer.invoke('llm:models', config)
  },
  llmUsage: {
    /** AI 使用统计（260910）：range = today | month | all */
    stats: (range: 'today' | 'month' | 'all'): Promise<import('../src/shared/types').LlmUsageStats> =>
      ipcRenderer.invoke('llmUsage:stats', range),
    /** AI 实时活动（在途调用起止广播；空闲 items 为空数组） */
    onActivity: (cb: (payload: { items: { scene: string; configName: string }[] }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { items: { scene: string; configName: string }[] }): void => {
        cb(payload)
      }
      ipcRenderer.on('llm:activity', listener)
      return () => ipcRenderer.removeListener('llm:activity', listener)
    }
  },
  mcp: {
    listEnabled: (): Promise<{ name: string; url: string; enabled: boolean }[]> =>
      ipcRenderer.invoke('mcp:listEnabled'),
    /** AI 辅助配置：研究 MCP 配置元数据（Registry/文档/LLM 三步降级） */
    research: (jobId: string, name: string): Promise<import('../src/shared/types').McpResearch> =>
      ipcRenderer.invoke('mcp:research', jobId, name),
    /** 测试连接：initialize + tools/list，返回工具名列表 */
    test: (jobId: string, config: {
      name: string
      url: string
      authType?: 'none' | 'bearer'
      apiKey?: string
    }): Promise<{ tools: string[] }> => ipcRenderer.invoke('mcp:test', jobId, config)
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
