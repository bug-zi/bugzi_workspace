// 存量科普数据一次性繁→简（260927：正式文章统一简体呈现）。
// 覆盖：解读产物 md（sa-*.md）、转正文章（title/summary/tags/glossary/concepts）、
// 发现箱候选（source_type='article'）、划词高光。settings 旗标守卫只跑一次；bootstrap ready 后调用。
// 高光/概念词/mark 标记与 md 正文必须同批转换，才能保持渲染层文本匹配机制不受影响。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { getDb, nowIso, userDataDir } from '../../db/db'
import { simplifyJsonStrArray, toSimplified } from '../t2s'

const FLAG_KEY = 'science_t2s_v1'

interface GlossaryItem {
  en: string
  zh: string
}
interface ConceptItem {
  term: string
  entry_id: number | null
}

function glossaryOf(raw: string | null): string | null {
  try {
    const p = JSON.parse(String(raw ?? 'null'))
    if (!Array.isArray(p)) return null
    const arr = p
      .filter(
        (g): g is GlossaryItem =>
          !!g && typeof g === 'object' && typeof (g as GlossaryItem).en === 'string' && typeof (g as GlossaryItem).zh === 'string'
      )
      .map((g) => ({ en: g.en, zh: toSimplified(g.zh) }))
    return arr.length > 0 ? JSON.stringify(arr) : null
  } catch {
    return null
  }
}

function conceptsOf(raw: string | null): string | null {
  try {
    const p = JSON.parse(String(raw ?? 'null'))
    if (!Array.isArray(p)) return null
    const arr = p
      .filter((c): c is ConceptItem => !!c && typeof c === 'object' && typeof (c as ConceptItem).term === 'string')
      .map((c) => ({ term: toSimplified(c.term), entry_id: typeof c.entry_id === 'number' ? c.entry_id : null }))
    return JSON.stringify(arr)
  } catch {
    return null
  }
}

export function ensureScienceSimplified(): void {
  const d = getDb()
  const flag = d.prepare('SELECT value FROM settings WHERE key = ?').get(FLAG_KEY)
  if (flag) return
  // 内部自 catch 永不抛错（main.ts 启动序列约定）；旗标不落，失败下次启动重试（转换幂等，重跑安全）
  try {
    migrateScienceT2s(d)
    d.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(FLAG_KEY, nowIso())
  } catch (e) {
    console.warn(`[agent:science] 存量科普繁转简失败（下次启动重试）：${(e as Error).message}`)
  }
}

function migrateScienceT2s(d: DatabaseSync): void {
  let mdCount = 0
  try {
    const dir = join(userDataDir(), 'md', 'interpretations')
    for (const f of readdirSync(dir)) {
      if (!/^sa-\d+-(translate|light|lecture)\.md$/.test(f)) continue
      const p = join(dir, f)
      const raw = readFileSync(p, 'utf-8')
      const out = toSimplified(raw)
      if (out !== raw) {
        writeFileSync(p, out, 'utf-8')
        mdCount++
      }
    }
  } catch (e) {
    console.warn(`[agent:science] 存量解读产物繁转简失败：${(e as Error).message}`)
  }

  const articles = d
    .prepare('SELECT id, title, summary, tags, glossary, concepts FROM science_articles')
    .all() as { id: number; title: string; summary: string; tags: string; glossary: string | null; concepts: string | null }[]
  const updArticle = d.prepare(
    'UPDATE science_articles SET title = ?, summary = ?, tags = ?, glossary = ?, concepts = ? WHERE id = ?'
  )
  let articleCount = 0
  for (const r of articles) {
    const title = toSimplified(r.title)
    const summary = toSimplified(r.summary ?? '')
    const tags = simplifyJsonStrArray(r.tags ?? '[]')
    const glossary = glossaryOf(r.glossary)
    const concepts = conceptsOf(r.concepts)
    if (
      title !== r.title ||
      summary !== (r.summary ?? '') ||
      tags !== (r.tags ?? '[]') ||
      glossary !== r.glossary ||
      concepts !== r.concepts
    ) {
      updArticle.run(title, summary, tags, glossary, concepts, r.id)
      articleCount++
    }
  }

  const discovers = d
    .prepare("SELECT id, title, summary, tags, reason FROM discover_items WHERE source_type = 'article'")
    .all() as { id: number; title: string; summary: string; tags: string; reason: string }[]
  const updDiscover = d.prepare('UPDATE discover_items SET title = ?, summary = ?, tags = ?, reason = ? WHERE id = ?')
  let discoverCount = 0
  for (const r of discovers) {
    const title = toSimplified(r.title)
    const summary = toSimplified(r.summary ?? '')
    const tags = simplifyJsonStrArray(r.tags ?? '[]')
    const reason = toSimplified(r.reason ?? '')
    if (title !== r.title || summary !== (r.summary ?? '') || tags !== (r.tags ?? '[]') || reason !== (r.reason ?? '')) {
      updDiscover.run(title, summary, tags, reason, r.id)
      discoverCount++
    }
  }

  const highlights = d.prepare('SELECT id, text FROM science_highlights').all() as { id: number; text: string }[]
  const updHighlight = d.prepare('UPDATE science_highlights SET text = ? WHERE id = ?')
  let highlightCount = 0
  for (const r of highlights) {
    const text = toSimplified(r.text)
    if (text !== r.text) {
      updHighlight.run(text, r.id)
      highlightCount++
    }
  }

  console.info(
    `[agent:science] 存量科普繁转简完成：解读 md ×${mdCount}、转正文章 ×${articleCount}、发现箱 ×${discoverCount}、高光 ×${highlightCount}`
  )
}
