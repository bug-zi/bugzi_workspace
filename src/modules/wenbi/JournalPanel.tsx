// 浮生记（文笔坊 specs §2）：自由记录时间线——按月/按周分节、大事件置顶小节；零 AI 硬边界（无任何 AI 入口）
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { WenbiJournalRecord } from '../../shared/types'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

export default function JournalPanel(props: { active: boolean }) {
  const { toast } = useToast()
  const [rows, setRows] = useState<WenbiJournalRecord[]>([])
  const [previews, setPreviews] = useState<Record<number, string>>({})
  const [granularity, setGranularity] = useState<'month' | 'week'>('month')
  const [openDoc, setOpenDoc] = useState<WenbiJournalRecord | null>(null)
  const [discardTarget, setDiscardTarget] = useState<WenbiJournalRecord | null>(null)

  const load = useCallback(async () => {
    const list = await window.api.wenbi.journalList()
    setRows(list)
    // 首行摘要：md 首个非空行去 markdown 记号截 50 字（specs §2.1）
    const entries = await Promise.all(
      list.map(async (it) => {
        let s = ''
        try {
          const raw = await window.api.md.read(it.md_path)
          const line = raw
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l && !l.startsWith('#'))
          s = (line ?? '').replace(/^[>*\-+\s]+/, '').slice(0, 50)
        } catch {
          /* 无正文则空摘要 */
        }
        return [it.id, s] as const
      })
    )
    setPreviews(Object.fromEntries(entries))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // keep-alive：切回文笔坊模块时刷新（回收站恢复可能改动了列表）
  useModuleActivated('wenbi', () => void load())
  // 板块切回时刷新（双板块常驻挂载，board 切换不触发组件重挂）
  useEffect(() => {
    if (props.active) void load()
  }, [props.active, load])

  /** 新建即写：建记录返回整行 → MdDialog autoEdit 直进编辑态（specs §2.2） */
  const doCreate = async (): Promise<void> => {
    const rec = await window.api.wenbi.journalCreate()
    setOpenDoc(rec)
    await load()
  }

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    await window.api.wenbi.journalDiscard(discardTarget.id)
    toast('已放入回收站')
    setDiscardTarget(null)
    setOpenDoc(null)
    await load()
  }

  /** 大事件置顶小节（specs §2.1，倒序聚合；rows 本身 created_at 倒序） */
  const events = useMemo(() => rows.filter((r) => r.is_event === 1), [rows])
  /** 时间线分节：按 created_at 钉位（事后编辑不挪动位置，specs §2.1） */
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; label: string }>()
    for (const r of rows) {
      const g = groupOf(r.created_at, granularity)
      if (!m.has(g.key)) m.set(g.key, g)
    }
    return [...m.values()].sort((a, b) => b.key.localeCompare(a.key))
  }, [rows, granularity])

  /** 行组件：创建日期 + 首行摘要 + 大事件标记 + 丢弃 */
  const journalRow = (it: WenbiJournalRecord): ReactNode => (
    <div className="row-item" key={it.id} style={{ cursor: 'default' }} onClick={() => setOpenDoc(it)}>
      <div className="row-main" style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="journal-date">{fmtDate(it.created_at)}</span>
        <span className="row-title" style={{ flex: 1 }} title={previews[it.id] ?? ''}>
          {previews[it.id] || '（空白）'}
        </span>
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        {it.is_event === 1 && (
          <span className="material-symbols-outlined" style={{ fontSize: 16, opacity: 0.7 }} title="大事件">
            flag
          </span>
        )}
        <button className="icon-btn danger" title="丢弃" onClick={() => setDiscardTarget(it)}>
          <span className="material-symbols-outlined">delete</span>
        </button>
      </div>
    </div>
  )

  return (
    <div>
      <div className="journal-controls">
        <div className="journal-granularity">
          <button className={granularity === 'month' ? 'active' : ''} onClick={() => setGranularity('month')}>
            按月
          </button>
          <button className={granularity === 'week' ? 'active' : ''} onClick={() => setGranularity('week')}>
            按周
          </button>
        </div>
        <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => void doCreate()}>
          <span className="material-symbols-outlined">add</span>
          记一条
        </button>
      </div>

      {events.length > 0 && (
        <section className="zone">
          <div className="zone-header">
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              flag
            </span>
            <span>大事件</span>
            <span className="zone-count">{events.length}</span>
          </div>
          <div className="zone-body">{events.map((it) => journalRow(it))}</div>
        </section>
      )}

      {groups.map((g) => (
        <section key={g.key}>
          <div className="journal-group-header">{g.label}</div>
          <div className="zone">
            <div className="zone-body">
              {rows.filter((r) => groupOf(r.created_at, granularity).key === g.key).map((it) => journalRow(it))}
            </div>
          </div>
        </section>
      ))}
      {rows.length === 0 && (
        <div className="empty-state" style={{ padding: '40px 0' }}>
          <span className="material-symbols-outlined">history_edu</span>
          随手记点什么——只给心情感想留个地方
        </div>
      )}

      {/* 条目弹窗：头部显示日期；大事件开关编辑态即时生效；新建 autoEdit 直进编辑态 */}
      <MdDialog
        open={openDoc != null}
        title={openDoc ? `浮生记 · ${fmtDate(openDoc.created_at)}` : ''}
        filePath={openDoc?.md_path ?? ''}
        autoEdit
        onClose={() => setOpenDoc(null)}
        onChanged={() => void load()}
        eventToggle={
          openDoc
            ? {
                checked: openDoc.is_event === 1,
                onChange: (v) => {
                  void window.api.wenbi.journalSetEvent(openDoc.id, v)
                  setOpenDoc({ ...openDoc, is_event: v ? 1 : 0 })
                  void load()
                }
              }
            : undefined
        }
      />

      <ConfirmDialog
        open={discardTarget != null}
        title="放入回收站"
        confirmText="丢弃"
        danger
        onConfirm={() => void doDiscard()}
        onCancel={() => setDiscardTarget(null)}
      >
        放入回收站，3 天后自动彻底删除。
      </ConfirmDialog>
    </div>
  )
}

/** 分节（specs §2.1）：月「2026年9月」；周「9/7–9/13」（周一至周日计） */
function groupOf(iso: string, g: 'month' | 'week'): { key: string; label: string } {
  const d = new Date(iso)
  if (g === 'month') {
    return {
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: `${d.getFullYear()}年${d.getMonth() + 1}月`
    }
  }
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7)) // 周一为一周之始
  const e = new Date(s)
  e.setDate(e.getDate() + 6)
  const md = (x: Date): string => `${x.getMonth() + 1}/${x.getDate()}`
  return {
    key: `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`,
    label: `${md(s)}–${md(e)}`
  }
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
