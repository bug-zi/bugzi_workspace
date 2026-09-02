// 回收站模块（回收站 specs 全量）：四板块页签、恢复/彻底删除、剩余存活时间
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RecycleRow } from '../../renderer/api'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'

const TABS: { source: RecycleRow['source']; label: string; backTo: string }[] = [
  { source: 'mottos', label: '格言库', backTo: '格言库草稿区' },
  { source: 'wiki', label: '万象库', backTo: '原板块' },
  { source: 'inspirations', label: '灵感泉', backTo: '灵感泉草稿区' },
  { source: 'verify', label: '辩真阁', backTo: '历史记录列表' }
]

const DAY_MS = 24 * 60 * 60 * 1000

/** 剩余存活文案（specs §2：「剩 2 天」「今天到期」） */
function remainText(createdAt: string): string {
  const elapsed = Date.now() - new Date(createdAt).getTime()
  const remainMs = 3 * DAY_MS - elapsed
  if (remainMs <= 0) return '即将清理'
  const days = Math.floor(remainMs / DAY_MS)
  if (days >= 1) return `剩 ${days} 天`
  return '今天到期'
}

/** 摘要（各来源 payload 快照提取） */
function summaryOf(row: RecycleRow): string {
  try {
    const p = JSON.parse(row.payload) as Record<string, unknown>
    if (row.source === 'mottos') return String(p.content ?? '')
    if (row.source === 'wiki') return `${p.term ?? ''}｜${p.summary ?? ''}`
    if (row.source === 'inspirations') return String(p.title ?? '')
    return String(p.claim ?? '')
  } catch {
    return `#${row.item_id}`
  }
}

export default function RecycleModule() {
  const { toast } = useToast()
  const [rows, setRows] = useState<RecycleRow[]>([])
  const [tab, setTab] = useState<RecycleRow['source']>('mottos')
  const [delTarget, setDelTarget] = useState<RecycleRow | null>(null)
  // 刷新信号（其他模块丢弃时 recycle:changed 推送）
  const [version, setVersion] = useState(0)

  const load = useCallback(async () => {
    setRows(await window.api.recycle.list())
  }, [])

  useEffect(() => {
    void load()
    const off = window.api.item.onRecycleChanged(() => {
      setVersion((v) => v + 1)
    })
    return off
  }, [load])

  useEffect(() => {
    if (version > 0) void load()
  }, [version, load])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of rows) c[r.source] = (c[r.source] ?? 0) + 1
    return c
  }, [rows])

  const tabRows = rows.filter((r) => r.source === tab)

  const doRestore = async (row: RecycleRow): Promise<void> => {
    const backTo = TABS.find((t) => t.source === row.source)?.backTo ?? ''
    await window.api.recycle.restore(row.id)
    toast(`已恢复到${backTo}`)
    await load()
  }

  const doDelete = async (): Promise<void> => {
    if (!delTarget) return
    await window.api.recycle.delete(delTarget.id)
    toast('已彻底删除')
    setDelTarget(null)
    await load()
  }

  return (
    <div className="module-page">
      <div className="module-header">
        <span className="material-symbols-outlined">delete</span>
        <span className="module-title">回收站</span>
        <span className="module-sub">存放 3 天后自动彻底删除</span>
      </div>

      <div className="recycle-tabs">
        {TABS.map((t) => (
          <button
            key={t.source}
            className={`recycle-tab${tab === t.source ? ' active' : ''}`}
            onClick={() => setTab(t.source)}
          >
            {t.label}
            <span className="zone-count">{counts[t.source] ?? 0}</span>
          </button>
        ))}
      </div>

      <section className="zone">
        <div className="zone-body">
          {tabRows.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">delete</span>
              暂无内容
            </div>
          )}
          {tabRows.map((r) => (
            <div className="row-item" key={r.id} style={{ cursor: 'default' }}>
              <div className="row-main">
                <div className="row-title" title={summaryOf(r)}>{summaryOf(r)}</div>
                <div className="row-sub">
                  入站 {fmtTime(r.created_at)} ｜ {remainText(r.created_at)}
                </div>
              </div>
              <div className="row-actions">
                <button
                  className="btn"
                  onClick={() => void doRestore(r)}
                  title={`恢复到${TABS.find((t) => t.source === r.source)?.backTo}`}
                >
                  <span className="material-symbols-outlined">restore_from_trash</span>
                  恢复
                </button>
                <button className="btn btn-danger" onClick={() => setDelTarget(r)}>
                  <span className="material-symbols-outlined">delete_forever</span>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 彻底删除二次确认（specs §3） */}
      <ConfirmDialog
        open={delTarget != null}
        title="彻底删除"
        confirmText="彻底删除"
        danger
        onConfirm={() => void doDelete()}
        onCancel={() => setDelTarget(null)}
      >
        彻底删除后无法恢复，附属笔记/文档将一并删除。
      </ConfirmDialog>
    </div>
  )
}

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
