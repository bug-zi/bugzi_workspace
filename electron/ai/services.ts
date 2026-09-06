// AI 业务服务（主进程）：格言生成、知识卡片生成、AI 边栏对话、辩真验证
import { getDb, nowIso, normalizeText, isDupMotto } from '../db/db'
import { getSetting, setSetting, getJsonSetting } from '../db/settings'
import { chatCompletion, LlmNotConfiguredError } from './llm'
import { mdRead, mdWrite, mdCreate } from '../services/files'
import { SettingsKeys } from '../../src/shared/types'
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
export async function compactAiSession(sessionId: number): Promise<AiSession> {
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
    temperature: 0.3
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
  '当你从对话中识别到关于用户本人的稳定信息（专业背景、学习方向、职业规划、偏好习惯、价值观、人生观等，且下方画像索引尚未覆盖）时，在回复的最末尾另起一行输出标记：<<<PROFILE_SUGGEST:类别|内容>>>（类别从 专业背景/学习方向/职业规划/偏好习惯/价值观/其他 中选择，内容一句话概括）；没有可补充的就绝不输出该标记。'

/** 画像检索协议标记（优化建议区第13轮「记忆化」）：AI 需要时输出 <<<PROFILE_LOOKUP:关键词>>> 索取详情 */
const PROFILE_LOOKUP_RE = /^<<<PROFILE_LOOKUP:([^>]+?)>>>\s*$/m

/** 画像检索指令（边栏对话）：只带索引，详情按需索取——避免全量注入干扰注意力 */
const PROFILE_LOOKUP_INSTRUCTION =
  '你对用户本人有一份画像索引（见下）。当且仅当需要了解更多用户信息才能更好地完成任务时，先在回复中单独一行输出检索标记：<<<PROFILE_LOOKUP:关键词>>>（如 <<<PROFILE_LOOKUP:学习方向>>>），系统会把画像中相关条目提供给你，你再继续完成回答；不需要时直接作答，绝不输出该标记。'

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
  channel: AiChannel = 'assistant'
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
    `你是「bug子的workspace」个人工作台的 AI 助手。用户当前所在模块：${moduleLabel}。`,
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
    temperature: 0.8
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
}

/** kind 缺失/非法时按出处含「AI 编撰」推断（v2.0 §7.3 解析容错） */
function mottoKind(kind: string | undefined, source: string): 'excerpt' | 'composed' {
  if (kind === 'excerpt' || kind === 'composed') return kind
  return /ai\s*编撰/i.test(source) ? 'composed' : 'excerpt'
}

/** 「来10条格言」（v2.0：5 摘录 + 5 编撰）：正式区风格样本 → LLM 生成 → 增强查重入库草稿区 */
export async function generateMottos(): Promise<GenerateMottosResult> {
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
  const prompt = `${profileDigest()}${profileDigest() ? '\n\n' : ''}以下是我的格言库正式区已有的格言（风格样本）：\n${samples}\n\n请参考这些格言的风格与题材，生成 10 条新格言：恰好 5 条摘录自现实书籍作品的名言（kind 为 "excerpt"，source 标真实出处，如书名/作者），恰好 5 条由你自行编撰（kind 为 "composed"，source 标「AI 编撰」）。\n\n以下是我已有的全部格言清单，你生成的内容不得与清单中任何一条重复，也不得仅对清单条目作微小改写：\n${avoidList}\n\n以 JSON 对象返回，最外层是对象，格式：{"mottos":[{"content":"格言正文","source":"出处","kind":"excerpt 或 composed"}]}，mottos 数组内恰好 10 项（5 条 excerpt + 5 条 composed），不要输出其他任何内容。`
  const res = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.9,
    jsonMode: true
  })
  let items: { content: string; source: string; kind?: string }[]
  try {
    items = parseJsonArray(res.content)
  } catch {
    // 解析失败自动重试一次（specs §3.1）
    const retry = await chatCompletion({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      jsonMode: true
    })
    items = parseJsonArray(retry.content)
  }
  // 入库前查重（§7.4.2/§7.4.3）：规范化一致或互为子串（长度门槛内）即重复；
  // 比对集合 = 三区 + 回收站全部格言，且随本批插入逐步扩充（批内互斥）
  const allNorms = existingRows.map((r) => normalizeText(r.content))
  const now = nowIso()
  // 插到草稿区开头（优化建议区「序号+拖拽排序」决策：新格言插区首）：
  // 逐条 MIN(sort)-1 递减，先插入的排更前
  let headSort = (
    d.prepare("SELECT MIN(sort) AS m FROM mottos WHERE status = 'draft' AND deleted_at IS NULL").get() as {
      m: number | null
    }
  ).m
  if (headSort == null) headSort = 1
  const ins = d.prepare(
    "INSERT INTO mottos (content, source, status, origin, gen_kind, sort, tags, created_at, updated_at) VALUES (?, ?, 'draft', 'ai', ?, ?, '[]', ?, ?)"
  )
  let inserted = 0
  let excerptInserted = 0
  let composedInserted = 0
  for (const it of items) {
    const key = normalizeText(it.content)
    if (!key || isDupMotto(allNorms, key)) continue
    allNorms.push(key)
    headSort -= 1
    // gen_kind 落库（DB v6）：驱动 AI 徽章仅编撰条显示、摘录条不打
    const kind = mottoKind(it.kind, it.source)
    ins.run(it.content, it.source, kind, headSort, now, now)
    if (kind === 'composed') composedInserted++
    else excerptInserted++
    inserted++
  }
  return { generated: items.length, inserted, excerptInserted, composedInserted }
}

// ---------- 灵感泉 v2.0（灵感泉 specs §6：从零生成 + AI 完善） ----------

/** 解析 LLM 返回的灵感数组（兼容 ```json 与 {"inspirations":[...]} 对象包裹，同 parseJsonArray 容错） */
function parseInspirationArray(raw: string): { title: string; summary: string }[] {
  const text = raw.replace(/^[\s\S]*?```(?:json)?\s*\n?/, '').replace(/\n?```\s*[\s\S]*$/, '').trim()
  let parsed: unknown = JSON.parse(text)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    parsed = Object.values(parsed).find((v) => Array.isArray(v)) ?? parsed
  }
  if (!Array.isArray(parsed)) throw new Error('LLM 未返回 JSON 数组')
  const out: { title: string; summary: string }[] = []
  for (const item of parsed) {
    // title/summary 任一缺失或空白即跳过（specs §6.2 解析容错）
    if (
      item &&
      typeof item.title === 'string' &&
      typeof item.summary === 'string' &&
      item.title.trim() &&
      item.summary.trim()
    ) {
      out.push({ title: item.title.trim(), summary: item.summary.trim() })
    }
  }
  if (out.length === 0) throw new Error('LLM 返回数组为空或字段缺失')
  return out
}

/** 读灵感 md 正文（跳过首行 `# 标题`；读失败返回空串），截 maxLen 字；flatten 时压缩空白（画像单行场景） */
function inspirationBody(mdPath: string, maxLen: number, flatten: boolean): string {
  let raw: string
  try {
    raw = mdRead(mdPath)
  } catch {
    return ''
  }
  const body = raw.replace(/^#\s.*\n?/, '').trim()
  return (flatten ? body.replace(/\s+/g, ' ') : body).slice(0, maxLen).trim()
}

export interface GenerateInspirationsResult {
  generated: number
  inserted: number
}

/** 「来5条灵感」（specs §6.2）：已有灵感画像 → LLM 生成 5 条标题+简介 → 标题查重入草稿区（origin='ai'） */
export async function generateInspirations(): Promise<GenerateInspirationsResult> {
  const d = getDb()
  // 兴趣画像：全部未删除灵感（四区含归档），最近更新 50 条；正文截 100 字
  const profileRows = d
    .prepare(
      'SELECT title, md_path FROM inspirations WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50'
    )
    .all() as { title: string; md_path: string }[]
  const profile = profileRows.length
    ? profileRows
        .map((r) => {
          const body = inspirationBody(r.md_path, 100, true)
          return body ? `- ${r.title}：${body}` : `- ${r.title}`
        })
        .join('\n')
    : '（暂无已有灵感，可自由发散各类项目创意）'
  // 避免清单（specs §6.2）：全部标题（含回收站，不过滤 deleted_at），最多 500 条防 prompt 超长
  const existingRows = d
    .prepare('SELECT title FROM inspirations ORDER BY updated_at DESC LIMIT 500')
    .all() as { title: string }[]
  const avoidList = existingRows.length ? existingRows.map((r) => `- ${r.title}`).join('\n') : '（暂无）'
  const prompt = `${profileDigest()}${profileDigest() ? '\n\n' : ''}以下是我的灵感泉里已有的项目灵感（兴趣画像）：\n${profile}\n\n以下清单里的方向请勿重复或高度雷同：\n${avoidList}\n\n请参考我的兴趣画像，生成恰好 5 条新的项目灵感。每条包含：\n- title：灵感标题（10~25 字，具体、可执行，不要空泛口号）\n- summary：一句话简介（≤50 字，说明这是什么、有什么价值）\n\n以 JSON 对象返回，最外层是对象，格式：{"inspirations":[{"title":"...","summary":"..."}]}，inspirations 数组内恰好 5 项，不要输出其他任何内容。`
  const res = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.9,
    jsonMode: true
  })
  let items: { title: string; summary: string }[]
  try {
    items = parseInspirationArray(res.content)
  } catch {
    // 解析失败自动重试一次（同 generateMottos）
    const retry = await chatCompletion({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      jsonMode: true
    })
    items = parseInspirationArray(retry.content)
  }
  // 入库：标题精确查重（含回收站 + 批内互斥）→ 插草稿区末尾（specs §6.2，与 moveTo 区末尾语义一致）
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
    mdCreate(mdPath, `# ${it.title}\n\n${it.summary}\n`)
    inserted++
  }
  return { generated: items.length, inserted }
}

/** AI 完善（specs §6.3）：基于标题+正文生成三小节扩展建议；只生成不写库，追加由 inspirations:appendRefine 完成 */
export async function refineInspiration(id: number): Promise<string> {
  const row = getDb().prepare('SELECT title, md_path FROM inspirations WHERE id = ?').get(id) as
    | { title: string; md_path: string }
    | undefined
  if (!row) throw new Error('NOT_FOUND')
  const body = inspirationBody(row.md_path, 4000, false) || '（正文暂空）'
  const prompt = `${profileDigest()}${profileDigest() ? '\n\n' : ''}以下是我的一个项目灵感：\n标题：${row.title}\n正文：\n${body}\n\n请基于这个灵感生成扩展建议，用简体中文 Markdown 输出，只输出以下三个小节（### 三级标题），不要输出其他任何内容：\n### 思路延伸\n（2~4 个可深化的方向，每个一句话）\n### 潜在难点\n（2~3 条）\n### 下一步行动\n（2~3 条具体可执行的事）`
  const res = await chatCompletion({ messages: [{ role: 'user', content: prompt }], temperature: 0.7 })
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
export async function suggestWikiTerm(sectionId: number | null): Promise<{ sectionId: number; term: string }> {
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
    temperature: 1.0
  })
  const term = res.content.trim().replace(/^["'《]|["'》]$/g, '')
  if (!term) throw new Error('未能生成词条名')
  return { sectionId: section.id, term }
}

/** 生成知识卡片 md（固定模板，specs §3.1），并建词条记录 */
export async function generateWikiCard(term: string | null, sectionId: number | null): Promise<GenerateWikiResult> {
  const d = getDb()
  // 词条名缺省：LLM 构思（板块 = 指定板块，未指定则随机挑）
  if (!term) {
    const suggested = await suggestWikiTerm(sectionId)
    sectionId = suggested.sectionId
    term = suggested.term
  }
  // 查重（手动输入场景已拦截，随机场景兜底）
  const dup = d
    .prepare('SELECT id FROM wiki_entries WHERE term = ? AND deleted_at IS NULL')
    .get(term)
  if (dup) throw new Error('CONFLICT:' + term)
  const prompt = `${profileDigest()}${profileDigest() ? '\n\n' : ''}请为词条「${term}」生成一张知识卡片，Markdown 格式，严格按以下模板输出（每个二级标题必须有内容，不要输出模板外的任何内容）：\n\n# ${term}\n\n## 一句话定义\n{一句话定义}\n\n## 详细解释\n{详细解释}\n\n## 举例\n{举例}\n\n## 启示\n{启示}`
  const res = await chatCompletion({ messages: [{ role: 'user', content: prompt }], temperature: 0.7 })
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
export async function generateWikiQuiz(): Promise<WikiQuizQuestion[]> {
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
    jsonMode: true
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
  onProgress: (msg: string) => void
): Promise<VerifyResult> {
  // 动态 import 避免循环依赖
  const { findSearchTool } = await import('./mcp')
  onProgress(`开始验证：${claim}`)
  const found = await findSearchTool(onProgress)
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
    temperature: 0.5
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
    temperature: 0.3
  })
  const full = analysisRes.content
  const m = full.match(/可信度[：:]\s*(\d{1,3})\s*%/)
  const credibility = Math.max(0, Math.min(100, m ? Number(m[1]) : 50))
  const analysis = (m ? full.replace(/可信度[：:]\s*\d{1,3}\s*%/, '').trim() : full).trim()

  // 4) 写记录 + md
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
