// 我是谁（260921 新功能开发区，2026-09-21-我是谁-design.md）：每日 3-4 问 + 回答提炼候选画像条目
// 逐条确认入档 profile_facts(source='ai')。出题一次调用（广谱聚合上下文），提炼每答一题一次调用。
// 历史行永不删：显示只取当日，历史供防重复提问。启动/午夜触发静默失败，LLM 未配置跳过不记日期。
import { getDb, nowIso } from '../db/db'
import { getSetting, setSetting } from '../db/settings'
import { SettingsKeys } from '../../src/shared/types'
import type { WhoamiGetResult, WhoamiQuestionView } from '../../src/shared/types'
import { chatCompletion } from '../ai/llm'
import { isLlmConfigured } from '../ai/services'
import { mdRead } from './files'

/** 候选类别清单（与 PROFILE_SUGGEST 指令、个人档 datalist 同款十类） */
const PROFILE_CATEGORIES = [
  '基本档案', '性格特质', '擅长能力', '兴趣爱好', '生活方式', '社交出行',
  '学习与技能', '职业规划', '价值观', '其他'
]

/** 单飞标志：启动/午夜/手动触发叠投时只跑一趟 */
let generating = false

// ---------- 行读写 helpers ----------

interface WhoamiRow {
  id: number
  date: string
  question: string
  answer: string | null
  skipped: number
  answered_at: string | null
  suggestions: string | null
  resolved: number
  created_at: string
  updated_at: string
}

/** 本地日期 YYYY-MM-DD（批次口径，同 challenge.todayLocal） */
function todayLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 今日题数：3 或 4（每日随机） */
function todayCount(): number {
  return 3 + Math.floor(Math.random() * 2)
}

function getRow(id: number): WhoamiRow | undefined {
  return getDb().prepare('SELECT * FROM whoami_questions WHERE id = ?').get(id) as WhoamiRow | undefined
}

function toView(r: WhoamiRow): WhoamiQuestionView {
  return {
    id: r.id,
    date: r.date,
    question: r.question,
    answer: r.answer,
    skipped: r.skipped === 1,
    answeredAt: r.answered_at,
    suggestions: r.suggestions ? (JSON.parse(r.suggestions) as { category: string; content: string }[]) : [],
    resolved: r.resolved === 1
  }
}

// ---------- 广谱聚合（设计 §三；各源独立可空，空源自动缺席） ----------

function section(title: string, lines: string[]): string {
  return lines.length ? `## ${title}\n${lines.join('\n')}` : ''
}

function aggregateWhoamiContext(): string {
  const d = getDb()
  const parts: string[] = []
  // ① 画像全文（80 字/条）——出题以「补空白」为纲
  const facts = d.prepare('SELECT category, content FROM profile_facts ORDER BY id').all() as {
    category: string
    content: string
  }[]
  if (facts.length) {
    parts.push(
      section(
        '已有的画像条目（优先问这些没覆盖的空白）',
        facts.map((f) => `- ${f.category}：${f.content.replace(/\s+/g, ' ').slice(0, 80)}`)
      )
    )
  }
  // ② 致知己：沉淀问题 + 最近答案版本（md 前 150 字）
  const zj = d
    .prepare(
      `SELECT q.title AS title, v.md_path AS md_path FROM zhijiji_questions q
       JOIN zhijiji_versions v ON v.question_id = q.id
       WHERE q.deleted_at IS NULL ORDER BY v.date DESC, v.id DESC LIMIT 10`
    )
    .all() as { title: string; md_path: string }[]
  const zjLines = zj.map((r) => {
    let brief = ''
    try {
      brief = mdRead(r.md_path).replace(/\s+/g, ' ').trim().slice(0, 150)
    } catch {
      /* md 缺失只略去正文 */
    }
    return `- ${r.title}${brief ? `：${brief}` : ''}`
  })
  const zjSec = section('我的自省问答（问题与我写过的答案开头）', zjLines)
  // ③ 十二问题：题目 + 最近一条想法（80 字）
  const tqs = d
    .prepare(
      `SELECT t.title AS title,
              (SELECT content FROM twelve_thoughts th WHERE th.question_id = t.id ORDER BY th.id DESC LIMIT 1) AS last_thought
       FROM twelve_questions t WHERE t.deleted_at IS NULL ORDER BY t.ord LIMIT 12`
    )
    .all() as { title: string; last_thought: string | null }[]
  const twelveSec = section(
    '我的十二问题与最近想法',
    tqs.map((t) => `- ${t.title}${t.last_thought ? `（最近想法：${t.last_thought.replace(/\s+/g, ' ').slice(0, 80)}）` : ''}`)
  )
  if (zjSec || twelveSec) parts.push([zjSec, twelveSec].filter(Boolean).join('\n'))
  // ④ 格言正式区（40 字）
  const mottos = d
    .prepare(
      "SELECT content, source FROM mottos WHERE deleted_at IS NULL AND status = 'formal' ORDER BY updated_at DESC LIMIT 30"
    )
    .all() as { content: string; source: string }[]
  if (mottos.length) {
    parts.push(
      section(
        '我精选的格言（价值观与品味）',
        mottos.map((m) => `- ${m.content.replace(/\s+/g, ' ').slice(0, 40)}${m.source ? ` —— ${m.source.slice(0, 20)}` : ''}`)
      )
    )
  }
  // ⑤ 万象词条按板块（求知领域）
  const wiki = d
    .prepare(
      `SELECT s.name AS section, e.term AS term FROM wiki_entries e
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
      section(
        '我在学的知识词条',
        [...bySection.entries()].map(([s, terms]) => `- ${s}：${terms.join('、')}`)
      )
    )
  }
  // ⑥ 学习库最近已学（30）
  const learned = d
    .prepare(
      `SELECT n.title AS title, dom.name AS domain FROM learn_nodes n
       JOIN learn_domains dom ON dom.id = n.domain_id
       WHERE n.state = 'learned' AND n.deleted_at IS NULL ORDER BY n.learned_at DESC LIMIT 30`
    )
    .all() as { title: string; domain: string }[]
  if (learned.length) {
    parts.push(section('我最近学完的知识点', learned.map((l) => `- [${l.domain}] ${l.title}`)))
  }
  // ⑦ 灵感泉手写（30）
  const manual = d
    .prepare(
      "SELECT title FROM inspirations WHERE deleted_at IS NULL AND origin = 'manual' ORDER BY updated_at DESC LIMIT 30"
    )
    .all() as { title: string }[]
  if (manual.length) {
    parts.push(section('我手写的灵感', manual.map((m) => `- ${m.title}`)))
  }
  // ⑧ 推理角近 30 天完成计数（一句话）
  const daysAgo = new Date()
  daysAgo.setDate(daysAgo.getDate() - 30)
  const from = todayLocal(daysAgo)
  const wall = d
    .prepare("SELECT COUNT(*) AS n FROM wall_puzzles WHERE date >= ? AND status != 'answering'")
    .get(from) as { n: number }
  if (wall.n > 0) parts.push(`## 近 30 天推理角\n- 每日一题完成 ${wall.n} 题`)
  // ⑨ 记账本月支出 top3 分类（一句话）
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}%`
  const top = d
    .prepare(
      `SELECT IFNULL(c.name, '未分类') AS name, SUM(t.amount_cents) AS cents FROM ledger_tx t
       LEFT JOIN ledger_categories c ON c.id = t.category_id
       WHERE t.type = 'expense' AND t.deleted_at IS NULL AND t.date LIKE ?
       GROUP BY t.category_id ORDER BY cents DESC LIMIT 3`
    )
    .all(ym) as { name: string; cents: number }[]
  if (top.length) {
    parts.push(
      `## 本月消费倾向\n- 支出前三：${top.map((t) => `${t.name} ¥${(t.cents / 100).toFixed(0)}`).join('、')}`
    )
  }
  // ⑩ 在读的书（5）
  const books = d
    .prepare(
      'SELECT title FROM books WHERE last_read_at IS NOT NULL AND progress_percent < 100 ORDER BY last_read_at DESC LIMIT 5'
    )
    .all() as { title: string }[]
  if (books.length) {
    parts.push(section('我在读的书', books.map((b) => `- ${b.title}`)))
  }
  // ⑪ 信息源订阅名单（求知信号，20）
  const feeds = d.prepare('SELECT title FROM feeds ORDER BY id LIMIT 20').all() as { title: string }[]
  if (feeds.length) {
    parts.push(`## 我订阅的信息源\n- ${feeds.map((f) => f.title).join('、')}`)
  }
  return parts.join('\n\n')
}

/** 近期已问问题（防重复注入，40 条） */
function recentAsked(limit: number): string[] {
  return (
    getDb()
      .prepare('SELECT question FROM whoami_questions ORDER BY id DESC LIMIT ?')
      .all(limit) as { question: string }[]
  ).map((r) => r.question)
}

// ---------- JSON 解析（同 services.parseJsonObject 加固范式：<think> 剥除 + 围栏剥离 + 截取重试） ----------

function stripJsonText(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/^[\s\S]*?```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*[\s\S]*$/, '')
    .trim()
}

/** 出题解析：兼容裸数组与对象包裹（取第一个数组字段），过滤空串，截 max 条 */
function parseQuestions(raw: string, max: number): string[] {
  const text = stripJsonText(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const s = text.indexOf('[')
    const e = text.lastIndexOf(']')
    if (s < 0 || e <= s) throw new Error('LLM 未返回 JSON')
    parsed = JSON.parse(text.slice(s, e + 1))
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    parsed = Object.values(parsed as Record<string, unknown>).find((v) => Array.isArray(v)) ?? null
  }
  if (!Array.isArray(parsed)) throw new Error('LLM 未返回问题数组')
  const out = parsed
    .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    .map((q) => q.trim().slice(0, 200))
  if (out.length === 0) throw new Error('LLM 返回问题为空')
  return out.slice(0, max)
}

// ---------- 每日生成 ----------

function buildDailyPrompt(count: number): string {
  const ctx = aggregateWhoamiContext() || '（工作台暂无可参考数据）'
  const asked = recentAsked(40)
  const askedSection = asked.length
    ? `\n\n## 近期已问过的问题（严禁重复或仅微小改写）\n${asked.map((q) => `- ${q}`).join('\n')}`
    : ''
  return `你是 bugzi 的个人 AI 助手 debugzi。以下是「bug子的workspace」工作台中整理出的关于用户的信息：\n\n${ctx}${askedSection}\n\n请基于以上信息，向用户提出 ${count} 个「进一步了解他/她」的问题，帮助 AI 加深对用户的了解。要求：\n- 优先问画像条目尚未覆盖的空白领域与值得深挖的点，不要问已有条目能直接回答的问题\n- 问题要具体、贴合用户真实生活与兴趣，可以用一句话回答\n- 语气自然友好，像熟人之间的好奇提问，不要面试感\n- 直接输出 JSON：{"questions":["问题1","问题2"]}，恰好 ${count} 个，不要输出 JSON 以外的任何内容`
}

/** 生成今日批次（内部幂等：当日已有行直接返回）。抛错由调用方决定静默或提示。 */
export async function generateTodayBatch(): Promise<void> {
  const today = todayLocal()
  const has = getDb().prepare('SELECT id FROM whoami_questions WHERE date = ? LIMIT 1').get(today)
  if (has) return
  if (!isLlmConfigured()) throw new Error('LLM_NOT_CONFIGURED')
  const count = todayCount()
  const res = await chatCompletion({
    messages: [{ role: 'user', content: buildDailyPrompt(count) }],
    temperature: 0.8,
    scene: 'whoami:daily'
  })
  const questions = parseQuestions(res.content, count)
  const now = nowIso()
  const ins = getDb()
    .prepare('INSERT INTO whoami_questions (date, question, created_at, updated_at) VALUES (?, ?, ?, ?)')
  for (const q of questions) ins.run(today, q, now, now)
  setSetting(SettingsKeys.WhoamiDailyDate, today)
  console.info(`[whoami] 每日问题生成 ${questions.length}/${count}`)
}

/** 启动/午夜调度入口：静默失败永不抛错（同 ensureDailyLearn 口径） */
export async function ensureWhoamiDaily(): Promise<void> {
  if (generating) return
  const today = todayLocal()
  const has = getDb().prepare('SELECT id FROM whoami_questions WHERE date = ? LIMIT 1').get(today)
  if (has) return
  generating = true
  try {
    await generateTodayBatch()
  } catch (e) {
    console.warn('[whoami] 每日问题生成失败：', (e as Error).message)
  } finally {
    generating = false
  }
}

// ---------- 查询 / 存答 / 提炼 / 确认（设计 §三 IPC 表） ----------

/** 当日批次 + 往日已答未确认候选（总导览与个人档共用） */
export function whoamiGet(): WhoamiGetResult {
  const today = todayLocal()
  const todayRows = getDb()
    .prepare('SELECT * FROM whoami_questions WHERE date = ? ORDER BY id')
    .all(today) as unknown as WhoamiRow[]
  const pendingRows = getDb()
    .prepare(
      `SELECT * FROM whoami_questions WHERE date < ? AND answer IS NOT NULL AND resolved = 0
       ORDER BY date DESC, id`
    )
    .all(today) as unknown as WhoamiRow[]
  return { today: todayRows.map(toView), pending: pendingRows.map(toView) }
}

/** 存回答（answer=null 为跳过）；提交即定稿不可改（要改去画像区改对应条目） */
export function whoamiAnswer(id: number, answer: string | null): WhoamiQuestionView {
  const row = getRow(id)
  if (!row) throw new Error('NOT_FOUND')
  if (answer == null) {
    getDb()
      .prepare('UPDATE whoami_questions SET skipped = 1, updated_at = ? WHERE id = ?')
      .run(nowIso(), id)
  } else {
    const text = answer.trim()
    if (!text) throw new Error('ANSWER_EMPTY')
    const now = nowIso()
    getDb()
      .prepare('UPDATE whoami_questions SET answer = ?, answered_at = ?, updated_at = ? WHERE id = ?')
      .run(text, now, now, id)
  }
  return toView(getRow(id)!)
}

/** 提炼候选画像条目：问题+回答 → 0-2 条 {category, content}；零条直接 resolved=1 */
export async function whoamiExtract(id: number): Promise<WhoamiQuestionView> {
  const row = getRow(id)
  if (!row || row.answer == null) throw new Error('NOT_ANSWERED')
  if (!isLlmConfigured()) throw new Error('LLM_NOT_CONFIGURED')
  const factsNow = (
    getDb()
      .prepare('SELECT content FROM profile_facts ORDER BY id DESC LIMIT 40')
      .all() as { content: string }[]
  ).map((f) => `- ${f.content.replace(/\s+/g, ' ').slice(0, 40)}`)
  const prompt = `以下是用户刚回答的一个了解性问题。\n\n问题：「${row.question}」\n我的回答：${row.answer}\n\n现有画像类别：${PROFILE_CATEGORIES.join('、')}\n已有画像条目（不要重复提炼已有内容）：\n${factsNow.join('\n') || '（暂无）'}\n\n请从这段问答中提炼值得长期记住的关于用户的**稳定信息**（一次性情绪、临时琐事不要），输出 0-2 条候选画像条目。类别必须从上述类别清单中选择；每条内容一句话概括。若无可提炼的直接给空数组。直接输出 JSON：{"items":[{"category":"...","content":"..."}]}，不要输出 JSON 以外的任何内容。`
  const res = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    scene: 'whoami:extract'
  })
  const valid = parseSuggestions(res.content)
  getDb()
    .prepare('UPDATE whoami_questions SET suggestions = ?, resolved = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(valid), valid.length === 0 ? 1 : 0, nowIso(), id)
  return toView(getRow(id)!)
}

/** 候选解析：同 parseQuestions 范式，校验类别合法 + 内容非空，最多 2 条 */
function parseSuggestions(raw: string): { category: string; content: string }[] {
  const text = stripJsonText(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const s = text.indexOf('{')
    const e = text.lastIndexOf('}')
    if (s < 0 || e <= s) throw new Error('LLM 未返回 JSON')
    parsed = JSON.parse(text.slice(s, e + 1))
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    parsed = Object.values(parsed as Record<string, unknown>).find((v) => Array.isArray(v)) ?? null
  }
  if (!Array.isArray(parsed)) parsed = []
  return (parsed as unknown[])
    .map((it) => it as { category?: unknown; content?: unknown })
    .filter(
      (it): it is { category: string; content: string } =>
        typeof it.category === 'string' &&
        typeof it.content === 'string' &&
        PROFILE_CATEGORIES.includes(it.category.trim()) &&
        it.content.trim().length > 0
    )
    .slice(0, 2)
    .map((it) => ({ category: it.category.trim(), content: it.content.trim().slice(0, 120) }))
}

/** IPC 手动生成入口：与 ensure 不同——错误抛给渲染层提示（LLM_NOT_CONFIGURED → 去配置文案） */
export async function whoamiGenerateIpc(): Promise<WhoamiGetResult> {
  if (generating) return whoamiGet()
  generating = true
  try {
    await generateTodayBatch()
  } finally {
    generating = false
  }
  return whoamiGet()
}

/** 逐条确认：accept=true 加入画像（source='ai'）/false 忽略；候选清空即 resolved=1 */
export function whoamiResolve(id: number, index: number, accept: boolean): WhoamiQuestionView {
  const row = getRow(id)
  if (!row) throw new Error('NOT_FOUND')
  const items = row.suggestions ? (JSON.parse(row.suggestions) as { category: string; content: string }[]) : []
  if (index < 0 || index >= items.length) throw new Error('INDEX_OUT_OF_RANGE')
  const [item] = items.splice(index, 1)
  if (accept) {
    const now = nowIso()
    getDb()
      .prepare(
        'INSERT INTO profile_facts (category, content, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(item.category, item.content, 'ai', now, now)
  }
  getDb()
    .prepare('UPDATE whoami_questions SET suggestions = ?, resolved = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(items), items.length === 0 ? 1 : 0, nowIso(), id)
  return toView(getRow(id)!)
}
