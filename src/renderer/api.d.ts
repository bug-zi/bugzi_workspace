// 渲染层全局 window.api 类型（preload 桥）
export type ModuleId =
  | 'mottos'
  | 'wiki'
  | 'inspirations'
  | 'verify'
  | 'zhijiji'
  | 'reasoning'
  | 'wenbi'
  | 'bookshelf'
  | 'feed'
  | 'ledger'
  | 'recycle'
  | 'profile'

/** AI 边栏频道（DB v9 频道制） */
export type AiChannel = 'assistant' | 'motto' | 'wiki' | 'zhijiji' | 'verify'

/** 草稿本频道（DB v14）：固定两频道起步 */
export type DraftChannel = 'general' | 'turtle'

/** 草稿本条目（drafts 表；正文在 md_path 指向的真实 .md 文件） */
export interface DraftRow {
  id: number
  title: string
  channel: DraftChannel
  md_path: string
  created_at: string
  updated_at: string
}

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

/** 浮生记条目（wenbi_journals 表，文笔坊 specs §1）：无标题，时间线行=创建日期+首行摘要；正文在 md_path 的真实 .md 文件 */
export interface WenbiJournalRecord {
  id: number
  md_path: string
  /** 大事件标记（1=是）：置顶小节聚合展示 */
  is_event: 0 | 1
  created_at: string
  updated_at: string
  deleted_at: string | null
}

/** 书架书籍（books 表，DB v19）：文件在 books/<id>.<ext>、封面在 covers/（bzres://root/ 加载）；删除为物理删除不入回收站 */
export interface BooksRecord {
  id: number
  title: string
  author: string
  format: 'epub' | 'pdf'
  /** 相对 userData 路径 books/<id>.<ext> */
  file_path: string
  /** 相对 userData 路径 covers/<id>.<ext>；NULL=无封面（书名占位卡） */
  cover_path: string | null
  file_size: number
  /** epub 进度：epub.js CFI 定位（精确恢复） */
  progress_cfi: string | null
  /** pdf 进度：当前页码（1 基） */
  progress_page: number | null
  /** 0-100 百分比（书架卡片角标） */
  progress_percent: number
  added_at: string
  /** NULL=从未读过（排序用） */
  last_read_at: string | null
}

/** 书架导入结果：duplicate 由前端弹确认后 force 重导 */
export type BooksImportResult =
  | { path: string; status: 'imported'; book: BooksRecord }
  | { path: string; status: 'duplicate'; title: string }
  | { path: string; status: 'failed'; error: string }

/** 书架划词笔记（book_notes 表，DB v24）：note 空 = 纯高光；仅 epub */
export interface BooksNote {
  id: number
  book_id: number
  /** epub.js CFI 区间定位（划词范围） */
  cfi_range: string
  /** 划选原文摘录 */
  quote: string
  /** 批注内容；空字符串 = 纯高光 */
  note: string
  created_at: string
}

/** 信息源源（feeds 表，DB v20）：fetch_error 空=上次拉取成功 */
export interface FeedRecord {
  id: number
  title: string
  feed_url: string
  site_url: string
  last_fetched_at: string | null
  fetch_error: string | null
  created_at: string
}

/** 信息源文章全量（打开阅读视图用，含正文与总结缓存） */
export interface ArticleRecord {
  id: number
  feed_id: number
  guid: string
  title: string
  url: string
  author: string
  published_at: string | null
  fetched_at: string
  content_feed_html: string | null
  content_fetched_html: string | null
  read_at: string | null
  summary_text: string | null
  summary_at: string | null
}

/** 信息源文章列表轻量行（不含正文大字段） */
export interface ArticleSummary {
  id: number
  feed_id: number
  title: string
  url: string
  author: string
  published_at: string | null
  fetched_at: string
  read_at: string | null
  has_summary: boolean
  preview: string
}

/** 文章列表视图（优化建议区第28轮）：unread=收件箱（只显未读，读完即消失）；archive=已归档（已读按时间翻） */
export type FeedView = 'unread' | 'archive'

/** 文章列表返回体（优化建议区第28轮）：窗口内轻量行 + 窗口外剩余计数（「加载更早」按钮展示） */
export interface FeedListView {
  articles: ArticleSummary[]
  /** 同条件（视图 + 源筛选）去时间窗口的 COUNT——窗口外还有多少篇可加载 */
  remaining: number
}

/** 拉取结果（fetchAll 逐源返回；单源失败不阻断） */
export interface FeedFetchResult {
  feedId: number
  ok: boolean
  error?: string
  added: number
}

// ===== 账本（DB v21）=====

/** 账户（含实时余额） */
export interface LedgerAccountView {
  id: number
  name: string
  /** 期初余额（分） */
  initial_balance_cents: number
  sort: number
  created_at: string
  /** 当前余额（分）= 期初 + 未删收支滚存 */
  balance_cents: number
}

/** 分类 */
export interface LedgerCategory {
  id: number
  name: string
  kind: 'expense' | 'income'
  sort: number
  created_at: string
}

/** 流水保存入参 */
export interface LedgerTxInput {
  date: string
  type: 'expense' | 'income'
  amountCents: number
  categoryId: number | null
  accountId: number
  note: string
}

/** 流水列表行（显示名联表，断链为「未分类」由查询侧兜底） */
export interface LedgerTxView {
  id: number
  date: string
  type: 'expense' | 'income'
  amount_cents: number
  category_id: number | null
  account_id: number
  note: string
  created_at: string
  category_name: string | null
  account_name: string | null
}

/** 月度统计 */
export interface LedgerStats {
  incomeCents: number
  expenseCents: number
  breakdown: { categoryId: number | null; name: string; cents: number; pct: number }[]
}

/** 写作台文章（wenbi_articles 表，文笔坊 specs §1）：zone 四区流转 */
export interface WenbiArticleRecord {
  id: number
  title: string
  zone: 'idea' | 'writing' | 'done' | 'published'
  md_path: string
  /** 区内排序（拖拽顺序） */
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
  source:
    | 'mottos'
    | 'wiki'
    | 'inspirations'
    | 'verify'
    | 'zhijiji'
    | 'reasoning_soup'
    | 'reasoning_game'
    | 'drafts'
    | 'wenbi_journal'
    | 'wenbi_article'
    | 'ledger_tx'
    | 'ledger_account'
    | 'ledger_category'
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

// ===== 推理角（DB v12） =====

/** 汤库列表行（不含汤面/汤底/裁判解析——开局后才见汤面） */
export interface TurtleSoupRow {
  id: number
  title: string
  difficulty: 'easy' | 'medium' | 'hard'
  theme_tag: string
  /** fresh=未玩 | playing=进行中 | solved=已破 | abandoned=弃汤（终态不可再开局） */
  status: 'fresh' | 'playing' | 'solved' | 'abandoned'
  created_at: string
}

/** 对局问答消息（逐条即时落库 = 中断续玩/多局并行的根基） */
export interface TurtleGameMessageRow {
  id: number
  role: 'user' | 'assistant' | 'system'
  type: 'question' | 'answer' | 'invalid' | 'guess' | 'verdict' | 'notice'
  content: string
  created_at: string
}

/** 对局视图载荷（openSoup / game 返回；进行中不暴露汤底） */
export interface TurtleGamePayload {
  gameId: number
  title: string
  surface: string
  difficulty: string
  theme: string
  status: 'playing' | 'solved' | 'abandoned'
  questionCount: number
  startedAt: string
  messages: TurtleGameMessageRow[]
  /** 仅 playing 有值：净用时计时种子（v18 计时主进程记账） */
  activeMs?: number
  /** 仅终局回看时有值：汤底 / 复盘 md 相对路径（懒生成，可能为 null）/ 对局净用时 */
  bottom?: string
  mdPath?: string | null
  durationMs?: number | null
}

/** 对局记录列表行（终局局，ended_at 倒序） */
export interface TurtleGameRecordRow {
  id: number
  title: string
  status: 'solved' | 'abandoned'
  question_count: number
  started_at: string
  ended_at: string
  duration_ms: number | null
  /** 复盘 md 相对路径（懒生成，未看过的局为 null——「复盘待生成」标记依据） */
  md_path: string | null
  difficulty: string
}

/** 思维墙今日题载荷（ensureToday 返回） */
export interface WallTodayInfo {
  phase: 'answering' | 'done'
  puzzleId: number
  date: string
  puzzle: string
  puzzleType: string
  typeZh: string
  difficulty: string
  diffZh: string
  status: 'answering' | 'correct' | 'wrong'
  hintsUsed: number
  hintsTotal: number
  myAnswer: string | null
  mdPath: string | null
}

/** 打卡墙月历日格（有记录的天） */
export interface WallDayCell {
  date: string
  status: 'correct' | 'wrong'
  hintsUsed: number
  difficulty: string
  mdPath: string | null
}

/** 打卡墙月份数据（wall.month 返回） */
export interface WallMonthInfo {
  streak: number
  correct: number
  wrong: number
  days: WallDayCell[]
}

/** 练习场当前题（wall.practiceNew 返回；会话级主进程内存暂存，不入库不写 md） */
export interface WallPracticeInfo {
  id: number
  puzzle: string
  typeZh: string
  diffZh: string
  hintsTotal: number
}

/** 精选题库列表行（wall.bankList 返回；不泄答案与标准论证） */
export interface WallBankRow {
  id: number
  title: string
  tag: string
  difficulty: string
  diffZh: string
  source: string
  status: 'todo' | 'solved' | 'failed'
  mdPath: string | null
}

/** 精选题库单题（wall.bankOpen 返回；不泄答案与标准论证） */
export interface WallBankInfo {
  id: number
  title: string
  tag: string
  difficulty: string
  diffZh: string
  puzzle: string
  status: 'todo' | 'solved' | 'failed'
  myAnswer: string | null
  mdPath: string | null
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
      table:
        | 'mottos'
        | 'wiki_entries'
        | 'inspirations'
        | 'verify_records'
        | 'zhijiji_questions'
        | 'turtle_soups'
        | 'turtle_games',
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
      jobId: string,
      message: string,
      currentModule: string,
      sessionId: number,
      channel?: AiChannel
    ): Promise<{ id: number; role: string; content: string }>
    configured(): Promise<boolean>
    /** 取消进行中的 AI 任务（false = 任务已结束，静默即可） */
    cancel(jobId: string): Promise<boolean>
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
    compact(jobId: string, sessionId: number): Promise<AiSessionRow>
    /** /clear：清空该会话全部消息（会话保留，上下文与存储一并清零） */
    clear(sessionId: number): Promise<boolean>
  }
  zhijiji: {
    list(): Promise<ZhijijiQuestion[]>
    /** 新问题：默认建空白 v1（直开编辑态）；aiInit=true 时 LLM 先生成初始参考答案（v0），失败抛错不创建 */
    createQuestion(
      jobId: string,
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
  turtle: {
    /** 「来 3 碗汤」：难度偏好可选（默认随机），三件套（汤面/汤底/裁判解析）入库汤库 */
    generate(
      jobId: string,
      preference?: 'random' | 'easy' | 'medium' | 'hard'
    ): Promise<{ generated: number; inserted: number }>
    listSoups(difficulty?: string): Promise<TurtleSoupRow[]>
    /** 开局/续局：fresh 建新局、playing 返回现有局；终态汤抛 SOUP_FINISHED */
    openSoup(soupId: number): Promise<TurtleGamePayload>
    game(gameId: number): Promise<TurtleGamePayload>
    /** 提问 → 裁判只答「是/否/与汤无关」；invalid=非判断句引导（不计有效问答） */
    ask(
      jobId: string,
      gameId: number,
      question: string
    ): Promise<{
      type: 'yes' | 'no' | 'irrelevant' | 'invalid'
      reply: string
      questionCount: number
    }>
    /** 猜汤底：未破给方向反馈（不泄露关键缺失）；破汤终局链（净用时结算，不生成报告）后返回汤底 */
    guess(
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
    }>
    /** 放弃（前端二次确认后调用）：秒回汤底（净用时结算，报告点「查看复盘」时生成） */
    abandon(jobId: string, gameId: number): Promise<{ bottom: string; durationMs: number }>
    /** 净用时记账（边界事件）：start=开段（幂等） / pause=结算当前段 */
    timerStart(gameId: number): Promise<boolean>
    timerPause(gameId: number): Promise<boolean>
    /** 复盘报告 ensure：已有 md 直接返回路径，无则现场生成（含 AI 点评，可取消/失败可重试） */
    report(jobId: string, gameId: number): Promise<string>
    /** 汤入回收站（进行中的汤抛 PLAYING，前端不提供入口） */
    discardSoup(soupId: number): Promise<boolean>
    /** 对局记录入回收站（仅终局局） */
    discardGame(gameId: number): Promise<boolean>
    /** 终局局列表（ended_at 倒序） */
    listGames(): Promise<TurtleGameRecordRow[]>
  }
  wall: {
    /** 打开现出：无当日题则现场生成（LLM 未配置抛 LLM_NOT_CONFIGURED → 弹去配置） */
    ensureToday(jobId: string): Promise<WallTodayInfo>
    /** 提交作答：宽松等价判对错 + 完整推理链讲解 + 写详情 md；答错即终局 */
    answer(
      jobId: string,
      puzzleId: number,
      myAnswer: string
    ): Promise<{ correct: boolean; standardAnswer: string; explanation: string; mdPath: string }>
    /** 取下一级提示（库存直取不调 LLM，最多 3 级）；用尽返回 null */
    hint(puzzleId: number): Promise<{ level: number; text: string } | null>
    /** 月历数据：连胜 + 当月对/错计数 + 各日格态 */
    month(year: number, month: number): Promise<WallMonthInfo>
    /** 当日详情 md 路径（无记录 null） */
    recordPath(date: string): Promise<string | null>
    /** 练习场：随时出一道（pref 随机/简单/中等/困难，单次有效；typePref 题型可选 v1.6 四类；不计入墙与连胜） */
    practiceNew(
      jobId: string,
      pref: 'random' | 'easy' | 'medium' | 'hard',
      typePref?: 'random' | 'detective_case' | 'lateral_puzzle' | 'word_logic' | 'life_logic'
    ): Promise<WallPracticeInfo>
    /** 练习场判答：宽松等价 + 完整讲解（无 md 落盘；一题一命，判答即终局；失效抛 PRACTICE_GONE） */
    practiceAnswer(
      jobId: string,
      practiceId: number,
      myAnswer: string
    ): Promise<{ correct: boolean; standardAnswer: string; explanation: string }>
    /** 练习场取下一级提示（内存直取不调 LLM）；用尽或题已失效返回 null */
    practiceHint(practiceId: number): Promise<{ level: number; text: string } | null>
    /** 精选题库：列表（不泄答案与论证） */
    bankList(): Promise<WallBankRow[]>
    /** 精选题库：打开一题（不泄答案与论证） */
    bankOpen(bankId: number): Promise<WallBankInfo>
    /** 精选题库：提交作答（终态；判答 + 写详情 md；已答抛 ALREADY_ANSWERED） */
    bankAnswer(
      jobId: string,
      bankId: number,
      myAnswer: string
    ): Promise<{ correct: boolean; standardAnswer: string; explanation: string; mdPath: string }>
    /** 精选题库：看解答（终态，不判答直接揭示 + 写详情 md） */
    bankReveal(bankId: number): Promise<{ standardAnswer: string; solution: string; mdPath: string }>
  }
  profile: {
    list(): Promise<ProfileFactRow[]>
    /** source: manual（手填，默认）| ai（对话中提炼经确认入档） */
    add(category: string, content: string, source?: 'manual' | 'ai'): Promise<number>
    update(id: number, category: string, content: string): Promise<boolean>
    delete(id: number): Promise<boolean>
  }
  draft: {
    /** 某频道草稿列表（updated_at 倒序） */
    list(channel?: DraftChannel): Promise<DraftRow[]>
    /** 新建草稿（海龟汤联动预填标题与正文模板），返回新草稿 id */
    create(channel: DraftChannel, title?: string | null, content?: string | null): Promise<number>
    /** 改标题（不动 updated_at，列表顺序稳定） */
    rename(id: number, title: string): Promise<boolean>
    /** 保存正文（md.write + 触碰 updated_at 浮回列表顶部） */
    save(id: number, content: string): Promise<boolean>
    /** 大窗编辑（MdDialog 自行保存）后的触碰：只 bump updated_at */
    touch(id: number): Promise<boolean>
    /** 草稿入回收站（前端二次确认后调用） */
    discard(id: number): Promise<boolean>
  }
  wenbi: {
    /** 浮生记条目列表（created_at 倒序；零 AI 板块） */
    journalList(): Promise<WenbiJournalRecord[]>
    /** 新建一条记录（返回整行，渲染层据 created_at 拼日期标题并 autoEdit） */
    journalCreate(): Promise<WenbiJournalRecord>
    /** 大事件标记切换 */
    journalSetEvent(id: number, isEvent: boolean): Promise<boolean>
    /** 记录入回收站（前端二次确认后调用） */
    journalDiscard(id: number): Promise<boolean>
    /** 文章列表（区内按 sort） */
    articleList(): Promise<WenbiArticleRecord[]>
    /** 新建文章（返回 id；md 模板 `# 标题`） */
    articleCreate(zone: string, title: string): Promise<number>
    /** 改标题（不动 updated_at） */
    articleRename(id: number, title: string): Promise<boolean>
    /** 拖拽/菜单移动（bump updated_at） */
    articleMove(id: number, zone: string, sort: number): Promise<boolean>
    /** 区内重排归一化（批量） */
    articleReorder(moves: { id: number; zone: string; sort: number }[]): Promise<boolean>
    /** 编辑保存后触碰（bump updated_at） */
    articleTouch(id: number): Promise<boolean>
    /** 文章入回收站（前端二次确认后调用） */
    articleDiscard(id: number): Promise<boolean>
    /** 导出 .md（保存对话框；取消返回 null） */
    articleExport(id: number): Promise<string | null>
    /** Copilot 协笔：起稿/续写/润色/改写，返回建议文本（不写库）；LLM 未配置抛 LLM_NOT_CONFIGURED */
    copilot(
      jobId: string,
      id: number,
      action: 'draft' | 'continue' | 'polish' | 'rewrite',
      selection?: string
    ): Promise<string>
  }
  books: {
    /** 书架列表（最近阅读在前） */
    list(): Promise<BooksRecord[]>
    /** 系统对话框多选 epub/pdf（取消返回 []） */
    browse(): Promise<string[]>
    /** 导入（复制+解析元数据；duplicate 项由前端弹确认后携 force 重导） */
    import(paths: string[], force?: boolean): Promise<BooksImportResult[]>
    /** 书籍二进制（喂 epub.js / pdfjs 渲染引擎） */
    readFile(id: number): Promise<Uint8Array>
    /** 进度保存（前端节流 3 秒 + 退出阅读 flush） */
    saveProgress(id: number, p: { cfi?: string | null; page?: number | null; percent: number }): Promise<boolean>
    /** 彻底删除（前端二次确认后调用，连物理文件与笔记） */
    delete(id: number): Promise<boolean>
    /** 划词笔记列表（created_at 倒序，仅 epub 有数据） */
    notesList(bookId: number): Promise<BooksNote[]>
    /** 新增笔记（note 缺省 '' = 纯高光） */
    noteAdd(bookId: number, n: { cfiRange: string; quote: string; note?: string }): Promise<BooksNote>
    /** 编辑批注内容 */
    noteUpdate(noteId: number, note: string): Promise<boolean>
    /** 彻底删除单条笔记（前端二次确认后调用） */
    noteRemove(noteId: number): Promise<boolean>
  }
  feeds: {
    /** 源列表 + 未读数（首次幂等 seed 预置三源） */
    list(): Promise<(FeedRecord & { unread: number })[]>
    /** 并发拉全部源（逐源返回成败，单源失败不阻断） */
    fetchAll(): Promise<FeedFetchResult[]>
    /** 验证订阅并取源名（失败抛带 message Error） */
    probe(url: string): Promise<{ title: string; siteUrl: string }>
    /** 添加订阅（入库并立即拉一次） */
    add(url: string): Promise<FeedRecord & { unread: number }>
    /** 改显示名（拉取永不覆盖） */
    rename(id: number, title: string): Promise<boolean>
    /** 删源连文章（前端二次确认后调用，彻底删除） */
    remove(id: number): Promise<boolean>
  }
  articles: {
    /** 文章列表（feedId=null 全部；view=unread 收件箱/archive 已归档；sinceDays 时间窗口；返回轻量行+窗口外剩余数） */
    list(feedId: number | null, view: FeedView, sinceDays: number): Promise<FeedListView>
    /** 打开文章：标已读 + 懒抓正文 + 全量返回 */
    open(id: number): Promise<ArticleRecord>
    /** 全部标已读（feedId=null 全部源） */
    markAllRead(feedId: number | null): Promise<boolean>
    /** AI 总结（jobId 首参全局取消接线；有缓存秒回；LLM 未配置抛 LLM_NOT_CONFIGURED） */
    summarize(jobId: string, id: number): Promise<string>
  }
  ledger: {
    /** 账户列表（含实时余额） */
    listAccounts(): Promise<LedgerAccountView[]>
    /** 新建/更新账户（名称 + 期初余额；重名抛带 message Error） */
    saveAccount(id: number | null, name: string, initialBalanceCents: number): Promise<boolean>
    /** 删账户（入回收站 + 级联软删名下流水；返回级联笔数） */
    removeAccount(id: number): Promise<{ cascaded: number }>
    /** 分类列表（未删全量，前端分支出/收入两组） */
    listCategories(): Promise<LedgerCategory[]>
    /** 新建/更新分类（同 kind 查重） */
    saveCategory(id: number | null, name: string, kind: 'expense' | 'income'): Promise<boolean>
    /** 删分类（在用流水断链为未分类；返回断链笔数） */
    removeCategory(id: number): Promise<{ detached: number }>
    /** 流水列表（month='YYYY-MM'；categoryId 筛选占比条下钻） */
    listTx(month: string, categoryId: number | null): Promise<LedgerTxView[]>
    /** 新建/更新流水（校验失败抛带 message Error） */
    saveTx(id: number | null, tx: LedgerTxInput): Promise<boolean>
    /** 删流水（入回收站） */
    removeTx(id: number): Promise<boolean>
    /** 月度统计：收支合计 + 支出分类排行 */
    stats(month: string): Promise<LedgerStats>
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
    generate(jobId: string): Promise<{
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
      jobId: string,
      term: string | null,
      sectionId: number | null
    ): Promise<
      { ok: true; data: { entryId: number; term: string; summary: string } } | { ok: false; conflict: string }
    >
    /** 随机词条名（指定板块用板块，未指定随机挑；只构思词条名不生成卡片） */
    suggestTerm(jobId: string, sectionId: number | null): Promise<string>
    /** 测一测：随机 5 张卡片各出 1 道四选一 */
    quiz(jobId: string): Promise<WikiQuizQuestion[]>
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
    /** 「来5条灵感」：两阶段生成（发散 12 → 配额自评 5）入草稿区；winds 为本批风向（specs §6.2 + 优化建议区任务2） */
    generate(jobId: string): Promise<{ generated: number; inserted: number; winds: string[] }>
    /** AI 完善：生成扩展建议 md（不写库），预览确认后走 appendRefine */
    refine(jobId: string, id: number): Promise<string>
    /** 确认追加：以「## AI 补充 · 时间」段追加到该条 md 末尾 */
    appendRefine(id: number, content: string): Promise<boolean>
  }
  verify: {
    list(): Promise<VerifyRecord[]>
    get(id: number): Promise<VerifyRecord>
    findDuplicate(claim: string): Promise<{ id: number; claim: string; created_at: string } | null>
    run(jobId: string, claim: string): Promise<{ recordId: number; credibility: number }>
    discard(id: number): Promise<boolean>
  }
  llm: {
    test(jobId: string, config: LlmConfig): Promise<void>
    models(config: LlmConfig): Promise<string[]>
  }
  mcp: {
    listEnabled(): Promise<{ name: string; url: string; enabled: boolean }[]>
    /** AI 辅助配置：研究 MCP 配置元数据（Registry/文档/LLM 三步降级） */
    research(jobId: string, name: string): Promise<McpResearch>
    /** 测试连接：initialize + tools/list，返回工具名列表 */
    test(jobId: string, config: {
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
