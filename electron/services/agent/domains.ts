// 领域配置服务（agent_domains 表）：渲染层 CRUD 与引擎巡检共用。
// last_scan_at 存本地日期 YYYY-MM-DD（非 ISO 时间戳），「当日已跑」判定无时区歧义。
import { getDb, nowIso } from '../../db/db'
import type { AgentDomainRow, AgentTrack } from '../../../src/shared/types'

function hydrate(r: Record<string, unknown>): AgentDomainRow {
  let keywords: string[] = []
  try {
    const p = JSON.parse(String(r.keywords ?? '[]'))
    if (Array.isArray(p)) keywords = p.filter((k): k is string => typeof k === 'string')
  } catch {
    /* 坏 JSON 按空处理 */
  }
  return {
    id: Number(r.id),
    name: String(r.name),
    track: r.track === 'science' ? 'science' : 'deep',
    keywords,
    enabled: Number(r.enabled) === 1,
    last_scan_at: (r.last_scan_at as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at)
  }
}

export function listDomains(): AgentDomainRow[] {
  return (getDb().prepare('SELECT * FROM agent_domains ORDER BY track, id').all() as unknown as Record<string, unknown>[]).map(hydrate)
}

export function saveDomain(
  id: number | null,
  input: { name: string; track: AgentTrack; keywords: string[]; enabled: boolean }
): number {
  const name = input.name.trim()
  if (!name) throw new Error('领域名称不能为空')
  if (input.track !== 'deep' && input.track !== 'science') throw new Error('领域类型非法')
  const keywords = [...new Set(input.keywords.map((k) => k.trim()).filter(Boolean))].slice(0, 10)
  const now = nowIso()
  if (id == null) {
    const r = getDb()
      .prepare(
        'INSERT INTO agent_domains (name, track, keywords, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(name, input.track, JSON.stringify(keywords), input.enabled ? 1 : 0, now, now)
    return Number(r.lastInsertRowid)
  }
  getDb()
    .prepare('UPDATE agent_domains SET name = ?, track = ?, keywords = ?, enabled = ?, updated_at = ? WHERE id = ?')
    .run(name, input.track, JSON.stringify(keywords), input.enabled ? 1 : 0, now, id)
  return id
}

/** 删领域（配置数据硬删不入回收站）；发现箱条目断链保留 */
export function deleteDomain(id: number): void {
  const d = getDb()
  d.prepare('UPDATE discover_items SET domain_id = NULL WHERE domain_id = ?').run(id)
  d.prepare('DELETE FROM agent_domains WHERE id = ?').run(id)
}

export function localToday(): string {
  const n = new Date()
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`
}

/** 今日待巡检的启用领域 */
export function dueDomains(): AgentDomainRow[] {
  const today = localToday()
  return listDomains().filter((d) => d.enabled && d.last_scan_at !== today)
}

export function markScanned(id: number): void {
  const today = localToday()
  getDb()
    .prepare('UPDATE agent_domains SET last_scan_at = ?, updated_at = ? WHERE id = ?')
    .run(today, nowIso(), id)
}
