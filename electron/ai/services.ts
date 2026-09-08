// AI 业务服务（主进程）：格言生成、知识卡片生成、AI 边栏对话、辩真验证
import { getDb, nowIso, normalizeText, isDupMotto } from '../db/db'
import { getSetting, setSetting, getJsonSetting } from '../db/settings'
import { chatCompletion, LlmNotConfiguredError } from './llm'
import { ensureNotCancelled } from './jobs'
import { mdRead, mdWrite, mdCreate } from '../services/files'
import { AI_NAME, SettingsKeys } from '../../src/shared/types'
import type { AiChannel, AiMessage, AiSession, LlmConfig } from '../../src/shared/types'

// ---------- AI 边栏（样式 specs §4；多会话：优化建议区「对话记录管理」） ----------

/** 会话默认标题（自动命名/手动改名前的初始值） */
const DEFAULT_SESSION_TITLE = '新对话'

/** 自动命名取消息前 N 字 */
const AUTO_TITLE_LEN = 20

/** 各频道激活会话的 settings key（assistant 沿用既有 key，其余频道各自独立；DB v9 频道制） */
const ACTIVE_SESSION_KEYS: Record<AiChannel, string> = {
  assistant: SettingsKeys.AiActiveSessionId,
  motto: SettingsKeys.AiActiveSessionMotto,
  wiki: SettingsKeys.AiActiveSessionWiki,
  zhijiji: SettingsKeys.AiActiveSessionZhijiji,
  verify: SettingsKeys.AiActiveSessionVerify
}

/** 会话列表（最近活跃在前，按频道隔离） */
export function listAiSessions(channel: AiChannel = 'assistant'): AiSession[] {
  return getDb()
    .prepare('SELECT * FROM ai_sessions WHERE channel = ? ORDER BY updated_at DESC, id DESC')
    .all(channel) as unknown as AiSession[]
}

/** 指定频道的激活会话 id（对应 settings key；无或非法 → null） */
export function getActiveSessionId(channel: AiChannel = 'assistant'): number | null {
  const v = getSetting(ACTIVE_SESSION_KEYS[channel] ?? SettingsKeys.AiActiveSessionId)
  const id = v ? Number(v) : NaN
  return Number.isInteger(id) && id > 0 ? id : null
}

/** 设置某频道的激活会话（渲染层切换/新建时经 settings:set 落库；null 清除） */
export function setActiveSessionId(id: number | null, channel: AiChannel = 'assistant'): void {
  setSetting(ACTIVE_SESSION_KEYS[channel] ?? SettingsKeys.AiActiveSessionId, id == null ? '' : String(id))
}

export function createAiSession(
  title: string = DEFAULT_SESSION_TITLE,
  channel: AiChannel = 'assistant'
): AiSession {
  const now = nowIso()
  const r = getDb()
    .prepare('INSERT INTO ai_sessions (title, channel, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(title, channel, now, now)
  return { id: Number(r.lastInsertRowid), title, channel, created_at: now, updated_at: now }
}

export function renameAiSession(id: number, title: string): void {
  const t = title.trim().slice(0, 50) || DEFAULT_SESSION_TITLE
  getDb().prepare('UPDATE ai_sessions SET title = ? WHERE id = ?').run(t, id)
}

/** 删除会话（连同其全部消息）；若删的是该频道激活会话 → 同频道内自动切到剩余最近活跃，无剩余则清除激活 */
export function deleteAiSession(id: number, channel: AiChannel = 'assistant'): void {
  const d = getDb()
  // 先删消息再删会话（FK 约束下顺序即安全，无需显式事务）
  d.prepare('DELETE FROM ai_messages WHERE session_id = ?').run(id)
  d.prepare('DELETE FROM ai_sessions WHERE id = ?').run(id)
  if (getActiveSessionId(channel) === id) {
    const next = d
      .prepare('SELECT id FROM ai_sessions WHERE channel = ? ORDER BY updated_at DESC, id DESC LIMIT 1')
      .get(channel) as { id: number } | undefined
    setActiveSessionId(next ? next.id : null, channel)
  }
}

export function listAiMessages(sessionId: number): AiMessage[] {
  return getDb()
    .prepare('SELECT * FROM ai_messages WHERE session_id = ? ORDER BY id ASC')
    .all(sessionId) as unknown as AiMessage[]
}

export function deleteAiMessage(id: number): void {
  getDb().prepare('DELETE FROM ai_messages WHERE id = ?').run(id)
}

/** 改写消息内容（渲染层画像建议「加入/忽略」后剥除协议标记行用） */
export function editAiMessage(id: number, content: string): void {
  getDb().prepare('UPDATE ai_messages SET content = ? WHERE id = ?').run(content, id)
}

/** /clear（优化建议区第14轮修订）：清空当前会话全部消息——上下文与存储一并清零，会话本身保留（标题不动） */
export function clearAiSession(sessionId: number): void {
  getDb().prepare('DELETE FROM ai_messages WHERE session_id = ?').run(sessionId)
}

/** /compact（优化建议区第14轮）：把会话历史压成「前情摘要」另存新会话（原会话保留），返回新会话 */
export async function compactAiSession(sessionId: number, signal?: AbortSignal): Promise<AiSession> {
  const d = getDb()
  const s = d
    .prepare('SELECT id, title, channel FROM ai_sessions WHERE id = ?')
    .get(sessionId) as { id: number; title: string; channel: string } | undefined
  if (!s) throw new Error('NOT_FOUND')
  const history = listAiMessages(sessionId).filter((m) => m.role !== 'system')
  if (history.length === 0) throw new Error('会话为空，无需压缩')
  const transcript = history
    .map((m) => `${m.role === 'user' ? '我' : 'AI'}：${m.content.replace(/<<<[^>]*>>>/g, '').trim()}`)
    .join('\n\n')
    .slice(0, 8000)
  const res = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: `请把以下对话历史压缩成一份简明摘要（保留关键事实、结论、待办与用户个人信息，500 字以内），直接输出摘要正文，不要任何前缀：\n\n${transcript}`
      }
    ],
    temperature: 0.3,
    signal
  })
  const summary = res.content.trim()
  if (!summary) throw new Error('LLM 未返回内容')
  const ns = createAiSession(`${s.title} · 压缩`, (s.channel as AiChannel) ?? 'assistant')
  // 摘要作为新会话首条消息落库：后续对话上下文 = 摘要 + 新消息（旧会话原样保留在列表）
  appendAiMessage('user', `【前情摘要】（由 /compact 生成，此前对话已压缩）\n${summary}`, null, ns.id)
  return ns
}

export function appendAiMessage(
  role: AiMessage['role'],
  content: string,
  aiModule: string | null,
  sessionId: number
): AiMessage {
  const now = nowIso()
  const d = getDb()
  const r = d
    .prepare('INSERT INTO ai_messages (role, ai_module, content, created_at, session_id) VALUES (?, ?, ?, ?, ?)')
    .run(role, aiModule, content, now, sessionId)
  // 消息入会话即视为活跃（会话列表按 updated_at 排序）
  d.prepare('UPDATE ai_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
  return {
    id: Number(r.lastInsertRowid),
    session_id: sessionId,
    role,
    ai_module: aiModule,
    content,
    created_at: now
  }
}

/** 会话标题仍是默认值时，用消息前缀自动命名（去换行，超长截断） */
function autoTitleSession(sessionId: number, message: string): void {
  const d = getDb()
  const s = d.prepare('SELECT title FROM ai_sessions WHERE id = ?').get(sessionId) as
    | { title: string }
    | undefined
  if (!s || s.title !== DEFAULT_SESSION_TITLE) return
  const title = message.replace(/\s+/g, ' ').trim().slice(0, AUTO_TITLE_LEN) || DEFAULT_SESSION_TITLE
  d.prepare('UPDATE ai_sessions SET title = ? WHERE id = ?').run(title, sessionId)
}

/** 系统消息（辩真阁验证过程等）落指定频道的激活会话；该频道无激活会话则自动新建一个接收 */
export function appendSystemToChannelSession(channel: AiChannel, content: string): AiMessage {
  let sid = getActiveSessionId(channel)
  if (sid == null) {
    const title = content.replace(/\s+/g, ' ').trim().slice(0, AUTO_TITLE_LEN) || DEFAULT_SESSION_TITLE
    const s = createAiSession(title, channel)
    setActiveSessionId(s.id, channel)
    sid = s.id
  }
  return appendAiMessage('system', content, null, sid)
}

const MODULE_LABELS: Record<string, string> = {
  mottos: '格言库',
  wiki: '万象库',
  inspirations: '灵感泉',
  verify: '辩真阁',
  zhijiji: '致知己',
  recycle: '回收站',
  profile: '个人中心'
}

/** 频道人设（DB v9 频道制，致知己 specs §4） */
const CHANNEL_PERSONAS: Record<AiChannel, string> = {
  assistant: '当前频道是「助手」，你是通用助手，可自由回答各类话题。',
  motto:
    '当前频道是「格言·解读」，你是格言解读员：用户发来一条格言，请依次给出——①字面义：用平实的话讲清这句话在说什么；②背景与出处：它从哪里来、原来的语境是什么（不确定的内容要明说，绝不编造）；③引申与适用：今天什么场景下用得上、怎么用。全文 150~300 字，语言平实，不掉书袋、不灌鸡汤。',
  wiki:
    '当前频道是「万象·问答」，你是知识讲解员：用通俗、准确的方式讲解非计算机领域的知识，多用具体例子，必要时指出常见误解。',
  zhijiji:
    '当前频道是「致知己·追问」，你是用户请来的「较真的朋友」：用户正在把自己对某个问题的答案写成版本，你的职责是追问检验——找逻辑漏洞、要具体例子、问适用边界，一次提 1~3 个追问。绝不替用户写答案，绝不输出答案文本，只提问与追问。',
  verify:
    '当前频道是「辩真·核查」，你是核查员：围绕待验证观点的真实性讨论，结论要有依据，引用来源时给出链接。'
}

/** 画像提炼指令（各频道通用，致知己 specs §3/§4）：识别到稳定新信息时以协议标记提议入档 */
const PROFILE_SUGGEST_INSTRUCTION =
  '当你从对话中识别到关于用户本人的稳定信息（基本档案、性格特质、擅长能力、兴趣爱好、生活方式、社交出行、学习与技能、职业规划、价值观等，且下方画像索引尚未覆盖）时，在回复的最末尾另起一行输出标记：<<<PROFILE_SUGGEST:类别|内容>>>（类别从 基本档案/性格特质/擅长能力/兴趣爱好/生活方式/社交出行/学习与技能/职业规划/价值观/其他 中选择，内容一句话概括）；没有可补充的就绝不输出该标记。'

/** 画像检索协议标记（优化建议区第13轮「记忆化」）：AI 需要时输出 <<<PROFILE_LOOKUP:关键词>>> 索取详情 */
const PROFILE_LOOKUP_RE = /^<<<PROFILE_LOOKUP:([^>]+?)>>>\s*$/m

/** 画像检索指令（边栏对话）：只带索引，详情按需索取——避免全量注入干扰注意力 */
const PROFILE_LOOKUP_INSTRUCTION =
  '你对用户本人有一份画像索引（见下）。当且仅当需要了解更多用户信息才能更好地完成任务时，先在回复中单独一行输出检索标记：<<<PROFILE_LOOKUP:关键词>>>（如 <<<PROFILE_LOOKUP:学习与技能>>>），系统会把画像中相关条目提供给你，你再继续完成回答；不需要时直接作答，绝不输出该标记。'

/** 画像条目压成单行摘要（截断 maxChars，防长条目撑爆上下文） */
function factLine(category: string, content: string, maxChars: number): string {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  const c = oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…` : oneLine
  return `- ${category}：${c}`
}

function profileRows(): { category: string; content: string }[] {
  return getDb()
    .prepare('SELECT category, content FROM profile_facts ORDER BY id')
    .all() as { category: string; content: string }[]
}

/** 画像压缩摘要（生成类功能注入用，优化建议区第13轮：不整篇全文，每条截断 60 字控上下文长度） */
export function profileDigest(): string {
  const rows = profileRows()
  if (rows.length === 0) return ''
  return `## 用户画像（了解用户是谁，生成时参考）\n${rows
    .map((r) => factLine(r.category, r.content, 60))
    .join('\n')}`
}

/** 画像索引（边栏对话 system prompt 记忆化用：只带类别 + 24 字摘要，详情走 PROFILE_LOOKUP 按需检索） */
export function profileIndex(): string {
  const rows = profileRows()
  if (rows.length === 0) return ''
  return `## 用户画像索引（你记住的关于用户的信息概要，详情可检索）\n${rows
    .map((r) => factLine(r.category, r.content, 24))
    .join('\n')}`
}

/** 画像检索（PROFILE_LOOKUP 协议）：类别或内容命中关键词（或关键词包含类别名）→ 完整条目 */
export function lookupProfileFacts(keyword: string): string[] {
  const kw = keyword.trim()
  if (!kw) return []
  return profileRows()
    .filter(
      (r) =>
        r.category.includes(kw) || r.content.includes(kw) || (kw.length >= 2 && kw.includes(r.category))
    )
    .map((r) => `- ${r.category}：${r.content.replace(/\s+/g, ' ').trim()}`)
}

/**
 * 记忆化补全（优化建议区第13轮）：首轮回复若带 <<<PROFILE_LOOKUP:关键词>>> 检索标记，
 * 注入画像命中条目后再答一轮（最多补一轮），最终输出剥除标记。仅用于边栏对话。
 */
async function chatWithProfileLookup(req: {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  temperature: number
  signal?: AbortSignal
}): Promise<{ content: string }> {
  const first = await chatCompletion(req)
  const m = first.content.match(PROFILE_LOOKUP_RE)
  if (!m) return first
  const kw = m[1].trim()
  const hits = lookupProfileFacts(kw)
  const feedback = hits.length
    ? `【用户画像检索结果（关键词：${kw}）】\n${hits.join('\n')}\n\n请结合以上信息继续完成你的回答。`
    : `【用户画像检索结果（关键词：${kw}）】画像中没有相关条目，请基于已有信息直接作答，不要再输出检索标记。`
  const second = await chatCompletion({
    ...req,
    messages: [
      ...req.messages,
      { role: 'assistant', content: first.content.replace(PROFILE_LOOKUP_RE, '').trim() },
      { role: 'user', content: feedback }
    ]
  })
  return { content: second.content.replace(PROFILE_LOOKUP_RE, '').trim() }
}

/** AI 边栏对话（频道制）：会话内历史 + 频道人设 + 我的画像 + 模块感知 system prompt */
export async function aiChat(
  userMessage: string,
  currentModule: string,
  sessionId: number,
  channel: AiChannel = 'assistant',
  signal?: AbortSignal
): Promise<AiMessage> {
  // 首条用户消息自动命名会话，再落用户消息（持久化该会话全历史）
  autoTitleSession(sessionId, userMessage)
  const userMsg = appendAiMessage('user', userMessage, currentModule, sessionId)
  const history = listAiMessages(sessionId)
    .filter((m) => m.role !== 'system')
    .slice(-30)
    .map((m) => ({ role: m.role, content: m.content }) as { role: 'user' | 'assistant'; content: string })
  const moduleLabel = MODULE_LABELS[currentModule] ?? currentModule
  const system = [
    `你是 bugzi 的个人工作台「bug子的workspace」的 AI 助手，名叫 ${AI_NAME}。对话中提到自己时自称 ${AI_NAME}。用户当前所在模块：${moduleLabel}。`,
    CHANNEL_PERSONAS[channel] ?? CHANNEL_PERSONAS.assistant,
    '回答使用简体中文，简洁友好。',
    PROFILE_SUGGEST_INSTRUCTION,
    PROFILE_LOOKUP_INSTRUCTION,
    profileIndex()
  ]
    .filter(Boolean)
    .join('\n')
  // 记忆化（优化建议区第13轮）：画像只带索引，AI 需要时经 PROFILE_LOOKUP 检索详情
  const res = await chatWithProfileLookup({
    messages: [{ role: 'system', content: system }, ...history],
    temperature: 0.8,
    signal
  })
  const assistantMsg = appendAiMessage('assistant', res.content, currentModule, sessionId)
  return assistantMsg
}

// ---------- 格言生成（格言库 specs §3 / v2.0 §7.3-§7.4） ----------

function parseJsonArray(raw: string): { content: string; source: string; kind?: string }[] {
  // 兼容 ```json 包裹与裸 JSON；兼容 {"mottos":[...]} 对象包裹（json_object 模式下多数服务强制顶层为对象，无法直接返回数组）
  const text = raw.replace(/^[\s\S]*?```(?:json)?\s*\n?/, '').replace(/\n?```\s*[\s\S]*$/, '').trim()
  let parsed: unknown = JSON.parse(text)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    // 对象形态：取第一个数组类型的字段（如 mottos/items/data/list）
    parsed = Object.values(parsed).find((v) => Array.isArray(v)) ?? parsed
  }
  if (!Array.isArray(parsed)) throw new Error('LLM 未返回 JSON 数组')
  const out: { content: string; source: string; kind?: string }[] = []
  for (const item of parsed) {
    if (item && typeof item.content === 'string' && typeof item.source === 'string') {
      out.push({
        content: item.content.trim(),
        source: item.source.trim(),
        kind: typeof item.kind === 'string' ? item.kind : undefined
      })
    }
  }
  if (out.length === 0) throw new Error('LLM 返回数组为空或字段缺失')
  return out
}

export interface GenerateMottosResult {
  generated: number
  inserted: number
  /** 入库的摘录条数（v2.0 §7.3） */
  excerptInserted: number
  /** 入库的编撰条数（v2.0 §7.3） */
  composedInserted: number
  /** 因句式禁令被剔除的编撰条数（优化建议区第23轮） */
  patternRejected: number
  /** 命中已删除格言墓碑被剔除的条数（优化建议区第24轮，两轮合计） */
  tombstoneRejected: number
  /** 补足轮最终入库条数（优化建议区第24轮） */
  supplemented: number
  /** 因口语化被剔除的编撰条数（优化建议区第27轮，两轮合计） */
  colloquialRejected: number
}

/** LLM 生成返回的格言条目（kind 缺省/非法由 mottoKind 容错推断） */
type GeneratedMotto = { content: string; source: string; kind?: string }

/** kind 缺失/非法时按出处推断（v2.0 §7.3 解析容错）：编撰条 v10 起署名 debugzi，旧格式「AI 编撰」仍兼容 */
function mottoKind(kind: string | undefined, source: string): 'excerpt' | 'composed' {
  if (kind === 'excerpt' || kind === 'composed') return kind
  return /(?:ai\s*编撰|debugzi)/i.test(source) ? 'composed' : 'excerpt'
}

/**
 * 编撰条禁用句式（优化建议区第23轮）：按句式家族与 generateMottos prompt 禁令对应
 * （prompt 第 5 类拆 5a/5b 两条；正则口径略宽于 prompt 字面，作兜底），
 * 仅校验 composed 条；摘录条（真实名言）豁免。命中即剔除、不补足。
 */
const COMPOSED_BANNED_PATTERNS: RegExp[] = [
  /(?:不是|并非)[^，,。；;！？\n]{1,24}[，,][^，,。；;！？\n]{0,16}而是/, // 1 不是/并非A，而是B
  /与其说?[^，,。；;！？\n]{0,24}[，,][^，,。；;！？\n]{0,12}不如说?/, // 2 与其（说）A，不如（说）B
  /真正的[^，,。；;！？\n]{1,16}[，,][^。；;！？\n]{0,10}(?:从来)?(?:不是|是|都是)/, // 3 真正的A，（从来）是/不是/都是B
  /所谓[^，,。；;！？\n]{1,16}[，,](?:不过是|只是)/, // 4 所谓A，不过是/只是B
  /[，,](?:才算|才配)/, // 5a ……，才算/才配
  /唯有[^，,。；;！？\n]{1,16}[，,](?:才|方可)/, // 5b 唯有A，才/方可B
  /(?:所有|一切)[^，,。；;！？\n]{1,20}[，,]都/, // 6 所有/一切A，都B（全称断言）
  /愿你/ // 7 愿你祝福腔（中文格言出现即祝福腔，误伤率极低，从宽抓）
]

/** 口语化兜底（优化建议区第27轮）：仅约束编撰条，摘录条豁免（真实名言不受限）。
 * 四维——句尾语气词 / 口语虚词 / 句首叮嘱式 / 编撰条限长 22 字（标点计入）。
 * 正反行为验证 12 命中 / 8 放行 ALL PASS（2026-09-08）。 */
const COLLOQUIAL_PATTERNS: RegExp[] = [
  /(?:呢|吧|啊|嘛|啦|呗|了)[。！？…"」]?\s*$/, // 1 句尾语气词（句尾「了」为口语完成体；句中「了解」不误杀）
  /其实|真的|确实|反正/, // 2 口语虚词填充
  /^(?:你要|你应该|你们|别再|记得|赶紧|千万)/, // 3 句首叮嘱式
  /^.{23,}/s // 4 编撰条限长
]

/** 「来10条格言」（v2.0：5 摘录 + 5 编撰）：正式区风格样本 → LLM 生成 → 增强查重入库草稿区 */
export async function generateMottos(signal?: AbortSignal): Promise<GenerateMottosResult> {
  const d = getDb()
  const formal = d
    .prepare("SELECT content, source FROM mottos WHERE status = 'formal' AND deleted_at IS NULL ORDER BY id DESC LIMIT 50")
    .all() as { content: string; source: string }[]
  const samples = formal.length
    ? formal.map((m) => `- ${m.content} —— ${m.source}`).join('\n')
    : '（暂无，可自由发挥）'
  // 去重清单（§7.4.1/§7.4.3）：三区 + 回收站全部格言（不过滤 deleted_at），最多 500 条防 prompt 超长
  const existingRows = d
    .prepare('SELECT content FROM mottos ORDER BY updated_at DESC LIMIT 500')
    .all() as { content: string }[]
  const avoidList = existingRows.length
    ? existingRows.map((r) => `- ${r.content}`).join('\n')
    : '（暂无）'
  // 已删除格言墓碑（优化建议区第24轮）：表只增不删——代码侧判重用全量 norms，
  // prompt 注入只取最近 300 条控制长度；补足轮同样携带（见 buildPrompt）
  const tombstoneRows = d
    .prepare('SELECT content, content_norm FROM motto_tombstones ORDER BY created_at DESC, id DESC')
    .all() as { content: string; content_norm: string }[]
  const tombstoneNorms = tombstoneRows.map((t) => t.content_norm)
  const tombstoneSection = tombstoneRows.length
    ? `\n\n以下是我明确删除过的格言，同样不得生成，也不得仅差微小改写：\n${tombstoneRows
        .slice(0, 300)
        .map((t) => `- ${t.content}`)
        .join('\n')}`
    : ''
  /** 生成 prompt：第一轮 (5, 5, '')；补足轮传缺口配比与本批已入库清单（extraAvoid） */
  const buildPrompt = (nExcerpt: number, nComposed: number, extraAvoid: string): string =>
    `${profileDigest()}${profileDigest() ? '\n\n' : ''}以下是我的格言库正式区已有的格言（风格样本）：\n${samples}\n\n请参考这些格言的风格与题材，生成 ${nExcerpt + nComposed} 条新格言：恰好 ${nExcerpt} 条摘录自现实书籍作品的名言（kind 为 "excerpt"，source 标真实出处，如书名/作者），恰好 ${nComposed} 条由你自行编撰（kind 为 "composed"，source 标「debugzi」）。\n\n你自行编撰的 ${nComposed} 条额外遵守句式禁令——以下 7 类对仗套话一律禁止：\n1. 「不是A，而是B」「并非A，而是B」\n2. 「与其A，不如B」「与其说A，不如说B」\n3. 「真正的A，是/从来不是B」\n4. 「所谓A，不过是B」\n5. 「……，才算……」「唯有A，才B」类排他强调\n6. 「所有/一切A，都B」全称断言\n7. 「愿你……」祝福腔\n你自行编撰的 ${nComposed} 条必须写出**格言的文体**，遵守五条标准——\n1. 凝练：一句成型，一般不超 20 字，删一字则伤；\n2. 断言：是一个判断或主张，不是描述、不是叮嘱——说出来就站住，无需论证；\n3. 普遍：脱离具体情境依然成立，面向一类人生状况；\n4. 可诵：有顿挫节奏，读出声不拗口（但禁止上述 7 类空洞对仗）；\n5. 画面是载体不是目的：可以用具体意象承载抽象道理，但意象必须为断言服务。\n\n正例（编撰应有的样子）：「刀刃上没有多余的话，锋利就是全部语言。」——意象承载断言，凝练立得住。\n反例一（大白话型，不合格）：「今天的事别拖到明天，拖着拖着就忘了。」——是叮嘱不是格言，缺断言力与普遍性。\n反例二（散文型，不合格）：「秋天的落叶铺满了小路，每一步都发出细碎的声响。」——有画面但无观点，画面成了目的。\n另有代码侧口语化检测，命中即剔除：句尾语气词（呢/吧/啊/嘛/啦/呗/了）、口语虚词（其实/真的/确实/反正）、句首叮嘱（你要/你应该/别再/记得/赶紧/千万）、超过 22 字——请自检规避。摘录条（kind 为 "excerpt"）不受以上文体约束，如实引用原文。\n\n以下是我已有的全部格言清单，你生成的内容不得与清单中任何一条重复，也不得仅对清单条目作微小改写：\n${avoidList}${extraAvoid ? `\n${extraAvoid}` : ''}${tombstoneSection}\n\n以 JSON 对象返回，最外层是对象，格式：{"mottos":[{"content":"格言正文","source":"出处","kind":"excerpt 或 composed"}]}，mottos 数组内恰好 ${nExcerpt + nComposed} 项（${nExcerpt} 条 excerpt + ${nComposed} 条 composed），不要输出其他任何内容。`
  /** 单趟调用 + 解析（解析失败自动重试一次，specs §3.1；两轮共用） */
  const callAndParse = async (prompt: string): Promise<GeneratedMotto[]> => {
    const call = () =>
      chatCompletion({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        jsonMode: true,
        signal
      })
    const res = await call()
    try {
      return parseJsonArray(res.content)
    } catch {
      const retry = await call()
      return parseJsonArray(retry.content)
    }
  }
  // 入库前查重（§7.4.2/§7.4.3）：规范化一致或互为子串（长度门槛内）即重复；
  // 比对集合 = 三区 + 回收站全部格言 + 全量墓碑，且随本批插入逐步扩充（批内互斥）。
  // 墓碑先判（可归因 tombstoneRejected，第24轮），库内/批内后判（静默跳过，维持旧口径）
  const allNorms = existingRows.map((r) => normalizeText(r.content))
  const now = nowIso()
  // 插到草稿区开头（优化建议区「序号+拖拽排序」决策：新格言插区首）：
  // 逐条 MIN(sort)-1 递减，先插入的排更前（初始化即归一，防闭包内 null 收窄失效）
  const headSortRaw = (
    d.prepare("SELECT MIN(sort) AS m FROM mottos WHERE status = 'draft' AND deleted_at IS NULL").get() as {
      m: number | null
    }
  ).m
  let headSort = headSortRaw == null ? 1 : headSortRaw
  const ins = d.prepare(
    "INSERT INTO mottos (content, source, status, origin, gen_kind, sort, tags, created_at, updated_at) VALUES (?, ?, 'draft', 'ai', ?, ?, '[]', ?, ?)"
  )
  let inserted = 0
  let excerptInserted = 0
  let composedInserted = 0
  let patternRejected = 0
  let colloquialRejected = 0
  let tombstoneRejected = 0
  const batchInsertedContents: string[] = []
  /** 一批候选过同一套过滤（墓碑 → 库内/批内 → 句式）后入库，计数累计到外层（两轮共用） */
  const insertBatch = (items: GeneratedMotto[]): void => {
    for (const it of items) {
      const key = normalizeText(it.content)
      if (!key) continue
      if (isDupMotto(tombstoneNorms, key)) {
        tombstoneRejected++
        continue
      }
      if (isDupMotto(allNorms, key)) continue
      // gen_kind 落库（DB v6）：驱动 AI 徽章仅编撰条显示、摘录条不打
      const kind = mottoKind(it.kind, it.source)
      // 句式禁令兜底（优化建议区第23轮）：仅编撰条，命中剔除；摘录条豁免（真实名言不受限）
      if (kind === 'composed' && COMPOSED_BANNED_PATTERNS.some((p) => p.test(it.content))) {
        patternRejected++
        continue
      }
      // 口语化兜底（优化建议区第27轮）：仅编撰条，命中剔除；摘录条豁免
      if (kind === 'composed' && COLLOQUIAL_PATTERNS.some((p) => p.test(it.content))) {
        colloquialRejected++
        continue
      }
      allNorms.push(key)
      batchInsertedContents.push(it.content)
      headSort -= 1
      ins.run(it.content, it.source, kind, headSort, now, now)
      if (kind === 'composed') composedInserted++
      else excerptInserted++
      inserted++
    }
  }
  // 第一轮：5 摘录 + 5 编撰
  const firstItems = await callAndParse(buildPrompt(5, 5, ''))
  let generated = firstItems.length
  ensureNotCancelled(signal)
  insertBatch(firstItems)
  // 补足轮（优化建议区第24轮·统一补一轮）：第一轮剔除（墓碑/库内/句式）后按 5/5 配比
  // 补缺口，本批已入库进避免清单，重跑同一套过滤；失败非致命，保留第一轮结果
  let supplemented = 0
  const shortfallExcerpt = Math.max(0, 5 - excerptInserted)
  const shortfallComposed = Math.max(0, 5 - composedInserted)
  if (shortfallExcerpt > 0 || shortfallComposed > 0) {
    try {
      ensureNotCancelled(signal)
      const batchAvoid = batchInsertedContents.map((c) => `- ${c}`).join('\n')
      const more = await callAndParse(buildPrompt(shortfallExcerpt, shortfallComposed, batchAvoid))
      generated += more.length
      const before = inserted
      insertBatch(more)
      supplemented = inserted - before
    } catch (e) {
      // 取消如实上抛（渲染层 toast「已取消」，不走「生成失败」弹窗）；其余失败非致命（第24轮）
      if (signal?.aborted) throw e
    }
  }
  return {
    generated,
    inserted,
    excerptInserted,
    composedInserted,
    patternRejected,
    tombstoneRejected,
    supplemented,
    colloquialRejected
  }
}

// ---------- 灵感泉 v2.0（灵感泉 specs §6：从零生成 + AI 完善） ----------

/** 灵感形态枚举（优化建议区任务2）：发散候选携 form 标签，自评按配额挑 5，跨阶段透传；发散 prompt 规则 2 以 length/join 插值引用本数组，增删形态会同步改变 prompt */
const INSPIRATION_FORMS = [
  '实用工具',
  '游戏与玩具',
  '内容创作',
  '数据可视化',
  '实验探索',
  '艺术表达',
  '社群活动'
] as const

/** 风向标基调词池（优化建议区任务2）：每批随机抽 1~2 个注入发散 prompt，跨批换口味；与手动方向指引冲突时指引优先 */
const WIND_POOL = [
  '实用主义',
  '纸上原型',
  '数据控',
  '声音实验',
  '时间胶囊',
  '荒诞幽默',
  '城市观察',
  '怀旧电子',
  '桌面游戏',
  '手作实感',
  '极简主义',
  '社群之夜',
  '慢生活',
  '解谜推理'
] as const

/** 抽取本批风向：1~2 个不重复基调词（个数各半概率），池恒有 14 词不会抽空 */
function pickWinds(): string[] {
  const pool = [...WIND_POOL]
  const count = Math.random() < 0.5 ? 1 : 2
  const winds: string[] = []
  for (let i = 0; i < count && pool.length > 0; i++) {
    winds.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
  }
  return winds
}

/** 灵感点子统一形状（优化建议区第28轮）：发散阶段只有 summary；自评阶段产出完整 body 文档；降级路径（pickDiverseFive）无 body 走 summary 兜底 */
interface InspirationIdea {
  title: string
  summary: string
  form: string
  /** 完整点子文档（引子段 + 这是什么/核心机制/最小版本三小节，300~400 字）；发散候选与降级批次无此字段 */
  body?: string
}

/** 解析 LLM 返回的灵感数组（兼容 ```json 与 {"inspirations":[...]} 对象包裹，同 parseJsonArray 容错）；form 非必填，非法落「未分类」（优化建议区任务2）；body 非必填（第28轮：仅自评阶段输出），summary/body 至少其一非空 */
function parseInspirationArray(raw: string): InspirationIdea[] {
  const text = raw.replace(/^[\s\S]*?```(?:json)?\s*\n?/, '').replace(/\n?```\s*[\s\S]*$/, '').trim()
  let parsed: unknown = JSON.parse(text)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    parsed = Object.values(parsed).find((v) => Array.isArray(v)) ?? parsed
  }
  if (!Array.isArray(parsed)) throw new Error('LLM 未返回 JSON 数组')
  const out: InspirationIdea[] = []
  for (const item of parsed) {
    // title 必填；summary/body 至少其一非空（第28轮：自评阶段输出 body 可无 summary）；form 只做归一不设卡
    if (
      item &&
      typeof item.title === 'string' &&
      item.title.trim() &&
      ((typeof item.summary === 'string' && item.summary.trim()) ||
        (typeof item.body === 'string' && item.body.trim()))
    ) {
      const rawForm = typeof item.form === 'string' ? item.form.trim() : ''
      const form = (INSPIRATION_FORMS as readonly string[]).includes(rawForm) ? rawForm : '未分类'
      out.push({
        title: item.title.trim(),
        summary: typeof item.summary === 'string' ? item.summary.trim() : '',
        form,
        body: typeof item.body === 'string' && item.body.trim() ? item.body.trim() : undefined
      })
    }
  }
  if (out.length === 0) throw new Error('LLM 返回数组为空或字段缺失')
  return out
}

/** 读灵感 md 正文（v11 起正文不含标题行；读失败返回空串），截 maxLen 字；flatten 时压缩空白（画像单行场景） */
function inspirationBody(mdPath: string, maxLen: number, flatten: boolean): string {
  let raw: string
  try {
    raw = mdRead(mdPath)
  } catch {
    return ''
  }
  const body = raw.trim()
  return (flatten ? body.replace(/\s+/g, ' ') : body).slice(0, maxLen).trim()
}

/** 灵感方向指引（优化建议区第18轮）：用户手写的「想要/不想要」，生成时置顶注入（最高优先级） */
function inspirationGuide(): { pos: string; neg: string } {
  const g = getJsonSetting<{ pos?: string; neg?: string }>(SettingsKeys.InspirationGuide, {})
  return { pos: (g.pos ?? '').trim(), neg: (g.neg ?? '').trim() }
}

/**
 * 口味画像（优化建议区第18轮）：跨模块聚合「用户是谁」——画像 + 格言正式区（价值观）+ 万象词条（求知领域）+ 手写灵感（真实意图）。
 * AI 生成的灵感不进画像（只进避免清单），打破「AI 吃自己输出」的同质化循环。
 */
function inspirationTasteProfile(): string {
  const d = getDb()
  const parts: string[] = []
  // ① 个人中心-我的画像（60 字/条压缩摘要，同 profileDigest）
  const digest = profileDigest()
  if (digest) parts.push(digest)
  // ② 格言正式区：只取用户精选转正的（真爱信号；AI 编撰转正的同样是用户的主动选择）
  const mottos = d
    .prepare(
      "SELECT content, source FROM mottos WHERE deleted_at IS NULL AND status = 'formal' ORDER BY updated_at DESC LIMIT 30"
    )
    .all() as { content: string; source: string }[]
  if (mottos.length) {
    parts.push(
      `## 我精选的格言（价值观与品味，领会气质而非照抄题材）\n${mottos
        .map(
          (m) =>
            `- ${m.content.replace(/\s+/g, ' ').slice(0, 40)}${m.source ? ` —— ${m.source.slice(0, 20)}` : ''}`
        )
        .join('\n')}`
    )
  }
  // ③ 万象库词条：按板块聚合（词条名即领域信号，不用正文）
  const wiki = d
    .prepare(
      `SELECT s.name AS section, e.term FROM wiki_entries e
       JOIN wiki_sections s ON e.section_id = s.id
       WHERE e.deleted_at IS NULL ORDER BY e.updated_at DESC LIMIT 50`
    )
    .all() as { section: string; term: string }[]
  if (wiki.length) {
    const bySection = new Map<string, string[]>()
    for (const w of wiki) {
      const arr = bySection.get(w.section) ?? []
      arr.push(w.term)
      bySection.set(w.section, arr)
    }
    parts.push(
      `## 我在学的知识词条（求知领域）\n${[...bySection.entries()]
        .map(
          ([s, terms]) =>
            `- ${s}：${terms.slice(0, 10).join('、')}${terms.length > 10 ? ` 等 ${terms.length} 条` : ''}`
        )
        .join('\n')}`
    )
  }
  // ④ 灵感泉手动条（当前可能为空，随使用增长）
  const manual = d
    .prepare(
      "SELECT title FROM inspirations WHERE deleted_at IS NULL AND origin = 'manual' ORDER BY updated_at DESC LIMIT 30"
    )
    .all() as { title: string }[]
  if (manual.length) {
    parts.push(`## 我手写的灵感（真实意图）\n${manual.map((m) => `- ${m.title}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

/**
 * 降级路径的代码侧配额挑选（优化建议区任务2）：自评两趟均失败时按 form 多样性贪心取 5 条——
 * 同 form ≤2、每轮优先补出现次数最少的形态；候选全为「未分类」等配额不可满足场景按原顺序取前 5 条兜底。
 */
function pickDiverseFive(candidates: InspirationIdea[]): InspirationIdea[] {
  const picked: InspirationIdea[] = []
  const formCount = new Map<string, number>()
  const isPicked = (c: InspirationIdea): boolean => picked.some((p) => p === c)
  while (picked.length < 5) {
    let bestIdx = -1
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]
      if (isPicked(c)) continue
      const cnt = formCount.get(c.form) ?? 0
      if (cnt >= 2) continue // 该形态已满 2 条
      if (bestIdx === -1 || cnt < (formCount.get(candidates[bestIdx].form) ?? 0)) bestIdx = i
    }
    if (bestIdx === -1) break // 剩余候选形态均满额或已耗尽 → 走原顺序兜底
    picked.push(candidates[bestIdx])
    formCount.set(candidates[bestIdx].form, (formCount.get(candidates[bestIdx].form) ?? 0) + 1)
  }
  // 兜底：配额不可满足时按原顺序补满（含全「未分类」场景）
  for (const c of candidates) {
    if (picked.length >= 5) break
    if (!isPicked(c)) picked.push(c)
  }
  return picked.slice(0, 5)
}

export interface GenerateInspirationsResult {
  generated: number
  inserted: number
  /** 本批风向（1~2 个基调词），渲染层 toast 展示用（优化建议区任务2） */
  winds: string[]
}

/**
 * 「来5条灵感」（specs §6.2；第18轮两阶段 + 任务2规范 v2 + 第28轮完整点子文档）：
 * 阶段一发散——12 条粗点子（形态分散、标题实体锚点、summary 两句白话、风向注入，不变）；
 * 阶段二自评——五维评审按批内配额挑 5 条，并为每条写完整点子文档 body（引子 + 三小节）。
 * 口味注入：手动指引置顶 + 跨模块口味画像；AI 生成条只进避免清单。
 */
export async function generateInspirations(signal?: AbortSignal): Promise<GenerateInspirationsResult> {
  const d = getDb()
  // 避免清单（specs §6.2）：全部标题（含回收站，不过滤 deleted_at），最多 500 条防 prompt 超长
  const existingRows = d
    .prepare('SELECT title FROM inspirations ORDER BY updated_at DESC LIMIT 500')
    .all() as { title: string }[]
  const avoidList = existingRows.length ? existingRows.map((r) => `- ${r.title}`).join('\n') : '（暂无）'
  // 口味材料：手动指引（置顶、最高优先级，留空不注入）+ 跨模块口味画像
  const guide = inspirationGuide()
  const guideBlock =
    guide.pos || guide.neg
      ? `## 我的方向指引（最高优先级，严格遵守）\n${guide.pos ? `我感兴趣的方向：${guide.pos}\n` : ''}${guide.neg ? `我明确不想要的方向：${guide.neg}` : ''}`
      : ''
  const tasteBlock =
    inspirationTasteProfile() || '（暂无口味材料——可自由大胆发散，但依旧严格执行下方生成规则）'
  const tasteWithGuide = `${guideBlock}${guideBlock ? '\n\n' : ''}${tasteBlock}`

  // 风向标（优化建议区任务2）：每批随机 1~2 个基调词注入，跨批换口味；与方向指引冲突时指引优先
  const winds = pickWinds()
  const windBlock = `## 本批风向（每批随机轮换的基调倾向）\n${winds.join('、')}——12 条中 3~5 条向风向靠拢即可，其余自由发挥；若与「我的方向指引」冲突，以方向指引为准。`

  // 阶段一：发散（temperature 高，出 12 条粗点子；标题锚点/summary 两句/风向注入——优化建议区任务2）
  const divergePrompt = `你是一位挑剔的创意策展人，服务一位有独立品味的开发者。你的任务不是罗列平庸点子，也不是堆砌文艺概念，而是提出让人看了想立刻动手的项目灵感。

${tasteWithGuide}

${windBlock}

## 已有灵感清单（这些方向勿重复或高度雷同）
${avoidList}

## 生成规则（严格执行）
1. 恰好生成 12 条项目灵感。
2. 形态必须分散：每条标注 form 字段，从这 ${INSPIRATION_FORMS.length} 种里选——${INSPIRATION_FORMS.join(' / ')}；至少覆盖 4 种不同形态，严禁全部是「做一个工具/助手/平台」。
3. 每条必须具体可执行：说得清第一步做什么（最小版本要动手做的事）。
4. 禁止拼装式命名：「XX记录/追踪/打卡/复盘/管理 + 工具/助手/平台/工作台」这类句式模板一律不要。
5. 禁止平庸，也禁止故弄玄虚：安全但无聊的清单/CRUD 类点子不要；纯隐喻、读完不知道要做什么的概念装置也不要。
6. 与口味呼应：至少一半灵感能与口味材料（格言气质/求知领域/方向指引）看出真实连接，但严禁生搬硬套题材。
7. title：10~25 字，结构为「画面 + 实体锚点」——前半可以有画面感/氛围，后半必须落到看得见摸得着的实体（卡片、电台、程序、语音房、比赛、图鉴、博物馆、原型等）或具体数量（8张、7分钟、一晚）。正例：「税册里的雨神：8张证物卡」「匿名电台：只开七分钟，一生一次」；反例：「从税册里挖出一位失真的神」——纯隐喻，读完不知道要做什么。
8. summary：≤100 字，两句结构——第一句大白话说清「这是什么 + 好玩/值得在哪」，第二句以「第一步：」开头给出最小可动手动作；像跟朋友解释一样写，禁止「先…」开头句式，禁止文艺化压缩（每个名词都要落到具体动作/物件）。

以 JSON 对象返回，最外层是对象，格式：{"inspirations":[{"title":"...","summary":"...","form":"..."}]}，inspirations 数组内恰好 12 项，不要输出其他任何内容。`
  const callDiverge = () =>
    chatCompletion({
      messages: [{ role: 'user', content: divergePrompt }],
      temperature: 0.95,
      jsonMode: true,
      signal
    })
  let candidates: InspirationIdea[]
  try {
    candidates = parseInspirationArray((await callDiverge()).content)
  } catch (e) {
    // 取消直接上抛，不重试；解析失败自动重试一次（同 generateMottos），仍失败 → 抛出整体不入库
    if (signal?.aborted) throw e
    candidates = parseInspirationArray((await callDiverge()).content)
  }

  // 阶段二：自评筛选 + 完整点子文档（temperature 低，评审收敛；批内 form 配额 + body 骨架——优化建议区第28轮）
  const reviewPrompt = (list: InspirationIdea[]): string =>
    `你是同一位创意策展人，现在进行内部审稿：从下面 ${list.length} 条候选项目灵感中选出恰好 5 条最好的，并为每条写出完整点子文档。

${tasteWithGuide}

## 候选灵感
${list.map((c, i) => `${i + 1}. [${c.form}] ${c.title}：${c.summary}`).join('\n')}

## 评审规则（严格执行）
1. 心中按五维给每条打分（1~5）：新颖度、契合口味、具体度、兴奋度、标题可读性（不看 summary 能否猜到要做什么）——分数不用输出，只用于取舍。
2. 批内多样性硬配额：5 条至少覆盖 3 种不同 form，同一种 form 至多 2 条。
3. 淘汰同质（多条同类只留最好一条）、平庸、空泛、与「不想要的方向」冲突的。
4. 恰好选出 5 条；合格不足 5 条时从剩余中挑相对好的补足。
5. 为选中的每条写完整点子文档 body（Markdown 文本），结构固定：
   - 开头一段引子（不带小节标题）：一句话说清「这是什么 + 好玩/值得在哪」，像跟朋友讲一个想拉他入伙的点子。
   - 「## 这是什么」：做出来长什么样、给谁用、核心体验，一段说清。
   - 「## 核心机制」：这个点子最有意思的部分——怎么转、为什么有趣。
   - 「## 最小版本」：第一步做什么；一个周末能跑起来的最小版本长什么样。
   - 全文 300~400 字；语言平实具体，每个名词落到看得见摸得着的动作或物件，禁止文艺化压缩；「第一步」的内容写进最小版本小节，不要在引子里挤一句口号。

以 JSON 对象返回，最外层是对象，格式：{"inspirations":[{"title":"...","form":"...","body":"..."}]}，inspirations 数组内恰好 5 项，title 与 form 沿用候选原文，body 为完整 Markdown 文档字符串（段落与小节标题间用空行分隔），不要输出其他任何内容。`
  const callReview = (list: InspirationIdea[]) =>
    chatCompletion({
      messages: [{ role: 'user', content: reviewPrompt(list) }],
      temperature: 0.4,
      jsonMode: true,
      signal
    })
  let items: InspirationIdea[]
  try {
    items = parseInspirationArray((await callReview(candidates)).content)
  } catch (e) {
    if (signal?.aborted) throw e
    try {
      items = parseInspirationArray((await callReview(candidates)).content)
    } catch (e2) {
      if (signal?.aborted) throw e2
      // 自评两趟均失败 → 代码侧按 form 配额挑前 5，不空手而归也不带病降级（优化建议区任务2）
      items = pickDiverseFive(candidates)
    }
  }

  // 入库：标题精确查重（含回收站 + 批内互斥）→ 插草稿区末尾（specs §6.2，与 moveTo 区末尾语义一致）
  ensureNotCancelled(signal)
  const titles = new Set(existingRows.map((r) => r.title.trim()))
  let tailSort = (
    d.prepare("SELECT MAX(sort) AS m FROM inspirations WHERE status = 'draft' AND deleted_at IS NULL").get() as {
      m: number | null
    }
  ).m
  if (tailSort == null) tailSort = 0
  const now = nowIso()
  const ins = d.prepare(
    "INSERT INTO inspirations (title, status, md_path, sort, origin, created_at, updated_at) VALUES (?, 'draft', 'PENDING', ?, 'ai', ?, ?)"
  )
  let inserted = 0
  for (const it of items) {
    if (titles.has(it.title)) continue
    titles.add(it.title)
    tailSort += 1
    const r = ins.run(it.title, tailSort, now, now)
    const id = Number(r.lastInsertRowid)
    const mdPath = `md/inspirations/${id}.md`
    d.prepare('UPDATE inspirations SET md_path = ? WHERE id = ?').run(mdPath, id)
    // 正文写完整点子文档（第28轮）；降级批次无 body 退单行 summary；正文不写标题行（第19轮）
    mdCreate(mdPath, it.body ? `${it.body}\n` : `${it.summary}\n`)
    inserted++
  }
  return { generated: items.length, inserted, winds }
}

/** AI 完善（specs §6.3）：基于标题+正文生成三小节扩展建议；只生成不写库，追加由 inspirations:appendRefine 完成 */
export async function refineInspiration(id: number, signal?: AbortSignal): Promise<string> {
  const row = getDb().prepare('SELECT title, md_path FROM inspirations WHERE id = ?').get(id) as
    | { title: string; md_path: string }
    | undefined
  if (!row) throw new Error('NOT_FOUND')
  const body = inspirationBody(row.md_path, 4000, false) || '（正文暂空）'
  const prompt = `${profileDigest()}${profileDigest() ? '\n\n' : ''}以下是我的一个项目灵感：\n标题：${row.title}\n正文：\n${body}\n\n请基于这个灵感生成扩展建议，用简体中文 Markdown 输出，只输出以下三个小节（### 三级标题），不要输出其他任何内容：\n### 思路延伸\n（2~4 个可深化的方向，每个一句话）\n### 潜在难点\n（2~3 条）\n### 下一步行动\n（2~3 条具体可执行的事）`
  const res = await chatCompletion({ messages: [{ role: 'user', content: prompt }], temperature: 0.7, signal })
  const md = res.content.replace(/^```(?:markdown|md)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  if (!md) throw new Error('LLM 未返回内容')
  return md
}

// ---------- 写作台 Copilot 协笔（文笔坊 specs §4） ----------
// 零 AI 边界：本函数只读 wenbi_articles；md/wenbi/journal/（浮生记）永不进入任何 prompt。

export type WenbiCopilotAction = 'draft' | 'continue' | 'polish' | 'rewrite'

/** Copilot 协笔：起稿/续写/润色/改写。只生成建议不写库，采纳由渲染层完成（AI 永不直接改正文） */
export async function copilotWriting(
  articleId: number,
  action: WenbiCopilotAction,
  selection?: string,
  signal?: AbortSignal
): Promise<string> {
  if ((action === 'polish' || action === 'rewrite') && (!selection || !selection.trim())) {
    throw new Error('NO_SELECTION')
  }
  const row = getDb().prepare('SELECT title, md_path FROM wenbi_articles WHERE id = ?').get(articleId) as
    | { title: string; md_path: string }
    | undefined
  if (!row) throw new Error('NOT_FOUND')
  let body = ''
  try {
    body = mdRead(row.md_path).slice(0, 4000)
  } catch {
    /* 正文空按未写处理 */
  }
  const digest = profileDigest()
  const head = `${digest}${digest ? '\n\n' : ''}你是我的写作搭档，懂我的文风与领域。以下是我正在写的文章：\n标题：${row.title}\n正文：\n${body || '（正文暂空）'}`
  const instructions: Record<WenbiCopilotAction, string> = {
    draft: '请基于标题为这篇文章起稿：先给一份大纲（## 二级标题分节，每节一句话说明这一节写什么），再写出开头一两段。合计不超过 500 字。',
    continue: '请顺着正文接着往下写 200~400 字：保持语气与叙述连贯，不要重复已有内容，从正文结束处自然续起。',
    polish: `请润色下面这段文字：保持原意与信息不变，让表达更准确、更流畅。只输出润色后的这段文字，不要任何解释。\n待润色段落：\n${selection}`,
    rewrite: `请换一种写法重写下面这段文字：可以调整句式与切入角度，但事实与要点不动。只输出重写后的这段文字，不要任何解释。\n待改写段落：\n${selection}`
  }
  const prompt = `${head}\n\n${instructions[action]}\n\n用简体中文 Markdown 输出，只输出正文内容，不要任何解释、前言或代码围栏。`
  const res = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: action === 'draft' || action === 'continue' ? 0.7 : 0.4,
    signal
  })
  const md = res.content.replace(/^```(?:markdown|md)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  if (!md) throw new Error('LLM 未返回内容')
  return md
}

// ---------- 知识卡片生成（万象库 specs §3.1） ----------

export interface GenerateWikiResult {
  entryId: number
  term: string
  summary: string
}

/** 构思词条名（优化建议区「指定板块随机生成」）：指定板块用指定，未指定随机挑；规避全部已有词条 */
export async function suggestWikiTerm(
  sectionId: number | null,
  signal?: AbortSignal
): Promise<{ sectionId: number; term: string }> {
  const d = getDb()
  let section: { id: number; name: string }
  if (sectionId != null) {
    const s = d.prepare('SELECT id, name FROM wiki_sections WHERE id = ?').get(sectionId) as
      | { id: number; name: string }
      | undefined
    if (!s) throw new Error('板块不存在')
    section = s
  } else {
    const sections = d.prepare('SELECT id, name FROM wiki_sections ORDER BY sort').all() as {
      id: number
      name: string
    }[]
    if (sections.length === 0) throw new Error('请先创建板块')
    section = sections[Math.floor(Math.random() * sections.length)]
  }
  const existingTerms = (
    d.prepare('SELECT term FROM wiki_entries WHERE deleted_at IS NULL').all() as { term: string }[]
  ).map((r) => r.term)
  const avoid = existingTerms.length ? `（已有词条请避开：${existingTerms.join('、')}）` : ''
  const res = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: `请从「${section.name}」领域中构思一个值得收藏的知识词条（${avoid}），只返回词条名本身，不要任何解释和标点。`
      }
    ],
    temperature: 1.0,
    signal
  })
  const term = res.content.trim().replace(/^["'《]|["'》]$/g, '')
  if (!term) throw new Error('未能生成词条名')
  return { sectionId: section.id, term }
}

/** 生成知识卡片 md（固定模板，specs §3.1），并建词条记录 */
export async function generateWikiCard(
  term: string | null,
  sectionId: number | null,
  signal?: AbortSignal
): Promise<GenerateWikiResult> {
  const d = getDb()
  // 词条名缺省：LLM 构思（板块 = 指定板块，未指定则随机挑）
  if (!term) {
    const suggested = await suggestWikiTerm(sectionId, signal)
    sectionId = suggested.sectionId
    term = suggested.term
  }
  // 查重（手动输入场景已拦截，随机场景兜底）
  const dup = d
    .prepare('SELECT id FROM wiki_entries WHERE term = ? AND deleted_at IS NULL')
    .get(term)
  if (dup) throw new Error('CONFLICT:' + term)
  const prompt = `${profileDigest()}${profileDigest() ? '\n\n' : ''}请为词条「${term}」生成一张知识卡片，Markdown 格式，严格按以下模板输出（每个二级标题必须有内容，不要输出模板外的任何内容）：\n\n# ${term}\n\n## 一句话定义\n{一句话定义}\n\n## 详细解释\n{详细解释}\n\n## 举例\n{举例}\n\n## 启示\n{启示}`
  const res = await chatCompletion({ messages: [{ role: 'user', content: prompt }], temperature: 0.7, signal })
  const md = res.content.replace(/^```(?:markdown|md)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  // 一句话定义提取（模板第一个 ## 段）
  const summaryMatch = md.match(/## 一句话定义\s*\n([\s\S]*?)(?=\n## |\n*$)/)
  const summary = (summaryMatch?.[1] ?? '').trim().split('\n')[0] || `${term} 的知识卡片`
  const now = nowIso()
  const r = d
    .prepare(
      "INSERT INTO wiki_entries (section_id, term, summary, md_path, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'ai', ?, ?)"
    )
    .run(sectionId, term, summary, 'PENDING', now, now)
  const id = Number(r.lastInsertRowid)
  const mdPath = `md/wiki/${id}.md`
  d.prepare('UPDATE wiki_entries SET md_path = ? WHERE id = ?').run(mdPath, id)
  mdWrite(mdPath, md)
  return { entryId: id, term, summary }
}

// ---------- 测一测（优化建议区：基于万象库知识出选择题考察掌握程度） ----------

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

/** 解析 LLM 返回的测题数组（兼容 ```json 与 {"questions":[...]} 对象包裹，同 parseJsonArray 容错） */
function parseQuizArray(
  raw: string,
  idByTerm: Map<string, number>
): { entryId: number; term: string; question: string; options: string[]; answer: number }[] {
  const text = raw.replace(/^[\s\S]*?```(?:json)?\s*\n?/, '').replace(/\n?```\s*[\s\S]*$/, '').trim()
  let parsed: unknown = JSON.parse(text)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    parsed = Object.values(parsed).find((v) => Array.isArray(v)) ?? parsed
  }
  if (!Array.isArray(parsed)) throw new Error('LLM 未返回题目数组')
  const out: WikiQuizQuestion[] = []
  for (const item of parsed as Record<string, unknown>[]) {
    const term = typeof item.term === 'string' ? item.term.trim() : ''
    const question = typeof item.question === 'string' ? item.question.trim() : ''
    const options = Array.isArray(item.options)
      ? item.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
      : []
    const answer = typeof item.answer === 'number' ? item.answer : -1
    const entryId = idByTerm.get(term)
    // 选项至少 2 个、答案在范围内、能对上来源词条才收
    if (entryId != null && question && options.length >= 2 && answer >= 0 && answer < options.length) {
      out.push({ entryId, term, question, options, answer })
    }
  }
  if (out.length === 0) throw new Error('LLM 返回题目为空或字段缺失')
  return out
}

/** 每次测 5 题：随机抽 5 张卡片（不足则全取）→ 一次 LLM 调用批量出四选一 */
export async function generateWikiQuiz(signal?: AbortSignal): Promise<WikiQuizQuestion[]> {
  const d = getDb()
  const rows = d
    .prepare('SELECT id, term, md_path FROM wiki_entries WHERE deleted_at IS NULL')
    .all() as { id: number; term: string; md_path: string }[]
  if (rows.length === 0) throw new Error('题库为空，请先在万象库生成一些知识卡片')
  // Fisher-Yates 洗牌后取前 5
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rows[i], rows[j]] = [rows[j], rows[i]]
  }
  const picked = rows.slice(0, 5)
  const idByTerm = new Map<string, number>()
  const cards: string[] = []
  for (const r of picked) {
    let md = ''
    try {
      md = await mdRead(r.md_path)
    } catch {
      /* md 缺失的卡片跳过 */
    }
    if (!md) continue
    idByTerm.set(r.term, r.id)
    cards.push(`【词条：${r.term}】\n${md.slice(0, 1200)}`)
  }
  if (cards.length === 0) throw new Error('卡片内容读取失败')
  const prompt = `${profileDigest()}${profileDigest() ? '\n\n' : ''}以下是 ${cards.length} 张知识卡片。请基于每张卡片的内容各出一道四选一选择题，考查对核心知识点的掌握（不要直接抄卡片原句，干扰项要有迷惑性但明显错误）。以 JSON 对象返回，最外层是对象，格式：{"questions":[{"term":"对应的词条名","question":"题干","options":["选项一","选项二","选项三","选项四"],"answer":0}]}，answer 为正确选项的下标（0-3），questions 数组内恰好 ${cards.length} 项，不要输出其他任何内容。\n\n${cards.join('\n\n')}`
  const res = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    jsonMode: true,
    signal
  })
  return parseQuizArray(res.content, idByTerm)
}

// ---------- 辩真阁验证（辩真阁 specs §3） ----------

export interface VerifyResult {
  recordId: number
  credibility: number
}

/** 主进程验证流程：MCP 搜索多轮 → LLM 综合 → 写记录+md，过程消息经 onProgress 推 AI 边栏 */
export async function runVerification(
  claim: string,
  onProgress: (msg: string) => void,
  signal?: AbortSignal
): Promise<VerifyResult> {
  // 动态 import 避免循环依赖
  const { findSearchTool } = await import('./mcp')
  onProgress(`开始验证：${claim}`)
  const found = await findSearchTool(onProgress, signal)
  if (!found) throw new Error('未找到可用的搜索工具，请检查 MCP 服务器是否提供 search 类工具')
  const { mcp, tool } = found
  onProgress(`使用搜索工具：${tool}`)

  // 1) LLM 生成检索关键词
  const kwRes = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: `我想验证这个观点的真实性：「${claim}」。请生成 3 组适合搜索引擎检索的中英文关键词（每组关键词一行，直接输出，不要编号和解释）。`
      }
    ],
    temperature: 0.5,
    signal
  })
  const keywords = kwRes.content
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)
  onProgress(`检索关键词：${keywords.join('｜')}`)

  // 2) 逐组检索
  const searchResults: string[] = []
  for (const kw of keywords) {
    ensureNotCancelled(signal)
    onProgress(`正在检索：${kw}`)
    try {
      const resultText = await mcp.callTool(tool, { query: kw })
      searchResults.push(`【关键词：${kw}】\n${resultText}`)
      onProgress(`检索完成（${resultText.length} 字）`)
    } catch (e) {
      onProgress(`检索失败：${(e as Error).message}`)
    }
  }
  if (searchResults.length === 0) throw new Error('全部检索失败，无法验证')

  // 3) LLM 综合
  onProgress('正在综合分析…')
  const analysisRes = await chatCompletion({
    messages: [
      {
        role: 'user',
        // 辩真验证不注入画像（优化建议区第13轮）：观点核查与用户画像无关，注入反干扰注意力
        content: `观点：「${claim}」\n\n以下是检索到的资料：\n${searchResults.join('\n\n')}\n\n请基于资料验证该观点。先输出验证分析（引用资料说明依据），然后单独一行输出可信度百分比（0-100 的整数），格式严格为：可信度：N%\n\n分析正文使用 Markdown，若引用了具体来源请在分析中以 Markdown 链接列出。`
      }
    ],
    temperature: 0.3,
    signal
  })
  const full = analysisRes.content
  const m = full.match(/可信度[：:]\s*(\d{1,3})\s*%/)
  const credibility = Math.max(0, Math.min(100, m ? Number(m[1]) : 50))
  const analysis = (m ? full.replace(/可信度[：:]\s*\d{1,3}\s*%/, '').trim() : full).trim()

  // 4) 写记录 + md（取消在写库前拦截；已推送边栏的进度消息保留为历史事实）
  ensureNotCancelled(signal)
  const d = getDb()
  const now = nowIso()
  const r = d
    .prepare(
      'INSERT INTO verify_records (claim, analysis, credibility, md_path, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(claim, analysis, credibility, 'PENDING', now)
  const id = Number(r.lastInsertRowid)
  const mdPath = `md/verify/${id}.md`
  d.prepare('UPDATE verify_records SET md_path = ? WHERE id = ?').run(mdPath, id)
  mdWrite(
    mdPath,
    `# 验证：${claim}\n\n**可信度：${credibility}%** ｜ 验证时间：${now}\n\n## 分析\n${analysis}\n\n## 来源\n${keywords
      .map((k) => `- 检索关键词：${k}`)
      .join('\n')}\n`
  )
  onProgress(`验证完成，可信度 ${credibility}%`)
  return { recordId: id, credibility }
}

// ---------- LLM 可用性检查（供渲染层判断是否弹「去配置」） ----------

export function isLlmConfigured(): boolean {
  const configs = getJsonSetting<LlmConfig[]>(SettingsKeys.LlmConfigs, [])
  return configs.length > 0
}

// ---------- 推理角（推理角 specs §3：海龟汤 + 思维墙） ----------

/** 汤三件套（裁判材料：judge* / soupReview 的注入物） */
export interface TurtleSoupMaterial {
  surface: string
  bottom: string
  analysis: string
}

/** 解析 LLM 返回的 JSON 对象（兼容 ```json 包裹；json_object 模式顶层必为对象） */
function parseJsonObject(raw: string): Record<string, unknown> {
  const text = raw.replace(/^[\s\S]*?```(?:json)?\s*\n?/, '').replace(/\n?```\s*[\s\S]*$/, '').trim()
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM 未返回 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/** 剥除 LLM 回复外层 md 代码围栏 */
function stripMdFence(raw: string): string {
  return raw.replace(/^```(?:markdown|md)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
}

const DIFF_ZH: Record<string, string> = { easy: '简单', medium: '中等', hard: '困难' }

/** 难度值容错归一（easy/medium/hard 之外一律 medium） */
function normDifficulty(v: unknown): 'easy' | 'medium' | 'hard' {
  return v === 'easy' || v === 'hard' ? v : v === 'medium' ? 'medium' : 'medium'
}

export interface TurtleSoupDraft {
  title: string
  surface: string
  bottom: string
  analysis: string
  difficulty: 'easy' | 'medium' | 'hard'
  theme: string
  /** 核心诡计一句话概括（如「用前一天的旧录像伪造离场记录」）——落库防跨批同构，不进 UI */
  trick_note: string
}

/**
 * 「来 3 碗汤」：原创出 3 碗海龟汤入库（specs §3；海龟汤修改反馈——出题标准 v2 + 逐碗审题）。
 * 出题注入画像摘要 + 已有汤避免清单 + 近 9 碗诡计摘要清单（防跨批同构）；
 * 出题后逐碗串行审题（260907 二调：串行适配中转通道并发限制；260908 三调：审题升级
 * 五步推演式，硬伤才打回——常识门槛/现实逻辑硬伤/公平性硬伤/同构/极端报菜名），不合格
 * 碗携问题清单重出（260908 严格优先：上限 2 次），复审无硬伤即入碗（难度偏好仍不符时
 * 按审题人重评档如实落库，不弃碗）——弃碗不弃批，3 碗全灭才抛错；
 * 落库难度以最后一次通过审题的评定为准。
 */
export async function generateSoups(
  preference: 'random' | 'easy' | 'medium' | 'hard',
  signal?: AbortSignal
): Promise<{ generated: number; inserted: number }> {
  const d = getDb()
  const existing = d
    .prepare('SELECT title, theme_tag FROM turtle_soups ORDER BY id DESC LIMIT 200')
    .all() as { title: string; theme_tag: string }[]
  const avoidList = existing.length
    ? existing.map((r) => `- 《${r.title}》（${r.theme_tag}）`).join('\n')
    : '（暂无）'
  const recentTricks = (
    d
      .prepare('SELECT trick_note FROM turtle_soups WHERE trick_note IS NOT NULL ORDER BY id DESC LIMIT 9')
      .all() as { trick_note: string }[]
  ).map((r) => r.trick_note)
  const recentTrickList = recentTricks.length
    ? recentTricks.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '（暂无）'
  const requiredDifficulty = preference === 'random' ? undefined : preference
  const difficultyText =
    preference === 'random'
      ? '难度不限，三碗难度错开为佳'
      : `三碗均按「${DIFF_ZH[preference]}」难度出题`

  const drafts = await composeSoups(
    buildSoupPrompt({ count: 3, difficultyText, avoidList, recentTrickList }),
    3,
    signal
  )

  /** 最终入碗：落库难度一律以最后一次通过审题的评定为准 */
  const finals: { soup: TurtleSoupDraft; difficulty: 'easy' | 'medium' | 'hard' }[] = []

  // 逐碗串行：审题（重试一次兜通道抖动）→ 无硬伤即入碗；有硬伤/难度不符 → 携当次问题
  // 清单重出再审，重出上限 2 次（260908 逻辑严密性优化：严格优先），次数用尽仍不过 →
  // 弃碗不弃批。难度偏好不符只触发重出、不单独弃碗：重出过的碗（attempt≥1）复审无硬伤
  // 即按重评档如实落库（260907 二调口径）。全程串行，与全仓 LLM 调用惯例同构（中转
  // 通道有账号并发上限，并行突发会触发 429 退避共振）
  const MAX_REDO = 2
  for (const draft of drafts) {
    ensureNotCancelled(signal)
    let current = draft
    let peers = drafts.filter((o) => o !== draft).map((o) => o.trick_note)
    for (let attempt = 0; ; attempt++) {
      const review = await reviewSoupSafe(
        current,
        { recentTricks, peerTricks: peers, requiredDifficulty },
        signal
      )
      if (!review) break // 审题通道两次故障 → 弃碗
      if (review.qualityOk && (review.difficultyOk || attempt >= 1)) {
        finals.push({ soup: current, difficulty: review.ratedDifficulty })
        break
      }
      if (attempt >= MAX_REDO) break // 重出次数用尽仍不过 → 弃碗不弃批
      // 重出：random 模式补位档 = 审题人重评档（维持批内错开）；指定模式 = 偏好档；
      // 携当次问题清单与已保留碗 trick_note（批内互避），不给原碗内容（防锚定修补）
      const target = requiredDifficulty ?? review.ratedDifficulty
      try {
        const [redone] = await composeSoups(
          buildSoupPrompt({
            count: 1,
            difficultyText: `本碗按「${DIFF_ZH[target]}」难度出题`,
            avoidList,
            recentTrickList,
            redoProblems: review.problems,
            keepTricks: finals.map((f) => f.soup.trick_note)
          }),
          1,
          signal
        )
        current = redone
        peers = finals.map((f) => f.soup.trick_note)
      } catch (e) {
        // 取消异常已在 composeSoups 内先抛「已取消」，此处如实上抛不被吞
        if (signal?.aborted) throw e
        break // 重出失败 → 弃碗
      }
    }
  }

  if (finals.length === 0) {
    throw new Error('本批汤未通过审题或生成通道不稳定，未落库，请稍后重试')
  }

  ensureNotCancelled(signal)
  const now = nowIso()
  const ins = d.prepare(
    "INSERT INTO turtle_soups (title, surface, bottom, analysis, difficulty, theme_tag, trick_note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'fresh', ?, ?)"
  )
  for (const f of finals) {
    ins.run(
      f.soup.title,
      f.soup.surface,
      f.soup.bottom,
      f.soup.analysis,
      f.difficulty,
      f.soup.theme,
      f.soup.trick_note,
      now,
      now
    )
  }
  return { generated: finals.length, inserted: finals.length }
}

/** 解析出汤返回（数量与三件套齐全才算合格，否则抛错不落库；出题 3 碗、打回重出 1 碗共用） */
function parseSoupArray(raw: string, expected = 3): TurtleSoupDraft[] {
  const parsed = parseJsonObject(raw)
  const arr = Array.isArray(parsed.soups)
    ? (parsed.soups as unknown[])
    : (Object.values(parsed).find((v) => Array.isArray(v)) as unknown[] | undefined)
  if (!Array.isArray(arr)) throw new Error('LLM 未返回汤数组')
  const out: TurtleSoupDraft[] = []
  for (const item of arr as Record<string, unknown>[]) {
    if (
      item &&
      typeof item.title === 'string' &&
      typeof item.surface === 'string' &&
      typeof item.bottom === 'string' &&
      typeof item.analysis === 'string' &&
      typeof item.trick_note === 'string' &&
      item.title.trim() &&
      item.surface.trim() &&
      item.bottom.trim() &&
      item.analysis.trim() &&
      item.trick_note.trim()
    ) {
      out.push({
        title: item.title.trim(),
        surface: item.surface.trim(),
        bottom: item.bottom.trim(),
        analysis: item.analysis.trim(),
        difficulty: normDifficulty(item.difficulty),
        theme: typeof item.theme === 'string' && item.theme.trim() ? item.theme.trim() : '本格',
        trick_note: item.trick_note.trim()
      })
    }
  }
  if (out.length !== expected) {
    throw new Error(`LLM 返回 ${out.length} 碗合格汤（应为 ${expected} 碗）`)
  }
  return out
}

/** 出题 prompt v3 组装（海龟汤修改反馈2：质量标准重组为叙事层 4 + 现实逻辑层 7；巧思总纲、trick_note 产出、摘要避免清单沿用 v2） */
function buildSoupPrompt(opts: {
  count: number
  /** 难度要求句（如「三碗均按『中等』难度出题」/「本碗按『困难』难度出题」） */
  difficultyText: string
  avoidList: string
  recentTrickList: string
  /** 打回重出：审题人问题清单（不给原碗内容，防锚定修补——照思维墙打回惯例） */
  redoProblems?: string[]
  /** 打回重出：同批已保留碗的 trick_note（批内互避） */
  keepTricks?: string[]
}): string {
  const redoBlock =
    opts.redoProblems && opts.redoProblems.length > 0
      ? `\n## 上一次出的这碗汤被审题人打回，问题如下（重新出题必须全部规避）\n${opts.redoProblems
          .map((p) => `- ${p}`)
          .join('\n')}\n`
      : ''
  const keepBlock =
    opts.keepTricks && opts.keepTricks.length > 0
      ? `\n## 本碗需与以下同批已保留汤的核心诡计思路明显不同\n${opts.keepTricks
          .map((t) => `- ${t}`)
          .join('\n')}\n`
      : ''
  return `${profileDigest()}${profileDigest() ? '\n\n' : ''}你是一位资深海龟汤出题人，为一位喜欢推理的玩家原创出题。

## 已有汤清单（汤名与题材组合请避开，不得重复或高度雷同）
${opts.avoidList}

## 近期已用过的核心诡计思路（新汤的核心思路必须与它们明显不同）
${opts.recentTrickList}
${redoBlock}${keepBlock}
## 出题要求（严格执行）
1. 恰好原创 ${opts.count} 碗海龟汤。禁止搬运网传经典汤。好汤的标志是：真相揭示后，玩家回看汤面，发现每个寻常细节都另有含义——核心诡计应让多个寻常细节咬合成一个不寻常的真相。不设类型清单，思路不受任何分类束缚。
2. 每碗产出：title（汤名，2~6 字）、surface（汤面）、bottom（汤底）、analysis（裁判解析——把汤底展开讲透的完整背景：人物、时间线、动机、每个关键细节的因果，供裁判判答用）、trick_note（核心诡计一句话概括，15~40 字，如「用前一天的旧录像伪造离场记录」——只描述诡计思路本身，不复述案情）。
3. ${opts.difficultyText}；每碗自评难度（easy/medium/hard）并打一枚题材标签（theme，4~8 字，如「本格·罪案」「现代·亲情」「诡计·日常」）。
4. surface 80~200 字；bottom 150~400 字；analysis 200~500 字。${
    opts.count > 1 ? '\n5. 各碗的核心诡计思路（trick_note）彼此明显不同。' : ''
  }

## 难度定义（自评难度必须对照给出）
- easy：单层反转，关键线索在汤面中较显眼，玩家盘问较少即可逼近汤底
- medium：双层反转，或关键线索有伪装，需先排除一个误导方向
- hard：多层反转或强误导，关键线索全部隐性，需玩家自己想到盘问方向

## 质量标准（输出前逐碗自检，不合格的碗重写替换后再输出）
### 叙事层
① 常识可解：解题所需知识限于日常生活常识；专业知识可作佐证、不得作解题钥匙。自检：一个观察敏锐的普通人，不查任何资料，只凭盘问能否逼近汤底？
② 线索自然隐藏：汤面至少 3 个可供盘问的具体事实（日期、物件、身份、动作、位置等），以平常口吻织入叙事，不得集中罗列异常；其中至多一半呈现为显性异常，至少一条是隐性线索——表面完全平常，汤底揭示后含义才反转。自检：把汤面里的异常挑出来，如果一眼能挑出全部，就不合格。
③ 汤底逐一回收：汤面出现的每个元素在汤底都有解释，无悬空元素。
④ 可判定性：事实链封闭，玩家的判断类问题都能明确答「是 / 否 / 与汤无关」。
### 现实逻辑层（海龟汤修改反馈2——每条都必须在脑内实际推演一遍，不是读一遍就过）
⑤ 诡计现实可行：核心诡计在现实的物理、化学、机械、医学、空间与声学条件下逐步执行都成立，无超自然。自检：把诡计在现实里从头到尾走一遍——有没有一个环节根本行不通或概率极低（如毒物经不起烹饪高温、单颗零件让重型机械整体脱落、室内声音被隔墙听成另一方向传来）？
⑥ 时间线自洽：汤面与汤底的全部事件在同一条时间轴上无矛盾。自检：把所有事件标上时刻排成一条轴——有没有两个事件塞不进同一条轴，或某段过程必须压缩到不可能的时长？
⑦ 人物行为合理：不止对手，死者与证人的每个关键动作也要有符合其身份与处境的动机。自检：分别以死者、对手、证人的视角把各自动作链走一遍——一个正常人处在他的处境会这么做吗？
⑧ 计划可控：对手的计划不得依赖不可控的随机事件才能命中，不得靠巧合堆砌推进。自检：复盘对手的计划——有没有一步是「碰巧才会成功」？
⑨ 汤面断言有据：汤面中警方等权威的结论必须与汤底一致且有合理依据。自检：按汤底现场，警方真的会得出汤面写的那个结论吗？现场毫无他杀证据就不得写「确认是他杀」。
⑩ 公平可推导：汤底中玩家必须得知才能破案的关键事实（路线、机关、身份、手法），从汤面已有信息出发经「是/否」盘问都能到达。自检：对每个关键事实找一条从汤面出发的提问路径——找不到的就是出题人脑补。
⑪ 无伪线索：汤面每个细节在汤底要有因果上必要的解释。自检：有没有「汤底解释了但没有因果必要」的刻意误导细节（如强调某电器没开）？

以 JSON 对象返回，最外层是对象，格式：{"soups":[{"title":"...","surface":"...","bottom":"...","analysis":"...","trick_note":"...","difficulty":"easy|medium|hard","theme":"..."}]}，soups 数组内恰好 ${opts.count} 项，不要输出其他任何内容。`
}

/** 单趟出题调用 + 解析（解析失败自动重试一次，同 generateMottos 惯例；取消即抛「已取消」不重试；仍失败抛错不落库） */
async function composeSoups(prompt: string, count: number, signal?: AbortSignal): Promise<TurtleSoupDraft[]> {
  const call = () =>
    chatCompletion({ messages: [{ role: 'user', content: prompt }], temperature: 0.9, jsonMode: true, signal })
  try {
    return parseSoupArray((await call()).content, count)
  } catch (e) {
    if (signal?.aborted) throw e
    return parseSoupArray((await call()).content, count)
  }
}

export interface SoupReview {
  /** 质量判定：无硬伤 = true（线索自然/难度等主观意见不影响） */
  qualityOk: boolean
  /** 难度判定：random 模式恒 true；指定偏好时重评档与偏好档相符 = true（不符打回一次，重出后按实落库） */
  difficultyOk: boolean
  problems: string[]
  /** 审题人独立重评的难度档（落库以此为准） */
  ratedDifficulty: 'easy' | 'medium' | 'hard'
}

/**
 * 审题（半盲验证 + 五步推演，海龟汤修改反馈2）：第一步只读汤面记录玩家视角一手证据；
 * 第二步读汤底后依次做五步推演（排时间轴/物理推演/行为链/计划可控性/公平性对照），
 * 推演过程写入返回 JSON 的 steps 数组——必须先写完推演再下结论；第三步对照硬伤清单
 * 判定。立场分两层：现实逻辑与公平类「推演中说不通就是硬伤」；主观质量（诡计巧思/
 * 线索隐蔽/难度手感）默认放行。steps 仅约束 LLM 推演先行，代码不解析、缺失不影响
 * 判定。难度口径沿用 260907 二调；调用/解析失败由 reviewSoupSafe 重试一次兜底。
 */
async function reviewSoup(
  draft: TurtleSoupDraft,
  ctx: {
    recentTricks: string[]
    peerTricks: string[]
    /** 玩家指定的难度偏好（random 模式为 undefined） */
    requiredDifficulty?: 'easy' | 'medium' | 'hard'
  },
  signal?: AbortSignal
): Promise<SoupReview> {
  const targetLine = ctx.requiredDifficulty
    ? `本轮玩家指定了难度偏好「${DIFF_ZH[ctx.requiredDifficulty]}」——按定义独立重评实际难度档即可，偏差不影响 verdict（系统会另行处理）。`
    : '本轮难度不限——按定义独立重评实际难度档即可，不影响 verdict。'
  const res = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: `你是海龟汤的审题人。下面这碗汤将发给一位喜欢推理的玩家。你的立场分两层：
- 现实逻辑与公平性：**推演没做完不许下结论**。第二步的五步推演必须逐步实际执行、把过程写下来；推演中任何一步在现实里说不通就是硬伤，打回——不适用「拿不准算过」。
- 主观质量（诡计还能不能更巧妙、线索还能不能更隐蔽）：默认放行，可写进 steps 但不进 problems。

第一步：只读【汤面】，以玩家视角记下：第一直觉的猜测方向、最想盘问的 3 个问题、一眼注意到的异常。
第二步：读【汤底】【裁判解析】与【出题人自评】，依次完成五步推演：
1. 排时间轴：把汤面与汤底的所有事件标上时刻排成一条轴；检查有无前后矛盾、塞不进同一条轴、或必须压缩到不可能时长的环节。
2. 物理推演：把核心诡计在现实的物理/化学/机械/医学/空间声学条件下逐步执行，逐步写实际会发生什么；检查有无根本行不通或概率极低的环节。
3. 行为链推演：分别以死者、对手（若有）、关键证人的视角把各自动作链走一遍，为每个关键动作找动机；检查有无「一个正常人处在他的处境不会这么做」的降智动作。
4. 计划可控性：以对手视角复盘整个计划；检查有无「碰巧才会成功」的环节、有无巧合堆砌。
5. 公平性对照：列出汤底中玩家必须得知才能破案的关键事实，逐条给出「从汤面哪句话出发、经什么样的是/否问题可以问到」；再把汤面细节逐个反向过一遍，找出汤底解释牵强或无因果必要的伪线索；最后核对汤面中警方等权威断言与汤底证据是否相符。
第三步：对照硬伤清单下结论，只查以下硬伤：
1. 常识门槛：解题的关键一环必须用到需查资料的专业知识（天文、地理、法医、化学、密码学等）——普通人只凭生活常识与盘问无法逼近汤底。
2. 现实逻辑硬伤（从五步推演中来）：物理或科学上不可行 / 时间线矛盾 / 人物降智 / 对手计划靠运气或巧合 / 汤面断言无据。
3. 公平性硬伤：关键事实从汤面不可盘问可达（出题人脑补）/ 存在伪线索。
4. 同构：核心诡计思路与「近期已用思路清单」或「同批其他汤」高度相同。
5. 极端报菜名：汤面的异常一眼即可全部挑出、且没有任何一条表面平常的线索。

反面校准示例（真实漏网案例，帮你校准尺度）：
- 毒药混入电饭煲保温中的米饭杀人：持续高温下毒物分解失效，且「延迟发作」与「吃到一半即死」矛盾——物理不可行 + 时间线矛盾。
- 卸掉吊扇一颗螺母指望震动使吊扇整体坠落砸中人：机械上不成立，且坠落时机完全不可控——物理不可行 + 计划靠运气。
- 手机藏浴室通风口放歌、邻居隔着楼板听成「歌声从地下室传来」，凶手经汤面从未提及的维修通道离开：声学不成立 + 关键事实不可达。

提示性意见（写进 steps、不影响 verdict）：线索呈现是否自然；难度按「easy=单层反转线索较显眼 / medium=双层反转或线索有伪装需排除误导 / hard=多层反转或强误导关键线索全隐性」独立重评。${targetLine}

【汤面】
${draft.surface}

【汤底】
${draft.bottom}

【裁判解析】
${draft.analysis}

【出题人自评】难度：${DIFF_ZH[draft.difficulty]}；题材：${draft.theme}；核心诡计思路：${draft.trick_note}

## 近期已用思路清单
${ctx.recentTricks.length ? ctx.recentTricks.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（暂无）'}

## 同批其他汤的核心思路
${ctx.peerTricks.length ? ctx.peerTricks.map((s) => `- ${s}`).join('\n') : '（无）'}

只输出 JSON：{"steps":["玩家视角记录…","排时间轴…","物理推演…","行为链推演…","计划可控性…","公平性对照…"],"verdict":"pass|fail","ratedDifficulty":"easy|medium|hard","problems":["硬伤1","硬伤2"]}。steps 六项依次为第一步玩家视角记录与第二步五步推演的过程，必须先写完 steps 再给 verdict；verdict 为 fail 当且仅当发现上述硬伤；problems 仅在 fail 时非空、只列硬伤不列主观意见。`
      }
    ],
    temperature: 0.2,
    jsonMode: true,
    signal
  })
  const parsed = parseJsonObject(res.content)
  const problems = Array.isArray(parsed.problems)
    ? parsed.problems.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    : []
  const rated = normDifficulty(parsed.ratedDifficulty)
  const qualityOk = parsed.verdict === 'pass' && problems.length === 0
  const difficultyOk = !ctx.requiredDifficulty || rated === ctx.requiredDifficulty
  if (qualityOk && !difficultyOk) {
    problems.push(
      `难度复核为「${DIFF_ZH[rated]}」，与玩家指定的「${DIFF_ZH[ctx.requiredDifficulty!]}」不符`
    )
  }
  return { qualityOk, difficultyOk, problems, ratedDifficulty: rated }
}

/** 审题调用 + 解析（失败自动重试一次；两次均失败返回 null = 弃碗——通道故障与汤质量无关） */
async function reviewSoupSafe(
  draft: TurtleSoupDraft,
  ctx: {
    recentTricks: string[]
    peerTricks: string[]
    requiredDifficulty?: 'easy' | 'medium' | 'hard'
  },
  signal?: AbortSignal
): Promise<SoupReview | null> {
  try {
    return await reviewSoup(draft, ctx, signal)
  } catch (e) {
    if (signal?.aborted) throw e
    try {
      return await reviewSoup(draft, ctx, signal)
    } catch (e2) {
      if (signal?.aborted) throw e2
      return null
    }
  }
}

/**
 * 存量汤诡计摘要一次性回填（海龟汤修改反馈）：启动后 fire-and-forget，
 * 全量（含已玩过/回收站软删——软删汤思路同样算「已用过」）为 trick_note 为 NULL
 * 的汤补一句核心诡计概括。失败静默（console.warn）下次启动再试；LLM 未配置跳过；
 * 跑完即无、不建定时器。
 */
export async function backfillTrickNotes(): Promise<void> {
  try {
    const d = getDb()
    const rows = d
      .prepare('SELECT id, title, bottom FROM turtle_soups WHERE trick_note IS NULL')
      .all() as { id: number; title: string; bottom: string }[]
    if (rows.length === 0) return
    const res = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: `为下列海龟汤各写一句「核心诡计思路」概括（trick_note）：只描述诡计思路本身（如「用前一天的旧录像伪造离场记录」），不复述案情、不评价质量，每句 15~40 字。

${rows.map((r) => `# ${r.id}《${r.title}》\n汤底：${r.bottom}`).join('\n\n')}

以 JSON 对象返回：{"notes":[{"id":1,"trick_note":"..."}]}，数组恰好 ${rows.length} 项，id 与上表一致，不要输出其他任何内容。`
        }
      ],
      temperature: 0.2,
      jsonMode: true
    })
    const parsed = parseJsonObject(res.content)
    if (!Array.isArray(parsed.notes)) return
    const upd = d.prepare('UPDATE turtle_soups SET trick_note = ? WHERE id = ? AND trick_note IS NULL')
    for (const n of parsed.notes as Record<string, unknown>[]) {
      if (n && typeof n.id === 'number' && typeof n.trick_note === 'string' && n.trick_note.trim()) {
        upd.run(n.trick_note.trim(), n.id)
      }
    }
  } catch (e) {
    console.warn('[backfillTrickNotes] 存量汤诡计摘要回填失败，下次启动再试：', e)
  }
}

export interface SoupAskResult {
  type: 'yes' | 'no' | 'irrelevant' | 'invalid'
  reply: string
}

/** 裁判系统提示（judgeSoupQuestion / judgeSoupGuess 共用的材料与协议头） */
function soupJudgeSystem(material: TurtleSoupMaterial): string {
  return `你是海龟汤对局的裁判，掌握该汤的全部材料，严格依据材料判答。

【汤面】
${material.surface}

【汤底】
${material.bottom}

【裁判解析（汤底的完整背景，判答以此为准）】
${material.analysis}`
}

/**
 * 对局判问（specs §3）：玩家提问 → 只答「是 / 否 / 与汤无关」；
 * 非判断句引导改问法（type=invalid，不计有效问答）。判答不注入画像。
 */
export async function judgeSoupQuestion(
  material: TurtleSoupMaterial,
  historyText: string,
  question: string,
  signal?: AbortSignal
): Promise<SoupAskResult> {
  const system = `${soupJudgeSystem(material)}

## 判答规则
1. 玩家的提问是判断类问题（能用「是 / 否」回答）时，依据汤底与裁判解析判断：type 为 yes 或 no；若所问内容与汤底无关（材料无法判断），type 为 irrelevant。
2. 玩家的提问不是判断句（如开放式的「他们怎么死的」「为什么」），type 为 invalid，reply 固定为「请提能用是/否回答的问题」。
3. reply 用一句复述式中文作答（如「否，这两个人不是互相杀害」「是，屋子里只有他们两个人」「与汤底无关」），除复述所问内容外不添加汤面汤底之外的新信息，绝不主动剧透汤底。
4. 只输出 JSON：{"type":"yes|no|irrelevant|invalid","reply":"..."}，不要输出其他任何内容。`
  const history = historyText ? `## 已有问答（供衔接，勿重复解答）\n${historyText}\n\n` : ''
  const res = await chatCompletion({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${history}## 本次提问\n${question}` }
    ],
    temperature: 0.2,
    jsonMode: true,
    signal
  })
  const parsed = parseJsonObject(res.content)
  const t = parsed.type
  if (t !== 'yes' && t !== 'no' && t !== 'irrelevant' && t !== 'invalid') {
    throw new Error('LLM 返回格式异常（type 非法）')
  }
  const reply =
    typeof parsed.reply === 'string' && parsed.reply.trim()
      ? parsed.reply.trim()
      : t === 'invalid'
        ? '请提能用是/否回答的问题'
        : t === 'irrelevant'
          ? '与汤底无关'
          : t === 'yes'
            ? '是'
            : '否'
  return { type: t, reply }
}

export interface SoupGuessResult {
  solved: boolean
  hits: string[]
  misses: string[]
  feedback: string
}

/**
 * 猜汤底判定（specs §3）：判「破汤 / 未破」；未破给方向反馈（命中点 + 偏差点），
 * 绝不泄露关键缺失信息。判答不注入画像。
 */
export async function judgeSoupGuess(
  material: TurtleSoupMaterial,
  historyText: string,
  reasoning: string,
  signal?: AbortSignal
): Promise<SoupGuessResult> {
  const system = `${soupJudgeSystem(material)}

## 判定规则
1. 判定推理是否「破汤」：抓住汤底的核心真相（关键人物身份、关键事件因果，依据裁判解析自行把握什么算核心）即 solved=true；只对边缘细节、未触及核心真相的，solved=false。
2. solved=false 时给方向反馈：hits = 推理中已命中的点（每条一句话）；misses = 明显偏离的方向（每条一句话）；feedback = 一句总评。绝不把汤底中尚未被发现的关键点直接说出来（不泄露关键缺失信息）。
3. solved=true 时 hits 列出命中的关键点，feedback 一句祝贺式总评。
4. 只输出 JSON：{"solved":true/false,"hits":["..."],"misses":["..."],"feedback":"..."}，不要输出其他任何内容。`
  const history = historyText ? `## 已有问答\n${historyText}\n\n` : ''
  const res = await chatCompletion({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${history}## 我的推理（猜汤底）\n${reasoning}` }
    ],
    temperature: 0.2,
    jsonMode: true,
    signal
  })
  const parsed = parseJsonObject(res.content)
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
  return {
    solved: parsed.solved === true,
    hits: strArr(parsed.hits),
    misses: strArr(parsed.misses),
    feedback: typeof parsed.feedback === 'string' ? parsed.feedback.trim() : ''
  }
}

/**
 * 局终点评（specs §3，破汤弃汤都点评）：提问效率——哪个问题问在关键上、哪些是浪费、
 * 推理链评价；弃汤加指出卡点。输出 md 片段（200 字内）。点评不注入画像。
 */
export async function soupReview(
  material: TurtleSoupMaterial,
  transcript: string,
  result: 'solved' | 'abandoned',
  questionCount: number,
  signal?: AbortSignal
): Promise<string> {
  const prompt = `${soupJudgeSystem(material)}

## 局终点评任务
本局已结束：${result === 'solved' ? `已破汤（第 ${questionCount} 个有效提问后破汤）` : `弃汤（共 ${questionCount} 个有效提问未破，玩家放弃并看了汤底）`}。

## 问答全程
${transcript || '（本局无提问）'}

请以教练口吻写局终点评，简体中文 Markdown 直接输出正文（不要标题、不要代码块，200 字以内）：
1. 提问效率：哪个问题问在了关键上、哪些是浪费（重复、过宽、方向错误）；
2. 推理链评价：玩家推理路径的质量；
3. ${result === 'abandoned' ? '指出卡点：玩家最接近真相的时刻与偏离处，以及当时本该问的问题方向（局已结束，现在可以说透）。' : '一句收尾建议。'}`
  const res = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
    signal
  })
  const md = stripMdFence(res.content)
  if (!md) throw new Error('LLM 未返回内容')
  return md
}

export interface WallPuzzleDraft {
  type: 'detective_case' | 'lateral_puzzle' | 'word_logic' | 'life_logic'
  puzzle: string
  answer: string
  /** 标准论证全文（两阶段审题与判答讲解共用，随题落库） */
  reasoning: string
  hints: string[]
  difficulty: 'easy' | 'medium' | 'hard'
}

export type WallPuzzleType = WallPuzzleDraft['type']

/** 思维游戏题型池（v1.6 题型换血：三个数学题型全部退池，不出数学理论题） */
export const WALL_TYPE_LIST: readonly WallPuzzleType[] = [
  'detective_case',
  'lateral_puzzle',
  'word_logic',
  'life_logic'
]

const WALL_TYPE_ZH_FULL: Record<WallPuzzleType, string> = {
  detective_case: '侦探断案',
  lateral_puzzle: '情境谜题',
  word_logic: '文字谜题',
  life_logic: '生活逻辑'
}

/**
 * 思维墙出题（specs §3，v1.6 思维游戏题型换血）：四题型（侦探断案 / 情境谜题 /
 * 文字谜题 / 生活逻辑），难度按线索复杂度与误导强度标定，脑筋急转弯与模板套皮
 * 题任何档位不合格。两阶段管线不变：出题 → 审题（独立验证结论正确 / 唯一 /
 * 可解 / 难度达标，不过打回重出一次，仍不过抛错不落库）。避免清单注入近期题面
 * 摘要防同构重复。出题注入画像摘要。
 */
export async function generateWallPuzzle(
  difficulty: 'easy' | 'medium' | 'hard',
  opts?: { type?: WallPuzzleType; avoid?: string[] },
  signal?: AbortSignal
): Promise<WallPuzzleDraft> {
  const type: WallPuzzleType =
    opts?.type ?? WALL_TYPE_LIST[Math.floor(Math.random() * WALL_TYPE_LIST.length)]
  const avoidBlock =
    opts?.avoid && opts.avoid.length > 0
      ? `\n## 避免与以下近期题目同构（题材 / 结构 / 答案思路都不得雷同）\n${opts.avoid
          .map((s, i) => `${i + 1}. ${s}`)
          .join('\n')}\n`
      : ''
  const basePrompt = `${profileDigest()}${profileDigest() ? '\n\n' : ''}你是顶尖的思维游戏命题人，为思维墙出一道「答案需要被解题者推理出来」的思维游戏题。核心禁令：不出数学理论题（不变量/概率/数论/组合计算一律不合格），不出「套路 + 表面装饰」的题——纯真假话列表逐条排除、纯网格排除、看破套路后机械操作即解的题不合格。

## 题型（本次出：${WALL_TYPE_ZH_FULL[type]}）
- detective_case 侦探断案：案情/场景叙述，破绽藏在细节里——证词矛盾、时间线不对、不可能知道的信息；任务是还原真相或指认说谎者。题面需给出多方证词与物证细节
- lateral_puzzle 情境谜题：一个奇怪的现象问「为什么」，答案需要换掉一个默认假设才能想通；必须有唯一合理解（题面约束充分，独立推理可解，不是开放猜测）。与脑筋急转弯的区别：答案推得出来，不是靠冷知识
- word_logic 文字谜题：字谜、密码、索引、藏字、语言逻辑、文字规律——纯语言文字游戏，零数学符号。解码方式必须可被题面唯一确定，索引无歧义
- life_logic 生活逻辑：生活情境里的推理——谁先推断出什么、信息在人与人之间如何传递、沉默与行为本身携带信息；题面是故事不是符号。真假话列表换生活皮的模板题仍不合格

## 难度标定（严格执行，难度来自推理链深度与误导强度，而非信息量堆砌）
- 简单：单一关键洞察，但伪装到位——题面有一个「顺理成章的错误解释」挡在真相前面，戳破它才能解题。说破就懂、没有推理过程的脑筋急转弯不合格
- 中等：多条线索交织，至少一条主动埋设的误导；或需要连续两次转换默认假设；表面解释与真相要有真实的迷惑性竞争
- 困难：完整推理链（需整合 4 处以上细节）+ 强误导；单条线索都不致命，合起来才能唯一锁定真相；或需要发明一个解释框架统一所有异常（侦探的「唯一假设」方法）
${avoidBlock}
## 硬性质量标准（输出前逐条自检，不合格重写）
1. 答案唯一可判定（明确结论/指认/谜底），存在另一个同样说得通的答案即不合格
2. 题面自包含，无需外部知识；所有关键线索都在题面中给出
3. 禁止可被「标准模板」直接套解；禁止脑筋急转弯（答案靠冷知识而非推理）
4. 至少一条「看似可行的错误解释/误导线索」，走进去会得到错误结论
5. hints 恰好 3 条递进：一级指方向 → 二级点方法 → 三级给关键一步，任何一级都不直接给出答案
6. reasoning 为标准论证全文（可分步，200~500 字），完整闭合、无跳步
7. puzzle 用 Markdown 纯文本（可分行、可列表），不要用表格；本次目标难度：${DIFF_ZH[difficulty]}

只输出 JSON：{"puzzle":"题面全文","answer":"标准结论（简短明确）","reasoning":"标准论证全文","hints":["提示1","提示2","提示3"]}，不要输出其他任何内容。`

  let draft = await composeWallPuzzle(type, difficulty, basePrompt, signal)
  // 阶段二：审题人独立验证，不过打回重出一次（问题清单回注 prompt），仍不过抛错
  const v1 = await verifyWallPuzzle(draft, difficulty, signal)
  if (!v1.ok) {
    ensureNotCancelled(signal)
    draft = await composeWallPuzzle(
      type,
      difficulty,
      `${basePrompt}\n\n## 上一次出的题被审题人打回，问题如下（重新出题必须全部规避）\n${v1.problems
        .map((p) => `- ${p}`)
        .join('\n')}`,
      signal
    )
    const v2 = await verifyWallPuzzle(draft, difficulty, signal)
    if (!v2.ok) throw new Error('出题未通过审题验证（两次），不落库')
  }
  return draft
}

/** 阶段一：单趟出题 + 解析（字段缺失抛错） */
async function composeWallPuzzle(
  type: WallPuzzleType,
  difficulty: 'easy' | 'medium' | 'hard',
  prompt: string,
  signal?: AbortSignal
): Promise<WallPuzzleDraft> {
  const res = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.9,
    jsonMode: true,
    signal
  })
  const parsed = parseJsonObject(res.content)
  const puzzle = typeof parsed.puzzle === 'string' ? parsed.puzzle.trim() : ''
  const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : ''
  const reasoning =
    typeof parsed.reasoning === 'string' ? stripMdFence(parsed.reasoning).trim() : ''
  const hints = Array.isArray(parsed.hints)
    ? parsed.hints.filter((h): h is string => typeof h === 'string' && h.trim() !== '').slice(0, 3)
    : []
  if (!puzzle || !answer || !reasoning || hints.length === 0) {
    throw new Error('LLM 返回题目字段缺失')
  }
  return { type, puzzle, answer, reasoning, hints: hints.map((h) => h.trim()), difficulty }
}

/**
 * 阶段二：审题（半盲验证）——审题人只看题面 + 命题人给出的标准结论（不给标准论证），
 * 必须独立重新推演。四关全过才 pass：结论正确 / 结论唯一 / 条件自洽可解 / 实际难度达标。
 */
async function verifyWallPuzzle(
  draft: WallPuzzleDraft,
  target: 'easy' | 'medium' | 'hard',
  signal?: AbortSignal
): Promise<{ ok: boolean; problems: string[] }> {
  const res = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: `你是苛刻的审题人。下面这道洞察推理题将发给一位很强的解题者，请独立严格审查——必须自己重新推演，不得默认命题人正确。

【题面】
${draft.puzzle}

【命题人给出的标准结论】
${draft.answer}

审查四关：
1. 结论正确：独立推演（文字题须逐字数、逐索引核对），标准结论是否真的成立
2. 结论唯一：是否存在另一个同样说得通的答案或实质不同的等价结论；情境谜题重点审「题面约束是否足以排除其他合理解」，文字谜题重点审「解码方式是否唯一无歧义」
3. 条件自洽完备：仅凭题面能否推出结论，有无缺条件或内部矛盾
4. 难度达标：按「简单=单一洞察+伪装到位（脑筋急转弯不合格）/ 中等=多线索交织或含主动误导 / 困难=完整推理链+强误导+唯一假设法」评估实际难度档；能否被「标准模板」直接套解（能则不合格）；是否数学理论题或冷知识题（是则不合格）

只输出 JSON：{"verdict":"pass|fail","ratedDifficulty":"easy|medium|hard","problems":["问题1","问题2"]}。四关全过才 pass；目标难度档：${DIFF_ZH[target]}，ratedDifficulty 低于目标档即 fail；problems 仅在 fail 时非空。`
      }
    ],
    temperature: 0.2,
    jsonMode: true,
    signal
  })
  const parsed = parseJsonObject(res.content)
  const problems = Array.isArray(parsed.problems)
    ? parsed.problems.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    : []
  return { ok: parsed.verdict === 'pass' && problems.length === 0, problems }
}

export interface WallAnswerResult {
  correct: boolean
  explanation: string
}

/**
 * 思维墙判答（specs §3，v1.6 题型语境版）：宽松等价——结论实质相同即算对
 * （侦探断案=同一真相/说谎者指认；情境谜题=同一机制解释；文字谜题=同一谜底；
 * 生活逻辑=同一结论或等价推理结果）；只给结论不论证也算对，
 * 附带论证时讲解中顺带点评但不因论证简陋判错。无论对错都输出完整讲解
 * （判定理由 + 标准论证）。判答不注入画像。
 */
export async function judgeWallAnswer(
  puzzleText: string,
  standardAnswer: string,
  standardReasoning: string,
  myAnswer: string,
  typeZh: string,
  signal?: AbortSignal
): Promise<WallAnswerResult> {
  const prompt = `你是思维墙的判答员，本题题型为「${typeZh}」。宽松等价判定：玩家答案与标准答案表述不同但实质等价（侦探断案=同一真相指认或同一说谎者指认 / 情境谜题=同一机制解释 / 文字谜题=同一谜底（谐音字酌情算对）/ 生活逻辑=同一结论或等价推理结果）即算对；仅当结论实质不同才判错。

【题面】
${puzzleText}

【标准答案】
${standardAnswer}

【标准论证】
${standardReasoning}

【我的作答】
${myAnswer}

explanation 用简体中文 Markdown（150~400 字，不用表格）：先给判定与理由（玩家若附带论证，顺带点评其论证的亮点或漏洞，但不因论证问题改变判定——以结论为准），再完整给出标准论证。
只输出 JSON：{"correct":true/false,"explanation":"..."}，不要输出其他任何内容。`
  const res = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    jsonMode: true,
    signal
  })
  const parsed = parseJsonObject(res.content)
  const explanation = typeof parsed.explanation === 'string' ? stripMdFence(parsed.explanation) : ''
  if (!explanation) throw new Error('LLM 返回讲解缺失')
  return { correct: parsed.correct === true, explanation }
}

/** 本地日期串 YYYY-MM-DD（思维墙「一天一题」的键） */
export function localDateStr(t: Date = new Date()): string {
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

/**
 * 思维墙连胜（specs §1）：连续「答对」天数——今日已答对则含今日，否则从昨日起算；
 * 今日答错或中断（无 correct）即止。答错连胜清零、次日回 easy 难度。
 */
export function wallStreak(): number {
  const rows = getDb()
    .prepare('SELECT date, status FROM wall_puzzles ORDER BY date DESC LIMIT 4000')
    .all() as { date: string; status: string }[]
  const map = new Map(rows.map((r) => [r.date, r.status]))
  const cursor = new Date()
  if (map.get(localDateStr(cursor)) !== 'correct') cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  for (;;) {
    if (map.get(localDateStr(cursor)) !== 'correct') break
    streak++
    cursor.setDate(cursor.getDate() - 1)
    if (streak > 3650) break // 保险上限
  }
  return streak
}
