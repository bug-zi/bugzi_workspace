// AI 业务服务（主进程）：格言生成、知识卡片生成、AI 边栏对话、辩真验证
import { getDb, nowIso, normalizeText, isDupMotto } from '../db/db'
import { getSetting, setSetting, getJsonSetting } from '../db/settings'
import { chatCompletion, LlmNotConfiguredError } from './llm'
import { mdWrite } from '../services/files'
import { SettingsKeys } from '../../src/shared/types'
import type { AiMessage, AiSession, LlmConfig } from '../../src/shared/types'

// ---------- AI 边栏（样式 specs §4；多会话：优化建议区「对话记录管理」） ----------

/** 会话默认标题（自动命名/手动改名前的初始值） */
const DEFAULT_SESSION_TITLE = '新对话'

/** 自动命名取消息前 N 字 */
const AUTO_TITLE_LEN = 20

/** 会话列表（最近活跃在前） */
export function listAiSessions(): AiSession[] {
  return getDb()
    .prepare('SELECT * FROM ai_sessions ORDER BY updated_at DESC, id DESC')
    .all() as unknown as AiSession[]
}

/** 当前激活会话 id（settings.ai_active_session_id；无或非法 → null） */
export function getActiveSessionId(): number | null {
  const v = getSetting(SettingsKeys.AiActiveSessionId)
  const id = v ? Number(v) : NaN
  return Number.isInteger(id) && id > 0 ? id : null
}

/** 设置激活会话（渲染层切换/新建时经 settings:set 落库；null 清除） */
export function setActiveSessionId(id: number | null): void {
  setSetting(SettingsKeys.AiActiveSessionId, id == null ? '' : String(id))
}

export function createAiSession(title: string = DEFAULT_SESSION_TITLE): AiSession {
  const now = nowIso()
  const r = getDb()
    .prepare('INSERT INTO ai_sessions (title, created_at, updated_at) VALUES (?, ?, ?)')
    .run(title, now, now)
  return { id: Number(r.lastInsertRowid), title, created_at: now, updated_at: now }
}

export function renameAiSession(id: number, title: string): void {
  const t = title.trim().slice(0, 50) || DEFAULT_SESSION_TITLE
  getDb().prepare('UPDATE ai_sessions SET title = ? WHERE id = ?').run(t, id)
}

/** 删除会话（连同其全部消息）；若删的是激活会话 → 自动切到剩余最近活跃的一个，无剩余则清除激活 */
export function deleteAiSession(id: number): void {
  const d = getDb()
  // 先删消息再删会话（FK 约束下顺序即安全，无需显式事务）
  d.prepare('DELETE FROM ai_messages WHERE session_id = ?').run(id)
  d.prepare('DELETE FROM ai_sessions WHERE id = ?').run(id)
  if (getActiveSessionId() === id) {
    const next = d.prepare('SELECT id FROM ai_sessions ORDER BY updated_at DESC, id DESC LIMIT 1').get() as
      | { id: number }
      | undefined
    setActiveSessionId(next ? next.id : null)
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

/** 系统消息（辩真阁验证过程等）落激活会话；无激活会话则自动新建一个接收，返回带 session_id 的消息 */
export function appendSystemToActiveSession(content: string): AiMessage {
  let sid = getActiveSessionId()
  if (sid == null) {
    const title = content.replace(/\s+/g, ' ').trim().slice(0, AUTO_TITLE_LEN) || DEFAULT_SESSION_TITLE
    const s = createAiSession(title)
    setActiveSessionId(s.id)
    sid = s.id
  }
  return appendAiMessage('system', content, null, sid)
}

const MODULE_LABELS: Record<string, string> = {
  mottos: '格言库',
  wiki: '万象库',
  inspirations: '灵感泉',
  verify: '辩真阁',
  recycle: '回收站',
  profile: '个人中心'
}

/** AI 边栏对话：会话内历史 + 模块感知 system prompt（样式 specs §4.1；多会话改造） */
export async function aiChat(userMessage: string, currentModule: string, sessionId: number): Promise<AiMessage> {
  // 首条用户消息自动命名会话，再落用户消息（持久化该会话全历史）
  autoTitleSession(sessionId, userMessage)
  const userMsg = appendAiMessage('user', userMessage, currentModule, sessionId)
  const history = listAiMessages(sessionId)
    .filter((m) => m.role !== 'system')
    .slice(-30)
    .map((m) => ({ role: m.role, content: m.content }) as { role: 'user' | 'assistant'; content: string })
  const moduleLabel = MODULE_LABELS[currentModule] ?? currentModule
  const system = `你是「bug子的workspace」个人工作台的 AI 助手。用户当前所在模块：${moduleLabel}。请优先围绕该模块相关话题提供帮助，同时也可以回答用户的其他问题。回答使用简体中文，简洁友好。`
  const res = await chatCompletion({
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
  const prompt = `以下是我的格言库正式区已有的格言（风格样本）：\n${samples}\n\n请参考这些格言的风格与题材，生成 10 条新格言：恰好 5 条摘录自现实书籍作品的名言（kind 为 "excerpt"，source 标真实出处，如书名/作者），恰好 5 条由你自行编撰（kind 为 "composed"，source 标「AI 编撰」）。\n\n以下是我已有的全部格言清单，你生成的内容不得与清单中任何一条重复，也不得仅对清单条目作微小改写：\n${avoidList}\n\n以 JSON 对象返回，最外层是对象，格式：{"mottos":[{"content":"格言正文","source":"出处","kind":"excerpt 或 composed"}]}，mottos 数组内恰好 10 项（5 条 excerpt + 5 条 composed），不要输出其他任何内容。`
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

// ---------- 知识卡片生成（万象库 specs §3.1） ----------

export interface GenerateWikiResult {
  entryId: number
  term: string
  summary: string
}

/** 生成知识卡片 md（固定模板，specs §3.1），并建词条记录 */
export async function generateWikiCard(term: string | null, sectionId: number | null): Promise<GenerateWikiResult> {
  const d = getDb()
  // 随机生成：随机板块 + 规避已有词条
  if (!term) {
    const sections = d.prepare('SELECT id, name FROM wiki_sections ORDER BY sort').all() as {
      id: number
      name: string
    }[]
    if (sections.length === 0) throw new Error('请先创建板块')
    const section = sections[Math.floor(Math.random() * sections.length)]
    sectionId = section.id
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
    term = res.content.trim().replace(/^["'《]|["'》]$/g, '')
    if (!term) throw new Error('未能生成词条名')
  }
  // 查重（手动输入场景已拦截，随机场景兜底）
  const dup = d
    .prepare('SELECT id FROM wiki_entries WHERE term = ? AND deleted_at IS NULL')
    .get(term)
  if (dup) throw new Error('CONFLICT:' + term)
  const prompt = `请为词条「${term}」生成一张知识卡片，Markdown 格式，严格按以下模板输出（每个二级标题必须有内容，不要输出模板外的任何内容）：\n\n# ${term}\n\n## 一句话定义\n{一句话定义}\n\n## 详细解释\n{详细解释}\n\n## 举例\n{举例}\n\n## 启示\n{启示}`
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
