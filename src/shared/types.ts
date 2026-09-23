// 共享类型与常量（主进程 / 渲染进程共用）

// 模块标识（260924 侧边栏新布局：新增 'favorites' 收藏夹 / 'literature' 论文库 / 'answers' 答疑店 三个拆分模块；
// 另加占位 id 'podcast' 播客台 / 'fuben' 副本库 / 'fushi' 赋诗苑 / 'yule' 娱乐城——仅左栏占位，无对应视图。
// 历史备注：260908 'verify' 并入万象库；260911 'mottos' 并入文笔坊；260912 合并为 'zangyue'、新增 'zonglan'）
export type ModuleId =
  | 'zonglan'
  | 'learn'
  | 'wiki'
  | 'inspirations'
  | 'zhijiji'
  | 'reasoning'
  | 'wenbi'
  | 'zangyue'
  | 'feed'
  | 'ledger'
  | 'recycle'
  | 'profile'
  | 'favorites'
  | 'literature'
  | 'answers'
  | 'podcast'
  | 'fuben'
  | 'fushi'
  | 'yule'

// 模块深链导航事件 detail（260912 总导览）：App.tsx MODULE_NAVIGATE_EVENT 的载荷，
// 目标模块经 useModuleNavigate 监听后按 target 切内部视图
export interface ModuleNavDetail {
  module: ModuleId
  target: string
  payload?: Record<string, unknown>
}

// AI 边栏频道（DB v9：ai_sessions.channel；致知己 specs §4，存量会话归 assistant；2.0 批次C 增 literature）
export type AiChannel = 'assistant' | 'motto' | 'wiki' | 'zhijiji' | 'verify' | 'learn' | 'prophet' | 'literature'

// 学习/生活双模式（优化建议区 260922）：左栏两套入口视图 + 总导览随模式换块；
// 模式归属见 App.tsx MODULES[].mode（常驻/学习/生活）
export type ModuleMode = 'learn' | 'life'

// 草稿本频道（优化建议区第21轮，DB v14：drafts.channel）：固定两频道起步，加频道零迁移
export type DraftChannel = 'general' | 'turtle'

// AI 助手名字（优化建议区：起名 debugzi，与用户 bugzi 配对）：主进程 prompt 与渲染层文案共用
export const AI_NAME = 'debugzi'

// 海龟汤对局视图进出事件（优化建议区第21轮，草稿本联动）：TurtlePanel 派发、App 接住传 DraftSidebar；
// detail 为 { title, surface }（进入对局）或 null（退出）
export const TURTLE_GAME_EVENT = 'bugzi:turtle-game'

// settings 表 key 常量
export const SettingsKeys = {
  UserName: 'user_name',
  UserAvatar: 'user_avatar',
  UserBio: 'user_bio',
  FontSize: 'font_size',
  FontFamily: 'font_family',
  FontWeight: 'font_weight',
  /** 信息源阅读视图 Ctrl+滚轮缩放百分比（80-200，全局一档；260916 新功能开发区） */
  FeedZoom: 'feed_reader_zoom',
  /** 信息源 rsshub:// 路由默认展开实例（优化建议区第46轮反馈修订：rsshub.app 官方限制 feed 阅读器访问，实例须可换） */
  FeedRsshubBase: 'feed_rsshub_base',
  Theme: 'theme',
  LlmConfigs: 'llm_configs',
  LlmDefaultId: 'llm_default_id',
  McpConfigs: 'mcp_configs',
  McpEnabled: 'mcp_enabled',
  MottoSchedule: 'motto_schedule',
  LastMottoRun: 'last_motto_run',
  AiActiveSessionId: 'ai_active_session_id',
  // 频道制（DB v9）：各场景独立激活会话（assistant 沿用 AiActiveSessionId）。
  // 统一会话流（优化建议区第48轮）：新增全局键=边栏当前会话（启动恢复「最后聊过的会话」）；
  // per-channel 键保留，服务模块动作场景定位与弹窗拓展坞。原 AiActiveChannel 键废弃删除（DB 旧行无害留存）。
  AiActiveSessionGlobal: 'ai_active_session_global',
  AiActiveSessionMotto: 'ai_active_session_motto',
  AiActiveSessionWiki: 'ai_active_session_wiki',
  AiActiveSessionZhijiji: 'ai_active_session_zhijiji',
  AiActiveSessionVerify: 'ai_active_session_verify',
  AiWidth: 'ai_width',
  // 致知己弹窗内嵌追问栏（优化建议区第14轮）：宽度与收起态
  ZjPanelWidth: 'zj_panel_width',
  ZjPanelCollapsed: 'zj_panel_collapsed',
  // 灵感方向指引（优化建议区第18轮）：JSON { pos, neg }，AI 生成灵感时置顶注入
  InspirationGuide: 'inspiration_guide',
  // 草稿本（优化建议区第21轮）：右缘面板互斥展开态 + 宽度 + 当前频道与各频道激活草稿
  RightPanelExpanded: 'right_panel_expanded',
  DraftWidth: 'draft_width',
  DraftActiveChannel: 'draft_active_channel',
  DraftActiveGeneral: 'draft_active_general',
  DraftActiveTurtle: 'draft_active_turtle',
  // 白噪音（260908 立项）：当前混音状态 + 自定义混音列表（均 JSON 字符串；重启记参数默认暂停）
  NoiseState: 'noise_state',
  NoiseCustomMixes: 'noise_custom_mixes',
  // 白噪音隐藏名单（260921 冒烟反馈轮）：JSON { scenes, builtinTriggers, factoryMixes }——删除场景/内置触发音/出厂混音行
  NoiseHidden: 'noise_hidden',
  // 白噪音播放队列（260911 播放队列轮）：JSON { items, mode }；运行态不持久化，重启默认暂停从头开始
  NoisePlayQueue: 'noise_play_queue',
  // 画布（新功能开发区 260909）：右缘第三面板宽度 + 当前激活画布
  CanvasWidth: 'canvas_width',
  CanvasActiveId: 'canvas_active_id',
  // 资源管理器（260916 新功能开发区）：上次文件夹 + 上次文件 + 面板宽度
  FilesRootPath: 'explorer_root_path',
  FilesLastFile: 'explorer_last_file',
  FilesWidth: 'explorer_width',
  // 书架优化第1轮（260908）：阅读模式（滚动/翻页）全局记忆
  BooksReadingMode: 'books_reading_mode',
  // 内置终端（260912 新功能开发区）：JSON { shell, cwd, height }
  Terminal: 'terminal',
  // 藏书架阅读背景（260911 新功能开发区）：背景偏好 JSON + 自定义图文件名（存 userData/bg/，bzres://bg/ 加载）
  BooksReadingBg: 'books_reading_bg',
  ReaderBgImage: 'reader_bg_image',
  // 万象库待学习区（260910）：每日批次最近执行日（本地日期 YYYY-MM-DD，幂等标记）
  WikiDailyLearnDate: 'wiki_daily_learn_date',
  // 我是谁（260921 新功能开发区）：每日问题批次最近生成日（本地日期 YYYY-MM-DD，幂等标记）
  WhoamiDailyDate: 'whoami_daily_date',
  // 学习库（260911）：「学习·问答」频道激活会话
  AiActiveSessionLearn: 'ai_active_session_learn',
  AiActiveSessionProphet: 'ai_active_session_prophet',
  // 学习库卡片弹窗问 AI 拓展坞（优化建议区第42轮）：宽度与收起态
  LearnAskPanelWidth: 'learn_ask_panel_width',
  LearnAskPanelCollapsed: 'learn_ask_panel_collapsed',
  // 启动行为（260912）：开机自启（'1'/'0'）+ 关闭按钮行为（'tray' 隐藏到托盘 | 'exit' 直接退出）
  LaunchOnBoot: 'launch_on_boot',
  CloseAction: 'close_action',
  // 学习/生活双模式（优化建议区 260922）：当前模式（'learn'|'life'，缺省 learn）+ 各模式 last 专属模块（MainView 字符串，常驻不记）
  AppMode: 'app_mode',
  ModeLastLearn: 'mode_last_learn',
  ModeLastLife: 'mode_last_life',
  // 音乐吧（260915 新功能开发区）：轻音乐播放状态 JSON { trackId, loopMode, volume }（重启记参数默认暂停）
  MusicState: 'music_state',
  // ---------- 超级工作台 2.0（批次 A，idea/超级工作台2.0/designs-specs-批次A §2） ----------
  /** 引擎总开关（'1'/'0'，默认关；冷启动向导批次 C 完成后置 '1'） */
  AgentEnabled: 'agent_enabled',
  /** 冷启动向导已完成标记（'1'；空 = 未走向导） */
  AgentColdStartDone: 'agent_cold_start_done',
  /** 负载卫兵：CPU 暂停阈值 %（默认 80）与恢复阈值 %（迟滞，默认 50） */
  AgentCpuPause: 'agent_cpu_pause',
  AgentCpuResume: 'agent_cpu_resume',
  /** 每日 token 软上限（'0'=不限）；超限暂停搜集类任务，按需任务不受限 */
  AgentDailyBudget: 'agent_daily_budget',
  /** 隐私白名单（默认全关）：后台任务可参考画像/学习记录 */
  AgentPrivacyProfile: 'agent_privacy_profile',
  AgentPrivacyLearn: 'agent_privacy_learn',
  /** Embedding 配置 JSON EmbeddingConfig（Ollama bge-m3） */
  EmbeddingConfig: 'embedding_config',
  /** 「文献·追问」场景激活会话（批次 C 消费，键先行占位） */
  AiActiveSessionLiterature: 'ai_active_session_literature'
} as const

// 内置终端（260912）：shell 三选 + 默认工作目录 + 面板高度（settings JSON 键 terminal）
export type TerminalShell = 'powershell' | 'pwsh' | 'cmd'
export interface TerminalSettings {
  shell: TerminalShell
  cwd: string
  height: number
}
export const TERMINAL_DEFAULTS: TerminalSettings = {
  shell: 'powershell',
  cwd: 'D:\\Code\\myapp\\bugzi_workspace',
  height: 380
}

// 音乐吧轻音乐（260915 新功能开发区）
export type MusicLoopMode = 'list-loop' | 'single-loop' | 'random'

export interface MusicPlaylistRow {
  id: number
  name: string
  created_at: string
}

export interface MusicTrackRow {
  id: number
  title: string
  /** 相对 userData 的路径 music/<id>.mp3 */
  file_path: string
  /** 懒获取：首次播放读 audio.duration 回写；NULL 显示 --:-- */
  duration_sec: number | null
  /** NULL=未分组 */
  playlist_id: number | null
  added_at: string
}

/** music:import 返回汇总 */
export interface MusicImportSummary {
  imported: number
  skipped: number
  failed: number
}

/** music:list 返回 */
export interface MusicListResult {
  playlists: MusicPlaylistRow[]
  tracks: MusicTrackRow[]
}

// 触发音（260921 新功能开发区；DB v49 trigger_sounds）
export interface TriggerSoundRow {
  id: number
  name: string
  /** 相对 userData 的路径 triggers/<id>.<ext> */
  file_path: string
  created_at: string
}

/** trigger:import 返回汇总 */
export interface TriggerImportSummary {
  imported: number
  skipped: number
  failed: number
}

/** 从 settings 原始 JSON 解析终端配置（坏数据/缺字段逐项回落默认） */
export function parseTerminalSettings(raw: string | null | undefined): TerminalSettings {
  const d = TERMINAL_DEFAULTS
  if (!raw) return { ...d }
  try {
    const o = JSON.parse(raw) as Partial<TerminalSettings>
    return {
      shell: o.shell === 'pwsh' || o.shell === 'cmd' ? o.shell : 'powershell',
      cwd: typeof o.cwd === 'string' && o.cwd ? o.cwd : d.cwd,
      height: typeof o.height === 'number' && o.height >= 200 ? o.height : d.height
    }
  } catch {
    return { ...d }
  }
}

export type Theme = 'light' | 'dark'

// LLM 配置（存 settings.llm_configs，JSON 数组）
export interface LlmConfig {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  /** 模型池溢出路由并发上限（260910）：>0 生效，缺省 = 不限（永不溢出，行为同旧版） */
  maxConcurrent?: number
}

// ---------- LLM 使用统计（260910 推理角效率优化配套） ----------

/** llmUsage:stats 单场景聚合行 */
export interface LlmUsageSceneRow {
  scene: string
  calls: number
  failures: number
  avgMs: number
  tokens: number
  /** 存在估算 token 的行数（>0 时统计页 token 列带 ≈ 标记） */
  estRows: number
}

/** llmUsage:stats 返回 */
export interface LlmUsageStats {
  totals: { calls: number; failures: number; tokens: number }
  rows: LlmUsageSceneRow[]
}

/** llmUsage:records 单条调用明细（UI 滚动展示最近 30 条；库内全量保留不清理） */
export interface LlmUsageRecord {
  id: number
  createdAt: string
  scene: string
  configName: string
  model: string
  ok: boolean
  durationMs: number
  promptTokens: number
  completionTokens: number
  tokensEstimated: boolean
  errorBrief: string | null
}

/** LLM 场景中文标签（统计页与活动指示共用；未收录的 scene 直接显示原串）。
 *  260910 修订：推理角场景前缀按板块区分（海龟汤/思维墙），不再统一「推理角·」——
 *  用量页能直接看出是哪边在生成（开发者指令）。 */
export const LLM_SCENE_LABELS: Record<string, string> = {
  'reasoning:wall-compose': '思维墙·出题',
  'reasoning:wall-review': '思维墙·审题',
  'reasoning:wall-judge': '思维墙·判答',
  'reasoning:soup-compose': '海龟汤·出题',
  'reasoning:soup-review': '海龟汤·审题',
  'reasoning:soup-ask': '海龟汤·判问',
  'reasoning:soup-guess': '海龟汤·判汤底',
  'reasoning:soup-report': '海龟汤·复盘',
  'reasoning:soup-backfill': '海龟汤·诡计回填',
  'ai:chat': 'debugzi·对话',
  'ai:compact': 'AI·上下文压缩',
  'motto:generate': '格言库·生成',
  'wiki:card': '万象库·知识卡',
  'wiki:suggest': '万象库·词条构思',
  'wiki:quiz': '万象库·测一测',
  'learn:tree': '学习库·建树',
  'learn:card': '学习库·知识卡',
  'learn:expand': '学习库·主题展开',
  'learn:quiz': '学习库·小测出卷',
  'learn:quizGrade': '学习库·小测批改',
  'learn:task': '学习库·实战任务',
  'learn:taskReview': '学习库·作业点评',
  'inspiration:diverge': '灵感泉·发散',
  'inspiration:refine': '灵感泉·自评',
  'verify:check': '万象库·辩真核查',
  'zhijiji:v0': '致知己·AI 初始化',
  'wenbi:copilot': '文笔坊·协笔',
  'feed:summary': '信息源·总结',
  'mcp:research': 'MCP·配置研究',
  'whoami:daily': '我是谁·每日出题',
  'whoami:extract': '我是谁·候选提炼',
  'whoami:askOne': '我是谁·来一问',
  'agent:collect': '工作台·海选',
  'agent:digest': '工作台·导读卡',
  'agent:lecture': '工作台·精讲',
  'agent:translate': '工作台·精译',
  other: '其他'
}

/** AI 实时活动项（llm:activity 广播，260912 AI 面板扩展）：一条在途 LLM 调用 */
export interface LlmActivityItem {
  seq: number
  scene: string
  configName: string
  /** 起始时刻（Date.now() 毫秒，面板算已运行时长） */
  startedAt: number
  /** 关联任务 id（有则可经 ai:cancel 取消）；未传 signal 的调用为 null = 面板不可取消 */
  jobId: string | null
}

// MCP 配置（存 settings.mcp_configs，JSON 数组）
export interface McpConfig {
  id: string
  name: string
  url: string
  kind: 'http' // v1 仅 http 传输
  enabled: boolean
  /** 鉴权方式（可选，缺省 none；bearer 时请求带 Authorization 头，问题疑惑区 MCP 方案） */
  authType?: 'none' | 'bearer'
  /** bearer 鉴权的 API Key（本地单机存 settings JSON） */
  apiKey?: string
}

/** AI 辅助 MCP 配置：需填写的密钥信息（研究结果展示） */
export interface McpResearchKey {
  /** 密钥字段名（如 TAVILY_API_KEY） */
  name: string
  /** 用途说明 */
  description: string
  /** 申请入口链接 */
  applyUrl: string
}

/** AI 辅助 MCP 配置：研究结果（mcp:research 返回） */
export interface McpResearch {
  title: string
  description: string
  /** 远程端点模板；含 {apiKey} 占位符时用用户填写的 key 替换后存储 */
  urlTemplate: string
  /** 保存时的鉴权方式：bearer 需 apiKey 字段；none 表示 key 已拼进 URL 或无需鉴权 */
  authType: 'none' | 'bearer'
  /** 需要的密钥列表（无鉴权为空数组） */
  keys: McpResearchKey[]
  /** 配置文档链接 */
  docsUrl: string
  /** 结论来源：registry=官方 Registry API / docs=厂商文档 / llm=模型自有知识 */
  source: 'registry' | 'docs' | 'llm'
  /** 研究过程说明（中文，展示给用户） */
  notes: string
}

// AI 边栏会话（ai_sessions 表，DB v4；channel 自 DB v9）
export interface AiSession {
  id: number
  title: string
  /** 所属频道（DB v9；存量会话为 assistant） */
  channel: AiChannel
  created_at: string
  updated_at: string
}

// AI 边栏消息（ai_messages 表）
export interface AiMessage {
  id: number
  /** 所属会话（DB v4 起必填） */
  session_id: number
  role: 'user' | 'assistant' | 'system'
  ai_module: string | null
  content: string
  created_at: string
}

// 草稿本条目（drafts 表，DB v14；正文在 md_path 指向的真实 .md 文件）
export interface Draft {
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
  /** 熟练度：该词条题目被「答对 2 次毕业」移除的累计次数（DB v41） */
  quiz_graduated: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

/** 测一测题库题（wiki:quizDraw 返回）：题面 + 记账句柄 + 来源词条熟练度 */
export interface WikiQuizBankQuestion {
  /** 题库行 id（wiki:quizRecord 记账用） */
  bankId: number
  /** 来源词条 id */
  entryId: number
  /** 来源词条名 */
  term: string
  question: string
  options: string[]
  /** 正确选项下标 0..3 */
  answer: number
  /** 题目解析（提交后无论对错都展示） */
  explanation: string
  /** 来源词条熟练度（毕业移除累计次数，>0 时展示「测毕 N」胶囊） */
  graduated: number
}

export interface WikiHighlight {
  id: number
  entry_id: number
  text: string
  created_at: string
}

// ===== 学习库（DB v33，学习库 specs）：知识树 领域→主题→知识点；卡片 md 在 md/learn/<id>.md =====

/** 领域（learn_domains 表）；tree_ready=0 为懒建树态（出厂 seed，首次打开时显式生成骨架） */
export interface LearnDomain {
  id: number
  name: string
  sort: number
  tree_ready: 0 | 1
  created_at: string
  /** 知识点总数（learn:domains 联查聚合，非表列） */
  total: number
  /** 已学知识点数（联查聚合） */
  learned: number
  /** 主题数（联查聚合；删除确认弹窗展示级联范围用） */
  topics: number
  /** 回收站在站知识点数（联查聚合；删除确认弹窗展示级联范围用） */
  points_deleted: number
}

/** 树节点（learn_nodes 表；level 1=主题 2=知识点，主题无 summary/state 语义） */
export interface LearnNode {
  id: number
  domain_id: number
  parent_id: number | null
  level: 1 | 2
  title: string
  summary: string
  state: 'todo' | 'learned'
  /** 0=未学 1..4=复习四档 5=毕业（next_review_at 为 NULL，不再出现） */
  review_stage: number
  next_review_at: string | null
  /** 学会时刻（本地时间 ISO；NULL=未学。每日要求「今日已学」判定依据） */
  learned_at: string | null
  content_ready: 0 | 1
  source: 'ai' | 'manual'
  deleted_at: string | null
  created_at: string
}

/** 知识树视图（learn:tree 返回）：主题行聚合进度 + 其知识点行 */
export interface LearnTopicView {
  id: number
  title: string
  total: number
  learned: number
  /** 回收站在站知识点数（删除确认弹窗展示级联范围用） */
  points_deleted: number
  points: LearnNode[]
}

/** 卡片行（learn:getCard / learn:randomOne / learn:nodeAdd 返回）：知识点 + 领域/主题名（弹窗 titleTag 用） */
export interface LearnCardRow extends LearnNode {
  domain_name: string
  topic_title: string | null
}

/** 今日队列行（learn:daily 返回；learn:daily 已随面经题库化摘除，行类型保留供删除确认等复用） */
export interface LearnDailyRow extends LearnNode {
  domain_name: string
  topic_title: string | null
}

// ===== 学习库·面经题库（260924 面经题库化，interview_* 表 DB v52）=====
export interface InterviewCategory {
  id: number
  name: string
  sort: number
}

export interface InterviewQuestionRow {
  id: number
  category_id: number
  category_name: string
  question: string
  answer_path: string
  source: string
  state: 'todo' | 'learned'
  review_stage: number
  next_review_at: string | null
  learned_at: string | null
  created_at: string
}

export interface InterviewIntakeRow {
  id: number
  category_id: number | null
  category_name: string | null
  question: string
  answer_path: string
  source: string
  batch_id: number
  created_at: string
}

/** 面经每日要求汇总（interview:daily 返回）：learned/review 行即 InterviewQuestionRow 全列
 *  （interviewSql 投影 q.*），刷题列表点击直接开弹窗无需二次取行 */
export interface InterviewDailySummary {
  learned: InterviewQuestionRow[]
  review: InterviewQuestionRow[]
  goal: number
  /** 0=未完成 1=已完成（learn_daily.done，显式落库） */
  done: number
  streak: number
  /** 题库 todo 存量（渲染层阈值提醒用） */
  todoTotal: number
}

/** 小测题（learn_quiz.questions JSON 数组元素；题型混合由 AI 按卡内容定）。
 *  answering 态经 IPC 下发前隐去 answerIndex/acceptable/answer/analysis（防抄答案）。 */
export interface LearnQuizQuestion {
  nodeId: number
  /** 联节点标题（quizGet 注入，展示用） */
  nodeTitle?: string
  type: 'choice' | 'blank' | 'short'
  /** 题面 md（MdView 渲染，推理角题面同款） */
  question: string
  /** choice 专用：选项文本数组（下标即选项号，不含字母前缀） */
  options?: string[]
  /** choice 专用：正确选项下标 */
  answerIndex?: number
  /** blank 专用：可接受答案数组（归一化比对） */
  acceptable?: string[]
  /** 参考答案（short 批改参考；graded 后展示） */
  answer: string
  /** 解析（graded 后展示） */
  analysis: string
}

/** 小测作答行（learn_quiz.answers JSON 数组元素；作答实时存库） */
export interface LearnQuizAnswer {
  qIndex: number
  answer: string
  /** choice/blank 本地判；short 交卷 AI 批改前为 null */
  correct: boolean | null
  /** short 批改点评 */
  aiComment?: string
}

/** 小测卷（learn:quizGet / quizCreate / quizRetry 返回） */
export interface LearnQuizView {
  date: string
  status: 'answering' | 'graded'
  questions: LearnQuizQuestion[]
  answers: LearnQuizAnswer[]
}

/** 实战任务行（learn:taskList / taskGenerate / taskSubmit 返回；md 路径供渲染层读文件） */
export interface LearnTaskRow {
  id: number
  topic_id: number
  domain_id: number
  status: 'todo' | 'submitted' | 'reviewed'
  /** 点评分 0-100（reviewed 后有值） */
  score: number | null
  topic_title: string
  task_md: string
  homework_md: string | null
  review_md: string | null
  created_at: string
  submitted_at: string | null
}

/** 高光行（learn:highlights 返回，联表知识点标题） */
export interface LearnHighlightRow {
  id: number
  node_id: number
  text: string
  created_at: string
  title: string
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

/** 经验书条目（wenbi_experiences 表，DB v44；v46 起带分类与夹内排序）：一句话经验道理，无标题无 md 正文；删除走回收站 wenbi_exp */
export interface WenbiExperienceRecord {
  id: number
  content: string
  /** 分类（NULL=未分类；DB v46） */
  category_id: number | null
  /** 夹内排序（越小越靠前；DB v46） */
  sort: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

/** 经验书分类（exp_categories 表，DB v46） */
export interface ExpCategoryRecord {
  id: number
  name: string
  sort: number
  created_at: string
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

/** 万象库知识问答（qa_records，DB v37；单轮问答存档，展示一律读 md 快照） */
export interface QaRecord {
  id: number
  question: string
  answer: string
  md_path: string
  created_at: string
  deleted_at: string | null
}

/** 藏书架阅读背景偏好（260911 新功能开发区）：全局一份，存 settings books_reading_bg（JSON 串） */
export interface BooksReadingBg {
  /** theme=跟随主题（默认现状）/ color=纯色预设 / image=自定义图片 */
  kind: 'theme' | 'color' | 'image'
  /** kind=color 时的预设色值 */
  color?: string
  /** 正文字色（dark=深色字 / light=浅色字）：color 模式为预设配对值，image 模式为上传时亮度采样值 */
  textColor?: 'dark' | 'light'
}

/** 书架书籍（books 表，书架 specs §1）：文件在 books/<id>.<ext>、封面在 covers/（bzres://root/ 加载）；删除为物理删除不入回收站 */
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
  /** 书级阅读模式（书架 v2.0 §四）；NULL=跟随全局默认（settings books_reading_mode） */
  reading_mode: 'scroll' | 'page' | null
  /** epub 字号倍率 0.75~1.5（书架 v2.0 §四）；NULL=跟随个人档全局字体大小 */
  font_scale: number | null
  /** epub 书级字体族 CSS 串（字体选择轮 §1.2）；NULL=跟随个人档全局字体 */
  font_family: string | null
  /** 归属文件夹（260916 图书馆升级 §三，DB v42）；NULL = 未分组 */
  folder_id: number | null
}

/** 书架文件夹（260916 图书馆升级 §三，DB v42）：单层，不嵌套 */
export interface BookFolder {
  id: number
  name: string
  sort: number
  created_at: string
}

/** BookFolder + 夹内书数（folderList 返回行） */
export type BookFolderCount = BookFolder & { count: number }

/** 书架导入结果（书架 specs §2.1）：duplicate 由渲染层弹确认后 force 重导 */
export type BooksImportResult =
  | { path: string; status: 'imported'; book: BooksRecord }
  | { path: string; status: 'duplicate'; title: string }
  | { path: string; status: 'failed'; error: string }

/** 书架划词笔记（book_notes 表，书架优化第1轮 §8.5）：note 空 = 纯高光；仅 epub（pdf 无文本层） */
export interface BooksNote {
  id: number
  book_id: number
  /** epub.js CFI 区间定位（划词范围） */
  cfi_range: string
  /** 划选原文摘录（截断约 500 字） */
  quote: string
  /** 批注内容；空字符串 = 纯高光 */
  note: string
  created_at: string
}

/** 书架手动书签（book_marks 表，书架 v2.0 §二 + 书签优化轮）：epub 存 cfi、pdf 存 page（1 基）；label 默认「章节名 · 位置」可手动改 */
export interface BookMark {
  id: number
  book_id: number
  /** epub 定位（epub 行非空） */
  cfi: string | null
  /** pdf 页码（1 基；pdf 行非空） */
  page: number | null
  /** 显示名（默认「章节名 · 42%」/「章节名 · 第 N 页」，用户可改） */
  label: string
  /** 备注；空字符串 = 无备注 */
  note: string
  created_at: string
}

/** 书架阅读统计每书行（书架 v2.0 §五） */
export interface ReadStatsRow {
  id: number
  title: string
  /** 全书累计阅读秒数 */
  totalSeconds: number
  /** 0-100 */
  percent: number
  last_read_at: string | null
}

/** 书架阅读统计聚合（书架 v2.0 §五）：todaySeconds 当地当日秒和；streakDays 连续天数（今天无记录从昨天起算）；readingCount 读过且未读完 */
export interface ReadStats {
  todaySeconds: number
  streakDays: number
  readingCount: number
  /** 读过的书（最近阅读在前；v2.0 前读过的书 totalSeconds 为 0） */
  rows: ReadStatsRow[]
}

/** 收藏夹分类（fav_categories 表，收藏夹 specs §1）：parent_id NULL=大类，两级约束由服务层保证 */
export interface FavoriteCategory {
  id: number
  parent_id: number | null
  name: string
  sort: number
  /** 1 = 「未分类」锁定大类：禁删/改名/排序，固定末位 */
  is_system: boolean
  created_at: string
}

/** 收藏夹条目（fav_items 表）：纯链接收藏，简介为 md 文本（存 DB 非 md 文件） */
export interface FavoriteItem {
  id: number
  category_id: number
  name: string
  url: string
  desc_md: string
  pinned: boolean
  created_at: string
  updated_at: string
}

/** favorites:list 返回体：分类 + 条目全量（个人收藏百级量级，不分页） */
export interface FavoriteList {
  categories: FavoriteCategory[]
  items: FavoriteItem[]
}

/** favorites:updateItem 局部更新补丁（任一可选；服务层每次回写 updated_at） */
export interface FavoriteItemPatch {
  name?: string
  url?: string
  desc_md?: string
  pinned?: boolean
  category_id?: number
}

/** 信息源源（feeds 表，信息源 specs §1）：fetch_error 空=上次拉取成功 */
export interface FeedRecord {
  id: number
  title: string
  feed_url: string
  site_url: string
  last_fetched_at: string | null
  fetch_error: string | null
  created_at: string
}

/** 导入字体条目（优化建议区第46轮，userData/fonts/ 文件系统为真相源）：
 *  file=落盘唯一名；label=导入时原始文件名去扩展名（sanitize 后），兼作 CSS family 名 */
export interface CustomFontInfo {
  file: string
  label: string
  family: string
  url: string
}

/** 信息源文章全量（articles 表；打开阅读视图用，含正文与总结缓存） */
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
  favorited_at: string | null
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
  /** 已收藏（260911 收藏页/星标实心态） */
  favorited: boolean
  /** 已有 AI 总结缓存（列表可显小标） */
  has_summary: boolean
  /** 正文剥标签预览（前 120 字） */
  preview: string
}

/** 文章列表视图（260911 扩三值）：unread=收件箱（未读）；archive=已归档（已读按时间翻）；favorite=收藏（收藏时间倒序全量、不筛源） */
export type FeedView = 'unread' | 'archive' | 'favorite'

/** 文章列表返回体（优化建议区第28轮）：窗口内轻量行 + 窗口外剩余计数（「加载更早」按钮展示） */
export interface FeedListView {
  articles: ArticleSummary[]
  /** 同条件（视图 + 源筛选）去时间窗口的 COUNT——窗口外还有多少篇可加载 */
  remaining: number
}

/** 拉取结果（feeds:fetchAll 逐源返回；单源失败不阻断） */
export interface FeedFetchResult {
  feedId: number
  ok: boolean
  error?: string
  /** 本次新入库篇数 */
  added: number
}

// ===== 账本（DB v21，账本 specs §1）：金额一律存「分」，余额实时聚合 =====

/** 账户（ledger_accounts 表；balanceCents 为实时聚合结果不落库） */
export interface LedgerAccountView {
  id: number
  name: string
  /** 期初余额（分），存量资金一次性录入 */
  initial_balance_cents: number
  sort: number
  created_at: string
  /** 当前余额（分）= 期初 + 未删收支滚存 */
  balance_cents: number
}

/** 分类（ledger_categories 表） */
export interface LedgerCategory {
  id: number
  name: string
  kind: 'expense' | 'income'
  sort: number
  created_at: string
}

/** 流水保存入参（ledger:tx:save） */
export interface LedgerTxInput {
  date: string
  type: 'expense' | 'income'
  amountCents: number
  categoryId: number | null
  accountId: number
  note: string
}

/** 流水列表行（ledger:tx:list；显示名联表，断链为「未分类」） */
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

/** 月度统计（ledger:stats）：收支合计 + 支出分类排行 */
export interface LedgerStats {
  incomeCents: number
  expenseCents: number
  breakdown: { categoryId: number | null; name: string; cents: number; pct: number }[]
}

export interface RecycleItem {
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
    | 'wenbi_exp'
    | 'ledger_tx'
    | 'ledger_account'
    | 'ledger_category'
    | 'learn'
    | 'prophet'
    | 'twelve_question'
    | 'qa'
  item_id: number
  payload: string
  created_at: string
}

// 致知己问题（zhijiji_questions，DB v9；列表行聚合版本数；DB v38 起带分级三列）
export interface ZhijijiQuestion {
  id: number
  title: string
  /** 领域标签（JSON 列解析而来） */
  tags: string[]
  /** 来源（260912 分级）：manual 手动 / ai AI 生成 */
  origin: 'manual' | 'ai'
  /** 星级 1-5（四维标准 AI 初评，用户可改；NULL = 未评） */
  stars: number | null
  /** AI 评星评语（一句，悬停可见；手动改星不清除） */
  star_note: string | null
  version_count: number
  created_at: string
  updated_at: string
}

/** AI 出题候选（260912：出题带星一体，采纳才入库标 ai） */
export interface ZhijijiQuestionCandidate {
  title: string
  stars: number
  note: string
}

// 致知己答案版本（zhijiji_versions，DB v9；标识 v{seq}-{date}）
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

// 预言家判断（用户三选一；可改判覆盖）
export type ProphetJudgment = 'reasonable' | 'unreasonable' | 'uncertain'

// 预言条目（prophet_records，DB v36；分析说明 md 快照在 analysis_md_path）
export interface ProphetRecord {
  id: number
  claim: string
  /** 创建时的补充说明（正文快照在 md，此处为初版存档） */
  note: string
  status: 'open' | 'judged'
  judgment: ProphetJudgment | null
  judgment_note: string
  judged_at: string | null
  analysis_md_path: string | null
  created_at: string
  updated_at: string
}

// 十二问题（twelve_questions，DB v36；列表行聚合想法数与最近想法时间）
export interface TwelveQuestion {
  id: number
  title: string
  ord: number
  thought_count: number
  last_thought_at: string | null
  created_at: string
  updated_at: string
}

// 十二问题想法（twelve_thoughts，DB v36；碎片存 SQLite，不落 md）
export interface TwelveThought {
  id: number
  question_id: number
  content: string
  created_at: string
}

// 我的画像条目（profile_facts，DB v9；注入全部 AI 上下文）
export interface ProfileFact {
  id: number
  category: string
  content: string
  /** manual=个人中心手填 | ai=对话中提炼经确认入档 */
  source: 'manual' | 'ai'
  created_at: string
  updated_at: string
}

// 统一 IPC 错误形态：invoke 拒绝时 message 为 ErrCode 描述映射后的文案或原始信息
export const ErrCode = {
  LlmNotConfigured: 'LLM_NOT_CONFIGURED',
  McpNotEnabled: 'MCP_NOT_ENABLED',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT'
} as const

// ---------- 应用更新（个人档「版本与更新」，260913） ----------

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'disabled'

/** 更新状态快照（主进程全内存；app:updateState 返回值 / app:updateEvent 推送载荷） */
export interface UpdateSnapshot {
  currentVersion: string
  phase: UpdatePhase
  /** available/downloaded 态的新版本号 */
  availableVersion: string | null
  /** 新版本发布时间（ISO 串，UI slice(0,10) 显日期） */
  releaseDate: string | null
  /** downloading 态 0-100 */
  percent: number
  /** 一次性提示文案（仅启动静默检查发现新版时置一次；渲染层 toast 用） */
  notice: string | null
}

export interface UpdateCheckResult {
  status: 'up-to-date' | 'available' | 'error' | 'disabled'
  version?: string
  releaseDate?: string
}

// ===== 总导览每日挑战 + 热力图（260916 新功能开发区；preload 与 api.d.ts 共用）=====
export interface ChallengePoolRow {
  id: number
  content: string
  created_at: string
}
export interface ChallengeDailyView {
  date: string
  challengeId: number
  /** 池条目已删为 null（前端显示「（已删除的挑战）」） */
  content: string | null
  done: boolean
}
export interface ChallengeDailyResult {
  daily: ChallengeDailyView | null
  poolCount: number
}
export interface HeatmapDay {
  date: string
  learn: boolean
  wall: boolean
  challenge: boolean
  /** 完成件数 0-3（四档颜色） */
  level: number
}

// 我是谁（whoami_questions，DB v47；个人档·我的画像之下）
export interface WhoamiQuestionView {
  id: number
  /** 批次日期 YYYY-MM-DD */
  date: string
  question: string
  /** NULL = 未答 */
  answer: string | null
  skipped: boolean
  answeredAt: string | null
  /** 提炼的候选画像条目（未提炼/提炼失败为空数组） */
  suggestions: { category: string; content: string }[]
  /** 候选已处理完（含提炼出零条的） */
  resolved: boolean
}
export interface WhoamiGetResult {
  /** 当日批次（只查当日，跨天自然作废） */
  today: WhoamiQuestionView[]
  /** 往日已答但候选未处理完的（保留到处理完才消失） */
  pending: WhoamiQuestionView[]
}

// 画像类别预设十类（个人档 datalist、我是谁候选提炼校验与候选编辑下拉三处共用；260923 收敛为单一来源）
export const PROFILE_CATEGORIES = [
  '基本档案', '性格特质', '擅长能力', '兴趣爱好', '生活方式', '社交出行',
  '学习与技能', '职业规划', '价值观', '其他'
]

// ===== 超级工作台 2.0（idea/超级工作台2.0/designs-specs-批次A §2；DB v48 七表）=====

/** 领域两档深度：deep=职业发展（深读线论文）/ science=兴趣拓展（科普线文章，二期管道） */
export type AgentTrack = 'deep' | 'science'

/** 引擎相位：idle=待命 working=任务进行中 paused=负载暂停（呼吸灯/任务中心共用） */
export type AgentPhase = 'idle' | 'working' | 'paused'

/** 领域配置（agent_domains 表；keywords 为 JSON 列解析后的数组） */
export interface AgentDomainRow {
  id: number
  name: string
  track: AgentTrack
  keywords: string[]
  enabled: boolean
  last_scan_at: string | null
  created_at: string
  updated_at: string
}

/** 发现箱条目（discover_items 表）：AI 海选元信息，人工终选前不进正式区 */
export interface DiscoverItemRow {
  id: number
  source_type: 'paper' | 'article'
  title: string
  authors: string[]
  year: number | null
  /** 发布日期 YYYY-MM-DD（渠道原始值精确到日；NULL 回落 year 展示） */
  date: string | null
  summary: string
  tags: string[]
  language: string
  length_est: string
  url: string
  /** 渠道标识：'arxiv' / 'mcp:{配置名}' */
  source: string
  /** AI 一句话推荐理由 */
  reason: string
  status: 'discovered' | 'accepted' | 'rejected'
  domain_id: number | null
  created_at: string
}

/** 正式文献（papers 表）：终选转正后入库 */
export interface PaperRow {
  id: number
  title: string
  authors: string[]
  year: number | null
  /** 发布日期 YYYY-MM-DD（同 discover_items；NULL 回落 year） */
  date: string | null
  summary: string
  tags: string[]
  language: string
  url: string
  source: string
  /** ready=全文缓存可用 meta_only=仅元信息（抓取失败，可手动传 PDF 兜底） */
  status: 'ready' | 'meta_only'
  /** userData 相对路径（.txt 全文缓存或原始 .pdf） */
  fulltext_path: string | null
  /** 导读卡 md 路径 */
  digest_md: string | null
  /** 精译术语表 JSON */
  glossary: string | null
  discovery_id: number | null
  created_at: string
  updated_at: string
}

/** 解读产物登记（interpretations 表）：导读卡/精讲/精译/书籍解读的台账 */
export interface InterpretationRow {
  id: number
  owner_type: 'paper' | 'science_article' | 'book'
  owner_id: number
  kind: 'digest' | 'lecture' | 'translation' | 'light' | 'book_digest'
  status: 'running' | 'done' | 'failed'
  md_path: string | null
  tokens_used: number
  created_at: string
  updated_at: string
}

/** 科普文章概念关联（science_articles.concepts JSON 项）：entry_id 命中词条 / null 待建词条 */
export interface ScienceConcept {
  term: string
  entry_id: number | null
}

/** 科普文章（science_articles 表）：发现箱 article 条目转正入库 */
export interface ScienceArticleRow {
  id: number
  title: string
  authors: string[]
  year: number | null
  /** 发布日期 YYYY-MM-DD（渠道原始值；NULL 回落 year 展示） */
  date: string | null
  summary: string
  tags: string[]
  language: 'en' | 'zh'
  url: string
  /** 渠道标识：'mcp:{配置名}' 等 */
  source: string
  domain_id: number | null
  /** 联表 agent_domains.name（详情列表展示用） */
  domain_name: string | null
  status: 'ready' | 'meta_only'
  fulltext_path: string | null
  /** 英文全文解读术语表（JSON 解析后；null=无） */
  glossary: { en: string; zh: string }[] | null
  concepts: ScienceConcept[]
  discovery_id: number | null
  created_at: string
  updated_at: string
}

/** 科普划词高光（science_highlights 表） */
export interface ScienceHighlightRow {
  id: number
  article_id: number
  text: string
  created_at: string
}

/** 任务台账行（task_runs 表）：负载卫兵的 load_pause/load_resume 也记于此 */
export interface TaskRunRow {
  id: number
  task_type: string
  trigger: 'scheduled' | 'manual' | 'auto'
  status: 'running' | 'done' | 'failed' | 'skipped'
  ref_id: number | null
  started_at: string
  finished_at: string | null
  tokens_used: number
  error: string | null
}

/** 引擎状态快照（agent:statusGet 返回 / agent:status 推送载荷） */
export interface AgentStatusSnapshot {
  phase: AgentPhase
  /** paused 时的原因文案 */
  pauseReason: string | null
  /** 最近一次采样 CPU 占用 %（未出首帧为 0） */
  cpu: number
  memFreeBytes: number
  memTotalBytes: number
  /** 今日 agent 场景 token 消耗 */
  budgetUsedToday: number
  /** 在跑任务类型列表 */
  runningTypes: string[]
  /** 最近一次队列事件（enqueued=入队 done/failed/skipped=终态；渲染层增量刷新依据） */
  lastEvent: { type: string; status: string } | null
}

/** agent:dayStats 返回体（任务中心/总导览聚合块） */
export interface AgentDayStats {
  enabled: boolean
  phase: AgentPhase
  pauseReason: string | null
  runningTypes: string[]
  pendingDiscover: number
  budgetToday: number
  /** 按任务类型的当日/昨日 done 计数 */
  today: Record<string, number>
  yesterday: Record<string, number>
  generatedAt: string
}

/** Embedding 配置（settings embedding_config JSON；读时逐字段兜底合并） */
export interface EmbeddingConfig {
  enabled: boolean
  baseUrl: string
  model: string
  /** ollama.exe 路径（「一键拉起」spawn serve 用） */
  ollamaPath: string
}

/** agent:configGet 返回体 */
export interface AgentConfigView {
  enabled: boolean
  cpuPause: number
  cpuResume: number
  budget: number
  privacyProfile: boolean
  privacyLearn: boolean
  embedding: EmbeddingConfig
}
