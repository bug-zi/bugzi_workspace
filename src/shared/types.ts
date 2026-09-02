// 共享类型与常量（主进程 / 渲染进程共用）

// 模块标识
export type ModuleId = 'mottos' | 'wiki' | 'inspirations' | 'verify' | 'recycle' | 'profile'

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
  LastMottoRun: 'last_motto_run'
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

// AI 边栏消息（ai_messages 表）
export interface AiMessage {
  id: number
  role: 'user' | 'assistant' | 'system'
  ai_module: string | null
  content: string
  created_at: string
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
  source: 'mottos' | 'wiki' | 'inspirations' | 'verify'
  item_id: number
  payload: string
  created_at: string
}

// 统一 IPC 错误形态：invoke 拒绝时 message 为 ErrCode 描述映射后的文案或原始信息
export const ErrCode = {
  LlmNotConfigured: 'LLM_NOT_CONFIGURED',
  McpNotEnabled: 'MCP_NOT_ENABLED',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT'
} as const
