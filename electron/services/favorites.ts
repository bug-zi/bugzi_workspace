// 收藏夹服务（收藏夹 specs §2）：两级分类 + 纯链接条目 CRUD + 页面 meta 抓取（无 LLM、不入回收站）
import { getDb, nowIso } from '../db/db'
import type { FavoriteCategory, FavoriteItem, FavoriteItemPatch, FavoriteList } from '../../src/shared/types'

/** 常规浏览器 UA（与信息源 fetchFeed 同款：部分站点对无 UA/非常规 UA 直接 403） */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 抓取超时（specs §0） */
const TIMEOUT_MS = 8_000

/** 只读响应前 64KB（specs §2.4：防大页面整页下载） */
const HEAD_LIMIT = 65_536

/** 「未分类」固定末位排序值（specs §1） */
const UNCLASSIFIED_SORT = 1_000_000_000

const URL_RE = /^https?:\/\//i

function assertUrl(url: string): void {
  if (!URL_RE.test(url)) throw new Error('仅支持 http/https 链接')
}

// ---------- 行映射 ----------

function mapCat(r: Record<string, unknown>): FavoriteCategory {
  return {
    id: Number(r.id),
    parent_id: r.parent_id == null ? null : Number(r.parent_id),
    name: String(r.name),
    sort: Number(r.sort),
    is_system: Number(r.is_system) === 1,
    created_at: String(r.created_at)
  }
}

function mapItem(r: Record<string, unknown>): FavoriteItem {
  return {
    id: Number(r.id),
    category_id: Number(r.category_id),
    name: String(r.name),
    url: String(r.url),
    desc_md: String(r.desc_md ?? ''),
    pinned: Number(r.pinned) === 1,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at)
  }
}

// ---------- 列表与 seed ----------

/** 「未分类」锁定大类：categories 表空时幂等插入（favorites:list handler 每次调用） */
function seedUncategorized(): void {
  const d = getDb()
  const row = d.prepare('SELECT COUNT(*) AS c FROM fav_categories').get() as { c: number }
  if (row.c === 0) {
    d.prepare(
      'INSERT INTO fav_categories (parent_id, name, sort, is_system, created_at) VALUES (NULL, ?, ?, 1, ?)'
    ).run('未分类', UNCLASSIFIED_SORT, nowIso())
  }
}

/** 全量列表：categories 按序（未分类 1e9 自然末位）+ items 置顶优先/时间倒序 */
export function listFavorites(): FavoriteList {
  const d = getDb()
  seedUncategorized()
  const categories = d
    .prepare('SELECT * FROM fav_categories ORDER BY sort, id')
    .all()
    .map((r) => mapCat(r as Record<string, unknown>))
  const items = d
    .prepare('SELECT * FROM fav_items ORDER BY pinned DESC, created_at DESC, id DESC')
    .all()
    .map((r) => mapItem(r as Record<string, unknown>))
  return { categories, items }
}

// ---------- 条目 CRUD ----------

function getItem(id: number): FavoriteItem {
  const row = getDb().prepare('SELECT * FROM fav_items WHERE id = ?').get(id)
  if (!row) throw new Error('收藏不存在')
  return mapItem(row as Record<string, unknown>)
}

function requireCategory(id: number): FavoriteCategory {
  const row = getDb().prepare('SELECT * FROM fav_categories WHERE id = ?').get(id)
  if (!row) throw new Error('分类不存在')
  return mapCat(row as Record<string, unknown>)
}

export function addFavoriteItem(name: string, url: string, descMd: string, categoryId: number): FavoriteItem {
  const d = getDb()
  const nameT = name.trim()
  if (!nameT) throw new Error('名称不能为空')
  assertUrl(url)
  requireCategory(categoryId)
  const now = nowIso()
  const r = d
    .prepare(
      'INSERT INTO fav_items (category_id, name, url, desc_md, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
    )
    .run(categoryId, nameT, url.trim(), descMd, now, now)
  return getItem(Number(r.lastInsertRowid))
}

export function updateFavoriteItem(id: number, patch: FavoriteItemPatch): FavoriteItem {
  const cur = getItem(id)
  let name = cur.name
  if (patch.name !== undefined) {
    name = patch.name.trim()
    if (!name) throw new Error('名称不能为空')
  }
  let url = cur.url
  if (patch.url !== undefined) {
    assertUrl(patch.url)
    url = patch.url.trim()
  }
  const descMd = patch.desc_md ?? cur.desc_md
  const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : cur.pinned ? 1 : 0
  let categoryId = cur.category_id
  if (patch.category_id !== undefined) {
    requireCategory(patch.category_id)
    categoryId = patch.category_id
  }
  getDb()
    .prepare('UPDATE fav_items SET name = ?, url = ?, desc_md = ?, pinned = ?, category_id = ?, updated_at = ? WHERE id = ?')
    .run(name, url, descMd, pinned, categoryId, nowIso(), id)
  return getItem(id)
}

export function deleteFavoriteItem(id: number): void {
  getDb().prepare('DELETE FROM fav_items WHERE id = ?').run(id)
}

// ---------- 分类 CRUD（两级约束 + 级联事务） ----------

function getCat(id: number): FavoriteCategory {
  const row = getDb().prepare('SELECT * FROM fav_categories WHERE id = ?').get(id)
  if (!row) throw new Error('分类不存在')
  return mapCat(row as Record<string, unknown>)
}

export function addCategory(name: string, parentId: number | null): FavoriteCategory {
  const d = getDb()
  const nameT = name.trim()
  if (!nameT) throw new Error('分类名不能为空')
  if (parentId != null) {
    const parent = getCat(parentId)
    if (parent.parent_id != null) throw new Error('最多两级分类：不能在子类下再建子类')
  }
  const maxRow = (parentId == null
    ? d.prepare('SELECT MAX(sort) AS m FROM fav_categories WHERE parent_id IS NULL AND is_system = 0').get()
    : d.prepare('SELECT MAX(sort) AS m FROM fav_categories WHERE parent_id = ?').get(parentId)) as { m: number | null }
  const sort = (maxRow?.m ?? 0) + 1
  const r = d
    .prepare('INSERT INTO fav_categories (parent_id, name, sort, is_system, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(parentId, nameT, sort, nowIso())
  return getCat(Number(r.lastInsertRowid))
}

export function renameCategory(id: number, name: string): void {
  const cat = getCat(id)
  if (cat.is_system) throw new Error('「未分类」不可改名')
  const nameT = name.trim()
  if (!nameT) throw new Error('分类名不能为空')
  getDb().prepare('UPDATE fav_categories SET name = ? WHERE id = ?').run(nameT, id)
}

/** 同级上下移：非系统同级按 sort,id 排序找相邻行交换 sort（到头为无操作幂等成功） */
export function moveCategory(id: number, dir: 'up' | 'down'): void {
  const d = getDb()
  const cat = getCat(id)
  if (cat.is_system) throw new Error('「未分类」不可排序')
  const siblings = (
    cat.parent_id == null
      ? d.prepare('SELECT * FROM fav_categories WHERE parent_id IS NULL AND is_system = 0 ORDER BY sort, id').all()
      : d.prepare('SELECT * FROM fav_categories WHERE parent_id = ? ORDER BY sort, id').all(cat.parent_id)
  ).map((r) => mapCat(r as Record<string, unknown>))
  const idx = siblings.findIndex((s) => s.id === id)
  if (idx < 0) return
  const target = dir === 'up' ? idx - 1 : idx + 1
  if (target < 0 || target >= siblings.length) return
  const other = siblings[target]
  d.exec('BEGIN')
  try {
    d.prepare('UPDATE fav_categories SET sort = ? WHERE id = ?').run(other.sort, id)
    d.prepare('UPDATE fav_categories SET sort = ? WHERE id = ?').run(cat.sort, other.id)
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
}

/** 删分类（单事务三步，specs §2.3）：子类上移一级 + 直属条目入未分类 + 删自身；中途失败整体回滚 */
export function deleteCategory(id: number): { movedItems: number; movedChildren: number } {
  const d = getDb()
  const cat = getCat(id)
  if (cat.is_system) throw new Error('「未分类」不可删除')
  const sys = d.prepare('SELECT id FROM fav_categories WHERE is_system = 1').get() as { id: number } | undefined
  if (!sys) throw new Error('「未分类」缺失，数据异常')
  d.exec('BEGIN')
  try {
    const upChildren = Number(
      d.prepare('UPDATE fav_categories SET parent_id = ? WHERE parent_id = ?').run(cat.parent_id, id).changes
    )
    const movedItems = Number(
      d.prepare('UPDATE fav_items SET category_id = ? WHERE category_id = ?').run(sys.id, id).changes
    )
    d.prepare('DELETE FROM fav_categories WHERE id = ?').run(id)
    d.exec('COMMIT')
    return { movedItems, movedChildren: upChildren }
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
}

// ---------- fetchMeta（页面元信息抓取，specs §2.4） ----------

const EMPTY_META = { title: '', desc: '' }

/** HTML 实体解码（title/description 常见命名实体 + 数字实体） */
function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ldquo: '“', rdquo: '”' }
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g: string) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return named[g] ?? m
  })
}

/** meta 标签取 content：兼容 property/name 在前在后两种属性顺序 */
function metaContent(html: string, key: 'property' | 'name', value: string): string {
  const a = new RegExp(`<meta[^>]*${key}=["']${value}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html)
  const b = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*${key}=["']${value}["']`, 'i').exec(html)
  return (a?.[1] ?? b?.[1] ?? '').trim()
}

/** 抓取页面 head 元信息：og 优先；任何失败返回空对象不抛错（渲染层手填兜底） */
export async function fetchMeta(url: string): Promise<{ title: string; desc: string }> {
  try {
    assertUrl(url)
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA },
      redirect: 'follow'
    })
    if (!res.ok || !res.body) return EMPTY_META
    // 流式读取累计至 64KB 即 cancel（无 body 上面已兜底）
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (total < HEAD_LIMIT) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
    if (total >= HEAD_LIMIT) await reader.cancel().catch(() => {})
    // 拼接（可能略超 64KB 一个 chunk，无碍——只为找 head 区）
    const bytes = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      bytes.set(c.subarray(0, Math.min(c.byteLength, bytes.byteLength - off)), off)
      off += c.byteLength
      if (off >= bytes.byteLength) break
    }
    // charset：Content-Type header 优先，其次 <meta charset>；解码失败退 utf-8
    const utf8Preview = new TextDecoder('utf-8').decode(bytes.subarray(0, 2048))
    const charset =
      /charset=["']?([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1] ??
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(utf8Preview)?.[1] ??
      'utf-8'
    let html: string
    try {
      html = new TextDecoder(charset).decode(bytes)
    } catch {
      html = new TextDecoder('utf-8').decode(bytes)
    }
    // 截断到 </head>（找不到保留全量——已受 64KB 上限约束）
    const headEnd = html.search(/<\/head>/i)
    const head = headEnd >= 0 ? html.slice(0, headEnd) : html
    const title =
      metaContent(head, 'property', 'og:title') ||
      (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '').trim()
    const desc = metaContent(head, 'property', 'og:description') || metaContent(head, 'name', 'description')
    const clean = (s: string): string => decodeEntities(s.replace(/\s+/g, ' ').trim()).slice(0, 600)
    return { title: clean(title).slice(0, 200), desc: clean(desc) }
  } catch {
    return EMPTY_META
  }
}
