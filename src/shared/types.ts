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
