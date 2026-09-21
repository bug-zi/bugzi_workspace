// arXiv 渠道（总纲 §4.5：论文优先走结构化 API 而非网页抓取）：Atom API 检索，
// 返回原始候选元信息；结构化筛选与推荐理由由批次 B 海选 LLM 调用完成。
import { XMLParser } from 'fast-xml-parser'
import { politeFetch } from '../guardrails'

export interface ArxivCandidate {
  title: string
  authors: string[]
  year: number | null
  /** 发布日期 YYYY-MM-DD（published 原样截取，精确到日） */
  date: string | null
  summary: string
  url: string
  tags: string[]
  language: 'en'
  source: 'arxiv'
}

const parser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === 'entry' || name === 'author' || name === 'category'
})

/** 每关键词一次查询（上限 3 个/轮），单关键词失败跳过不炸整轮；候选按 url 去重 */
export async function searchArxiv(keywords: string[], signal?: AbortSignal): Promise<ArxivCandidate[]> {
  const results: ArxivCandidate[] = []
  const seen = new Set<string>()
  for (const kw of keywords.slice(0, 3)) {
    if (signal?.aborted) break
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(
      `"${kw}"`
    )}&start=0&max_results=20&sortBy=submittedDate&sortOrder=descending`
    try {
      const { text } = await politeFetch(url, { signal })
      const feed = (parser.parse(text) as { feed?: { entry?: unknown } })?.feed
      const rawEntries = Array.isArray(feed?.entry) ? feed.entry : feed?.entry ? [feed.entry] : []
      for (const e of rawEntries as Record<string, unknown>[]) {
        const entryUrl = typeof e.id === 'string' ? e.id : ''
        if (!entryUrl || seen.has(entryUrl)) continue
        seen.add(entryUrl)
        const authors = (Array.isArray(e.author) ? e.author : e.author ? [e.author] : [])
          .map((a) => (typeof (a as { name?: unknown })?.name === 'string' ? ((a as { name: string }).name as string) : ''))
          .filter(Boolean)
        const tags = (Array.isArray(e.category) ? e.category : e.category ? [e.category] : [])
          .map((c) => (typeof (c as Record<string, unknown>)?.['@_term'] === 'string' ? ((c as Record<string, string>)['@_term'] as string) : ''))
          .filter(Boolean)
        const published = typeof e.published === 'string' ? e.published : ''
        results.push({
          title: String(e.title ?? '').replace(/\s+/g, ' ').trim(),
          authors,
          year: published ? Number(published.slice(0, 4)) || null : null,
          date: published ? published.slice(0, 10) : null,
          summary: String(e.summary ?? '').replace(/\s+/g, ' ').trim(),
          url: entryUrl,
          tags,
          language: 'en',
          source: 'arxiv'
        })
      }
    } catch (e) {
      if (signal?.aborted) break
      console.warn(`[agent:arxiv] 关键词「${kw}」检索失败：${(e as Error).message}`)
    }
  }
  return results
}
