// 共享类型与常量（主进程 / 渲染进程共用）

// 模块标识
export type ModuleId =
  | 'mottos'
  | 'wiki'
  | 'inspirations'
  | 'verify'
  | 'zhijiji'
  | 'reasoning'
  | 'recycle'
  | 'profile'

// AI 边栏频道（DB v9：ai_sessions.channel；致知己 specs §4，存量会话归 assistant）
export type AiChannel = 'assistant' | 'motto' | 'wiki' | 'zhijiji' | 'verify'

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
  Theme: 'theme',
  LlmConfigs: 'llm_configs',
  LlmDefaultId: 'llm_default_id',
  McpConfigs: 'mcp_configs',
  McpEnabled: 'mcp_enabled',
  MottoSchedule: 'motto_schedule',
  LastMottoRun: 'last_motto_run',
  AiActiveSessionId: 'ai_active_session_id',
  // 频道制（DB v9）：当前所在频道 + 各频道独立激活会话（assistant 沿用 AiActiveSessionId）
  AiActiveChannel: 'ai_active_channel',
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
  DraftActiveTurtle: 'draft_active_turtle'
} as const

export type Theme = 'light' | 'dark'

// LLM 配置（存 settings.llm_configs，JSON 数组）
export interface LlmConfig {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
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
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface WikiHighlight {
  id: number
  entry_id: number
  text: string
  created_at: string
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
  item_id: number
  payload: string
  created_at: string
}

// 致知己问题（zhijiji_questions，DB v9；列表行聚合版本数）
export interface ZhijijiQuestion {
  id: number
  title: string
  /** 领域标签（JSON 列解析而来） */
  tags: string[]
  version_count: number
  created_at: string
  updated_at: string
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
