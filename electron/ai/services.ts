// AI 业务服务（主进程）：格言生成、知识卡片生成、AI 边栏对话、辩真验证
import { getDb, nowIso, normalizeText, isDupMotto } from '../db/db'
import { getSetting, setSetting, getJsonSetting } from '../db/settings'
import { chatCompletion, LlmNotConfiguredError } from './llm'
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

/** kind 缺失/非法时按出处推断（v2.0 §7.3 解析容错）：编撰条 v10 起署名 debugzi，旧格式「AI 编撰」仍兼容 */
function mottoKind(kind: string | undefined, source: string): 'excerpt' | 'composed' {
  if (kind === 'excerpt' || kind === 'composed') return kind
  return /(?:ai\s*编撰|debugzi)/i.test(source) ? 'composed' : 'excerpt'
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
  const prompt = `${profileDigest()}${profileDigest() ? '\n\n' : ''}以下是我的格言库正式区已有的格言（风格样本）：\n${samples}\n\n请参考这些格言的风格与题材，生成 10 条新格言：恰好 5 条摘录自现实书籍作品的名言（kind 为 "excerpt"，source 标真实出处，如书名/作者），恰好 5 条由你自行编撰（kind 为 "composed"，source 标「debugzi」）。\n\n以下是我已有的全部格言清单，你生成的内容不得与清单中任何一条重复，也不得仅对清单条目作微小改写：\n${avoidList}\n\n以 JSON 对象返回，最外层是对象，格式：{"mottos":[{"content":"格言正文","source":"出处","kind":"excerpt 或 composed"}]}，mottos 数组内恰好 10 项（5 条 excerpt + 5 条 composed），不要输出其他任何内容。`
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

export interface GenerateInspirationsResult {
  generated: number
  inserted: number
}

/**
 * 「来5条灵感」（specs §6.2；优化建议区第18轮两阶段重构）：
 * 阶段一发散——12 条粗点子（形态分散、禁模板句式）；阶段二自评——四维评审挑 5 条打磨简介。
 * 口味注入：手动指引置顶 + 跨模块口味画像；AI 生成条只进避免清单。
 */
export async function generateInspirations(): Promise<GenerateInspirationsResult> {
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

  // 阶段一：发散（temperature 高，出 12 条粗点子）
  const divergePrompt = `你是一位挑剔的创意策展人，服务一位有独立品味的开发者。你的任务不是罗列平庸点子，而是提出让人看了想立刻动手的项目灵感。

${tasteWithGuide}

## 已有灵感清单（这些方向勿重复或高度雷同）
${avoidList}

## 生成规则（严格执行）
1. 恰好生成 12 条项目灵感。
2. 形态必须分散：至少覆盖 4 种不同的项目形态（实用工具 / 游戏与玩具 / 内容创作 / 数据可视化 / 实验探索 / 艺术表达 / 社群活动等）——严禁全部是「做一个工具/助手/平台」。
3. 每条必须具体可执行：说得清第一步做什么（最小版本要动手做的事）。
4. 禁止拼装式命名：「XX记录/追踪/打卡/复盘/管理 + 工具/助手/平台/工作台」这类句式模板一律不要。
5. 禁止平庸：安全但无聊的清单/CRUD 类点子、口号式空话一律不要；宁可大胆、有趣、带点冒险。
6. 与口味呼应：至少一半灵感能与口味材料（格言气质/求知领域/方向指引）看出真实连接，但严禁生搬硬套题材。
7. title：10~25 字，具体、有画面感；summary：≤50 字，说清「这是什么 + 好玩/值得在哪」。

以 JSON 对象返回，最外层是对象，格式：{"inspirations":[{"title":"...","summary":"..."}]}，inspirations 数组内恰好 12 项，不要输出其他任何内容。`
  const callDiverge = () =>
    chatCompletion({
      messages: [{ role: 'user', content: divergePrompt }],
      temperature: 0.95,
      jsonMode: true
    })
  let candidates: { title: string; summary: string }[]
  try {
    candidates = parseInspirationArray((await callDiverge()).content)
  } catch {
    // 解析失败自动重试一次（同 generateMottos）；仍失败 → 抛出，整体不入库（specs §6.2）
    candidates = parseInspirationArray((await callDiverge()).content)
  }

  // 阶段二：自评筛选（temperature 低，评审收敛）
  const reviewPrompt = (list: { title: string; summary: string }[]): string =>
    `你是同一位创意策展人，现在进行内部审稿：从下面 ${list.length} 条候选项目灵感中选出恰好 5 条最好的。

${tasteWithGuide}

## 候选灵感
${list.map((c, i) => `${i + 1}. ${c.title}：${c.summary}`).join('\n')}

## 评审规则（严格执行）
1. 心中按四维给每条打分（1~5）：新颖度、契合口味、具体度、兴奋度——分数不用输出，只用于取舍。
2. 淘汰同质（多条同类只留最好一条）、平庸、空泛、与「不想要的方向」冲突的。
3. 恰好选出 5 条；合格不足 5 条时从剩余中挑相对好的补足，并把 summary 打磨到位。
4. 打磨每条 summary：≤60 字，必须包含一个具体的「第一步」抓手（例如先做出什么最小版本）。

以 JSON 对象返回，最外层是对象，格式：{"inspirations":[{"title":"...","summary":"..."}]}，inspirations 数组内恰好 5 项，title 沿用候选原文，不要输出其他任何内容。`
  const callReview = (list: { title: string; summary: string }[]) =>
    chatCompletion({
      messages: [{ role: 'user', content: reviewPrompt(list) }],
      temperature: 0.4,
      jsonMode: true
    })
  let items: { title: string; summary: string }[]
  try {
    items = parseInspirationArray((await callReview(candidates)).content)
  } catch {
    try {
      items = parseInspirationArray((await callReview(candidates)).content)
    } catch {
      // 自评两趟均失败 → 回退取发散阶段前 5 条，不空手而归（优化建议区第18轮降级路径）
      items = candidates.slice(0, 5)
    }
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
    // 正文不写标题行（优化建议区第19轮）：标题由弹窗标题区展示，正文直接从简介开始
    mdCreate(mdPath, `${it.summary}\n`)
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
}

/**
 * 「来 3 碗汤」：原创出 3 碗海龟汤入库（specs §3）。
 * 出题注入画像摘要 + 已有汤避免清单；质量标准与逐碗自检写进 prompt
 * （汤面铺足事实抓手 / 汤底逐一回收 / 本格自洽 / 可判定）——design.md 汤库节。
 */
export async function generateSoups(
  preference: 'random' | 'easy' | 'medium' | 'hard'
): Promise<{ generated: number; inserted: number }> {
  const d = getDb()
  const existing = d
    .prepare('SELECT title, theme_tag FROM turtle_soups ORDER BY id DESC LIMIT 200')
    .all() as { title: string; theme_tag: string }[]
  const avoidList = existing.length
    ? existing.map((r) => `- 《${r.title}》（${r.theme_tag}）`).join('\n')
    : '（暂无）'
  const prefText =
    preference === 'random'
      ? '难度不限，三碗难度错开为佳'
      : `三碗均按「${DIFF_ZH[preference]}」难度出题`
  const prompt = `${profileDigest()}${profileDigest() ? '\n\n' : ''}你是一位资深海龟汤出题人，为一位喜欢推理的玩家原创出题。

## 已有汤清单（汤名与题材组合请避开，不得重复或高度雷同）
${avoidList}

## 出题要求（严格执行）
1. 恰好原创 3 碗海龟汤。禁止搬运网传经典汤；可借鉴经典推理母题（身份诡计、时间诡计、物证矛盾、叙述视角等）但必须重组出全新情节。
2. 每碗产出：title（汤名，2~6 字）、surface（汤面）、bottom（汤底）、analysis（裁判解析——把汤底展开讲透的完整背景：人物、时间线、动机、每个关键细节的因果，供裁判判答用）。
3. ${prefText}；每碗自评难度（easy/medium/hard）并打一枚题材标签（theme，4~8 字，如「本格·罪案」「现代·亲情」「诡计·日常」）。
4. surface 80~200 字；bottom 150~400 字；analysis 200~500 字。

## 质量标准（输出前逐碗自检，不合格的碗重写替换后再输出）
① 汤面铺足可供盘问的具体事实（抓手）：至少 3 个可被玩家提问验证的具体细节（日期、物件、身份、动作、位置等），像「致命日记」给出全部日记日期、「谁盖住了我」给出四次「被盖住」的场景那样；反面示例：汤面只给一句结论式悬念（如「现场被人布置过」）而不铺事实，玩家无从问起——不合格。
② 汤底逐一回收汤面全部细节：汤面出现的每个元素在汤底都有解释，无悬空元素。
③ 本格自洽：无超自然、无巧合堆砌，因果链在现实逻辑内成立。
④ 可判定性：事实链封闭，玩家的判断类问题都能明确答「是 / 否 / 与汤无关」。

以 JSON 对象返回，最外层是对象，格式：{"soups":[{"title":"...","surface":"...","bottom":"...","analysis":"...","difficulty":"easy|medium|hard","theme":"..."}]}，soups 数组内恰好 3 项，不要输出其他任何内容。`
  const call = () =>
    chatCompletion({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      jsonMode: true
    })
  let soups: TurtleSoupDraft[]
  try {
    soups = parseSoupArray((await call()).content)
  } catch {
    // 解析失败自动重试一次（同 generateMottos 惯例）；仍失败 → 抛错，不落半截数据
    soups = parseSoupArray((await call()).content)
  }
  const now = nowIso()
  const ins = d.prepare(
    "INSERT INTO turtle_soups (title, surface, bottom, analysis, difficulty, theme_tag, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'fresh', ?, ?)"
  )
  for (const s of soups) ins.run(s.title, s.surface, s.bottom, s.analysis, s.difficulty, s.theme, now, now)
  return { generated: soups.length, inserted: soups.length }
}

/** 解析出汤返回（恰好 3 碗、三件套齐全才算合格，否则抛错不落库） */
function parseSoupArray(raw: string): TurtleSoupDraft[] {
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
      item.title.trim() &&
      item.surface.trim() &&
      item.bottom.trim() &&
      item.analysis.trim()
    ) {
      out.push({
        title: item.title.trim(),
        surface: item.surface.trim(),
        bottom: item.bottom.trim(),
        analysis: item.analysis.trim(),
        difficulty: normDifficulty(item.difficulty),
        theme: typeof item.theme === 'string' && item.theme.trim() ? item.theme.trim() : '本格'
      })
    }
  }
  if (out.length !== 3) throw new Error(`LLM 返回 ${out.length} 碗合格汤（应为 3 碗）`)
  return out
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
  question: string
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
    jsonMode: true
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
  reasoning: string
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
    jsonMode: true
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
  questionCount: number
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
    temperature: 0.5
  })
  const md = stripMdFence(res.content)
  if (!md) throw new Error('LLM 未返回内容')
  return md
}

export interface WallPuzzleDraft {
  type: 'insight_invariant' | 'strategy_protocol' | 'counter_probability'
  puzzle: string
  answer: string
  /** 标准论证全文（两阶段审题与判答讲解共用，随题落库） */
  reasoning: string
  hints: string[]
  difficulty: 'easy' | 'medium' | 'hard'
}

export type WallPuzzleType = WallPuzzleDraft['type']

/** 洞察题型池（v1.2 题型池换血：旧四类模板题全部退池，真假话推理开发者明令删除） */
export const WALL_TYPE_LIST: readonly WallPuzzleType[] = [
  'insight_invariant',
  'strategy_protocol',
  'counter_probability'
]

const WALL_TYPE_ZH_FULL: Record<WallPuzzleType, string> = {
  insight_invariant: '不变量与构造',
  strategy_protocol: '策略协议设计',
  counter_probability: '反直觉概率'
}

/**
 * 思维墙出题（specs §3，v1.2 洞察题重做）：三题型（不变量与构造 / 策略协议设计 /
 * 反直觉概率），难度按洞察链深度标定，「已知套路 + 更大计算量」的模板题明令禁止。
 * 两阶段管线：出题 → 审题（独立验证结论正确 / 唯一 / 可解 / 难度达标，不过打回重出
 * 一次，仍不过抛错不落库）。避免清单注入近期题面摘要防同构重复。出题注入画像摘要。
 */
export async function generateWallPuzzle(
  difficulty: 'easy' | 'medium' | 'hard',
  opts?: { type?: WallPuzzleType; avoid?: string[] }
): Promise<WallPuzzleDraft> {
  const type: WallPuzzleType =
    opts?.type ?? WALL_TYPE_LIST[Math.floor(Math.random() * WALL_TYPE_LIST.length)]
  const avoidBlock =
    opts?.avoid && opts.avoid.length > 0
      ? `\n## 避免与以下近期题目同构（题材 / 结构 / 答案思路都不得雷同）\n${opts.avoid
          .map((s, i) => `${i + 1}. ${s}`)
          .join('\n')}\n`
      : ''
  const basePrompt = `${profileDigest()}${profileDigest() ? '\n\n' : ''}你是洞察级逻辑题命题人，为思维墙出一道「方法本身要被解题者发明出来」的推理题。核心禁令：不出「已知套路 + 更大计算量」的模板题——纯排除法、纯逻辑网格、纯逐轮剪枝、套公式即可解的题一律不合格。

## 题型（本次出：${WALL_TYPE_ZH_FULL[type]}）
- insight_invariant 不变量与构造：可行 / 不可行 / 最值问题，答案藏在守恒量里（循环结构数、奇偶、染色、势函数、递推不变量……）；常故意放一层恰好「放行」的假守恒（如奇偶性恰好不排除）当诱饵
- strategy_protocol 策略协议设计：要求设计一个必胜 / 必达 / 可验证的协议或策略，并论证无懈可击（必胜策略、信息编码、对抗性方案）
- counter_probability 反直觉概率：贝叶斯 / 期望 / 组合概率，正确结论违反朴素直觉，需要严格论证而非套公式

## 难度标定（严格执行，难度来自洞察深度而非计算量）
- 简单：单一洞察工具，但从题面到工具的映射不显然；找到即解，无需长计算
- 中等：两层洞察链，或含一条「看似可行的错误路线」诱饵；可能需要自建辅助构造
- 困难：三层以上洞察链，或需发明本题特有的不变量 / 协议；结论应当反直觉；即使解题者熟知各类工具，仍需组合创造力
${avoidBlock}
## 硬性质量标准（输出前逐条自检，不合格重写）
1. answer 结论唯一可判定（明确结论 / 数值），或方案可被验证正确性
2. 题面自包含，无需外部知识；推演规模适度——需要大量簿记才能算完的题不合格
3. 禁止可被「标准模板」直接套解（纯排除、纯网格、纯逐项枚举）
4. 至少埋一条「看似可行的错误路线」，走进去会得到错误结论或死胡同
5. hints 恰好 3 条递进：一级指方向 → 二级点工具 → 三级给关键构造，任何一级都不直接给出答案
6. reasoning 为标准论证全文（可分步，200~500 字），完整闭合、无跳步
7. puzzle 用 Markdown 纯文本（可分行、可列表），不要用表格；本次目标难度：${DIFF_ZH[difficulty]}

只输出 JSON：{"puzzle":"题面全文","answer":"标准结论（简短明确）","reasoning":"标准论证全文","hints":["提示1","提示2","提示3"]}，不要输出其他任何内容。`

  let draft = await composeWallPuzzle(type, difficulty, basePrompt)
  // 阶段二：审题人独立验证，不过打回重出一次（问题清单回注 prompt），仍不过抛错
  const v1 = await verifyWallPuzzle(draft, difficulty)
  if (!v1.ok) {
    draft = await composeWallPuzzle(
      type,
      difficulty,
      `${basePrompt}\n\n## 上一次出的题被审题人打回，问题如下（重新出题必须全部规避）\n${v1.problems
        .map((p) => `- ${p}`)
        .join('\n')}`
    )
    const v2 = await verifyWallPuzzle(draft, difficulty)
    if (!v2.ok) throw new Error('出题未通过审题验证（两次），不落库')
  }
  return draft
}

/** 阶段一：单趟出题 + 解析（字段缺失抛错） */
async function composeWallPuzzle(
  type: WallPuzzleType,
  difficulty: 'easy' | 'medium' | 'hard',
  prompt: string
): Promise<WallPuzzleDraft> {
  const res = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.9,
    jsonMode: true
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
  target: 'easy' | 'medium' | 'hard'
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
1. 结论正确：独立推演，标准结论是否真的成立
2. 结论唯一：是否存在另一个同样成立的答案或实质不同的等价结论，使题面有歧义
3. 条件自洽完备：仅凭题面能否推出结论，有无缺条件或内部矛盾
4. 难度达标：按「简单=单工具不显然映射 / 中等=两层链或含诱饵 / 困难=三层链或需发明构造」评估实际难度档；能否被「标准模板」直接套解（能则不合格）；难度来自洞察还是计算量（纯计算量不合格）

只输出 JSON：{"verdict":"pass|fail","ratedDifficulty":"easy|medium|hard","problems":["问题1","问题2"]}。四关全过才 pass；目标难度档：${DIFF_ZH[target]}，ratedDifficulty 低于目标档即 fail；problems 仅在 fail 时非空。`
      }
    ],
    temperature: 0.2,
    jsonMode: true
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
 * 思维墙判答（specs §3，v1.2 验证式判答）：宽松等价——结论实质相同即算对
 * （同一数值 / 同一结论 / 同一策略或等价构造）；只给结论不论证也算对，
 * 附带论证时讲解中顺带点评但不因论证简陋判错。无论对错都输出完整讲解
 * （判定理由 + 标准论证）。判答不注入画像。
 */
export async function judgeWallAnswer(
  puzzleText: string,
  standardAnswer: string,
  standardReasoning: string,
  myAnswer: string
): Promise<WallAnswerResult> {
  const prompt = `你是思维墙的判答员，宽松等价判定：玩家答案与标准答案表述不同但实质等价（同一个数值 / 同一个结论 / 同一种策略或等价构造）即算对；仅当结论实质不同才判错。

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
    jsonMode: true
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
