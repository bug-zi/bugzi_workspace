// 面经搜集任务（2026-09-24-面经题库化-design.md §四）：agent 队列任务 interview_collect——
// 关键词轮转（传统 + AI 双主线，最薄弱分类定向）→ searchViaMcp 搜面经文章 → readability 抓正文
// → LLM 拆题（只提真实题 + 要点式答案 + 建议分类）→ norm 查重（questions + intake 双表）→ 待审核。
// 单文章失败跳过；批次全失败抛错由队列终态化；完成由渲染层经 agent:status 事件 toast。
import { net } from 'electron'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { getDb } from '../../db/db'
import { chatCompletion } from '../../ai/llm'
import { isLlmConfigured } from '../../ai/services'
import { registerTask } from './queue'
import { wrapMaterial } from './guardrails'
import { searchViaMcp } from './sources/mcpSearch'
import { extractJson } from './collectDeep'
import { insertIntake, listCategoryNames, questionNorm } from '../interviewBank'
import type { TaskContext } from './queue'

/** 搜集关键词池：传统 Go 后端主线 + AI 应用开发主线轮转（传统面经源基本不覆盖 AI 题） */
const KEYWORD_POOL = [
  'Golang 面试题 高频 后端',
  'Go 后端面经 八股文',
  'Golang 面经 GMP channel GC',
  'Go 面经 MySQL Redis 索引 事务',
  'Golang 分布式 微服务 gRPC 面试题',
  'Go 面经 Eino LLM 应用开发',
  'Golang RAG 向量检索 面试',
  'Go Agent MCP function calling 面试题',
  'Golang 系统设计 场景题 秒杀 面试',
  'Go Docker Kubernetes 面试题'
]

function ensureAlive(ctx: TaskContext): void {
  if (ctx.signal.aborted) throw new Error('已取消')
}

/** 抓网页正文纯文本（feed.ts httpGet 同款网络口径：net.fetch 自动跟随系统代理 + UA + 15s 超时） */
async function fetchPageText(url: string): Promise<string> {
  const res = await net.fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
    },
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  const { document } = parseHTML(html)
  const parsed = new Readability(document).parse()
  return (parsed?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

interface ExtractedQuestion {
  question: string
  answer_md: string
  category: string
}

/** LLM 拆题：从一篇面经正文提取真实出现的面试题（不编题），答案不全时基于知识补全 */
async function extractQuestions(
  articleText: string,
  categories: string[],
  signal?: AbortSignal
): Promise<ExtractedQuestion[]> {
  const prompt = `你是后端面试题库整理助手。以下是一篇 Go 后端相关面经文章的正文。请从中提取**文章中真实出现的面试题**，为每题整理要点式中文参考答案。要求：
1. 只提取明确的面试考察点（如「讲讲 GMP 调度模型」「Redis 缓存穿透怎么解决」）；寒暄、个人经历叙述、自述不是题。不要编造文章里没有的题。
2. 每题 answer_md 为要点式 Markdown：分点短句、直击考点，300 字内（命令/代码用代码块）。文章答案不全或缺失时基于你的知识补全，不留空。
3. category 必须从以下清单中选最贴切的一个；确实都不贴切输出空字符串：${categories.join('、')}。
4. 宁缺毋滥：含糊低质的题跳过，单篇最多 12 题。
5. 仅输出 JSON 对象：{"items":[{"question":"题干","answer_md":"要点式答案","category":"分类名"}]}，不要任何其他文字。

${wrapMaterial('面经文章正文', articleText.slice(0, 24000))}`
  const r = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    jsonMode: true,
    scene: 'learn:interviewCollect',
    signal
  })
  const parsed = extractJson(r.content)
  const items = Array.isArray((parsed as { items?: unknown }).items)
    ? ((parsed as { items: unknown[] }).items as ExtractedQuestion[])
    : []
  return items.filter(
    (it) =>
      it &&
      typeof it.question === 'string' &&
      it.question.trim().length >= 4 &&
      typeof it.answer_md === 'string' &&
      it.answer_md.trim().length >= 20
  )
}

async function runInterviewCollect(ctx: TaskContext): Promise<void> {
  if (!isLlmConfigured()) throw new Error('LLM_NOT_CONFIGURED')
  const d = getDb()
  const categories = listCategoryNames()
  // 关键词：池轮转 2 个（按小时位漂移）+ todo 最少分类定向 1 个
  ctx.progress('选择搜集方向…')
  const todoCounts = d
    .prepare(
      "SELECT c.name, COUNT(q.id) AS c FROM interview_categories c LEFT JOIN interview_questions q ON q.category_id = c.id AND q.state = 'todo' AND q.deleted_at IS NULL GROUP BY c.id ORDER BY c ASC"
    )
    .all() as { name: string; c: number }[]
  const weak = todoCounts[0]?.name
  const start = Math.floor(Date.now() / 3_600_000) % KEYWORD_POOL.length
  const keywords = [KEYWORD_POOL[start], KEYWORD_POOL[(start + 3) % KEYWORD_POOL.length]]
  if (weak) keywords.push(`Go ${weak} 面试题 高频`)
  // MCP 搜索（单关键词失败留痕继续）
  ctx.progress('MCP 搜索面经文章…')
  const texts: string[] = []
  for (const kw of keywords) {
    try {
      const t = await searchViaMcp(kw, (m) => console.info(`[interview] ${m}`), ctx.signal)
      texts.push(String(t))
    } catch (e) {
      console.warn(`[interview] 关键词「${kw}」搜索失败：`, (e as Error).message)
    }
  }
  const mcpText = texts.join('\n\n').trim()
  if (!mcpText) throw new Error('MCP_NOT_ENABLED_OR_EMPTY')
  ensureAlive(ctx)
  // URL 白名单：仅接受搜索原文中出现过的链接（防 LLM 编造 url）
  const whitelist = new Set(
    (mcpText.match(/https?:\/\/[^\s)"'<>\]]+/g) ?? []).map((u) => u.replace(/[.,;、。]+$/, ''))
  )
  ctx.progress('AI 挑选面经文章…')
  const selRes = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: `以下是一次网络搜索「Go 后端面试题/面经」的原始结果。请挑出其中**面经/面试题合集文章**的真实链接（不要论文仓库、招聘页、视频页），最多 4 篇，宁缺毋滥；url 必须与原文完全一致，禁止改写。仅输出 JSON：{"articles":[{"title":"文章标题","url":"链接"}]}
${wrapMaterial('搜索原始结果', mcpText.slice(0, 30000))}`
      }
    ],
    temperature: 0,
    jsonMode: true,
    scene: 'learn:interviewCollect',
    signal: ctx.signal
  })
  ensureAlive(ctx)
  let articles: { title?: string; url?: string }[] = []
  try {
    articles = (extractJson(selRes.content).articles ?? []) as { title?: string; url?: string }[]
  } catch {
    /* 解析失败按空处理，走批次全失败抛错 */
  }
  const picked = [
    ...new Set(
      articles.map((a) => (a.url ?? '').trim()).filter((u) => /^https?:\/\//.test(u) && whitelist.has(u))
    )
  ].slice(0, 3)
  if (picked.length === 0) throw new Error('未从搜索结果中识别出面经文章链接，本轮结束')
  // 逐篇：抓正文 → 拆题 → 查重 → 入待审核
  const batchId = Date.now()
  let added = 0
  for (let i = 0; i < picked.length; i++) {
    ensureAlive(ctx)
    const url = picked[i]
    const meta = articles.find((a) => (a.url ?? '').trim() === url)
    const host = (() => {
      try {
        return new URL(url).hostname
      } catch {
        return ''
      }
    })()
    const source = `${(meta?.title ?? '').slice(0, 60)}｜${host}`
    try {
      ctx.progress(`抓取并拆题（${i + 1}/${picked.length}）…`)
      const text = await fetchPageText(url)
      if (text.length < 400) {
        console.warn(`[interview] 正文过短跳过：${url}`)
        continue
      }
      const items = await extractQuestions(text, categories, ctx.signal)
      for (const it of items) {
        const q = it.question.trim()
        const norm = questionNorm(q)
        if (!norm) continue
        if (d.prepare('SELECT id FROM interview_questions WHERE question_norm = ?').get(norm)) continue
        if (d.prepare("SELECT id FROM interview_intake WHERE question_norm = ? AND status = 'pending'").get(norm))
          continue
        const catId = it.category
          ? ((d.prepare('SELECT id FROM interview_categories WHERE name = ?').get(it.category) as
              | { id: number }
              | undefined)?.id ?? null)
          : null
        insertIntake({ categoryId: catId, question: q, norm, answerMd: it.answer_md, source, batchId })
        added++
      }
    } catch (e) {
      if ((e as Error).message === '已取消') throw e
      console.warn(`[interview] 文章处理失败跳过：${url}`, (e as Error).message)
    }
  }
  if (added === 0) throw new Error('本轮未拆出新题（可能均已存在或文章质量不足）')
  console.info(`[interview] 搜集完成：批次 ${batchId} 新增待审 ${added} 题`)
}

// 任务注册（模块顶层；ipc.ts import 即完成注册）
registerTask({ type: 'interview_collect', priority: 20, singleton: true, maxRetries: 1 }, runInterviewCollect)
