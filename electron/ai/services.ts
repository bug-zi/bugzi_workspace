// AI 业务服务（主进程）：格言生成、知识卡片生成、AI 边栏对话、辩真验证
import { getDb, nowIso, normalizeText } from '../db/db'
import { getSetting, setSetting, getJsonSetting } from '../db/settings'
import { chatCompletion, LlmNotConfiguredError } from './llm'
import { mdWrite } from '../services/files'
import { SettingsKeys } from '../../src/shared/types'
import type { AiMessage, LlmConfig } from '../../src/shared/types'

// ---------- AI 边栏（样式 specs §4） ----------

export function listAiMessages(): AiMessage[] {
  return getDb()
    .prepare('SELECT * FROM ai_messages ORDER BY id ASC')
    .all() as unknown as AiMessage[]
}

export function appendAiMessage(role: AiMessage['role'], content: string, aiModule: string | null = null): AiMessage {
  const now = nowIso()
  const r = getDb()
    .prepare('INSERT INTO ai_messages (role, ai_module, content, created_at) VALUES (?, ?, ?, ?)')
    .run(role, aiModule, content, now)
  return {
    id: Number(r.lastInsertRowid),
    role,
    ai_module: aiModule,
    content,
    created_at: now
  }
}

const MODULE_LABELS: Record<string, string> = {
  mottos: '格言库',
  wiki: '万象库',
  inspirations: '灵感泉',
  verify: '辩真阁',
  recycle: '回收站',
  profile: '个人中心'
}

/** AI 边栏对话：历史 + 模块感知 system prompt（样式 specs §4.1） */
export async function aiChat(userMessage: string, currentModule: string): Promise<AiMessage> {
  // 先落用户消息（持久化 v1 单会话全历史）
  const userMsg = appendAiMessage('user', userMessage, currentModule)
  const history = listAiMessages()
    .filter((m) => m.role !== 'system')
    .slice(-30)
    .map((m) => ({ role: m.role, content: m.content }) as { role: 'user' | 'assistant'; content: string })
  const moduleLabel = MODULE_LABELS[currentModule] ?? currentModule
  const system = `你是「bug子的workspace」个人工作台的 AI 助手。用户当前所在模块：${moduleLabel}。请优先围绕该模块相关话题提供帮助，同时也可以回答用户的其他问题。回答使用简体中文，简洁友好。`
  const res = await chatCompletion({
    messages: [{ role: 'system', content: system }, ...history],
    temperature: 0.8
  })
  const assistantMsg = appendAiMessage('assistant', res.content, currentModule)
  return assistantMsg
}

// ---------- 格言生成（格言库 specs §3） ----------

function parseJsonArray(raw: string): { content: string; source: string }[] {
  // 兼容 ```json 包裹与裸 JSON
  const text = raw.replace(/^[\s\S]*?```(?:json)?\s*\n?/, '').replace(/\n?```\s*[\s\S]*$/, '').trim()
  const arr = JSON.parse(text)
  if (!Array.isArray(arr)) throw new Error('LLM 未返回 JSON 数组')
  const out: { content: string; source: string }[] = []
  for (const item of arr) {
    if (item && typeof item.content === 'string' && typeof item.source === 'string') {
      out.push({ content: item.content.trim(), source: item.source.trim() })
    }
  }
  if (out.length === 0) throw new Error('LLM 返回数组为空或字段缺失')
  return out
}

export interface GenerateMottosResult {
  generated: number
  inserted: number
}

/** 「来10条格言」：正式区风格样本 → LLM 生成 → 查重入库草稿区（specs §3.1） */
export async function generateMottos(): Promise<GenerateMottosResult> {
  const d = getDb()
  const formal = d
    .prepare("SELECT content, source FROM mottos WHERE status = 'formal' AND deleted_at IS NULL ORDER BY id DESC LIMIT 50")
    .all() as { content: string; source: string }[]
  const samples = formal.length
    ? formal.map((m) => `- ${m.content} —— ${m.source}`).join('\n')
    : '（暂无，可自由发挥）'
  const prompt = `以下是我的格言库正式区已有的格言（风格样本）：\n${samples}\n\n请参考这些格言的风格与题材，生成 10 条新格言。可以摘取现实书籍作品中的名言，也可以自行编撰；每条必须标明出处（编撰的标「AI 编撰」）。以 JSON 数组返回，格式：[{"content":"格言正文","source":"出处"}] × 10，不要输出其他任何内容。`
  const res = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.9,
    jsonMode: true
  })
  let items: { content: string; source: string }[]
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
  // 入库前查重：规范化比对三区全部格言
  const existing = new Set(
    (
      d.prepare('SELECT content FROM mottos WHERE deleted_at IS NULL').all() as {
        content: string
      }[]
    ).map((r) => normalizeText(r.content))
  )
  const now = nowIso()
  const ins = d.prepare(
    "INSERT INTO mottos (content, source, status, origin, created_at, updated_at) VALUES (?, ?, 'draft', 'ai', ?, ?)"
  )
  let inserted = 0
  const seen = new Set<string>()
  for (const it of items) {
    const key = normalizeText(it.content)
    if (!key || existing.has(key) || seen.has(key)) continue
    seen.add(key)
    ins.run(it.content, it.source, now, now)
    existing.add(key)
    inserted++
  }
  return { generated: items.length, inserted }
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
