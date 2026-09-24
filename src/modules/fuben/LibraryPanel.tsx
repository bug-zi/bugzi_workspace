// 收藏库页签（v2.2，specs §2 LibraryPanel）：「我存档的人生」——读毕选「存档入库」的副本
// 全在这里，折叠区展示（可回看/删除）。未读属待读区、在读属「进行中」页签。
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { COPY_CATEGORIES, COPY_ERAS, COPY_MOODS } from '../../shared/types'
import type { CopyCard } from '../../shared/types'

const SOURCE_ZH: Record<string, string> = { official: '官方', daily: '每日', diy: 'DIY' }

export default function LibraryPanel(props: { onRead: (id: number) => void }) {
  const { onRead } = props
  const { toast } = useToast()
  const [rows, setRows] = useState<CopyCard[] | null>(null)
  const [source, setSource] = useState('')
  const [tag, setTag] = useState('')
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [showAll, setShowAll] = useState(true)

  const load = useCallback(async () => {
    try {
      setRows(await window.api.copy.list())
    } catch {
      /* 拉取失败保留旧列表 */
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 模块重新可见时刷新（读毕存档后列表会变）
  useModuleActivated('fuben', () => void load())

  const discard = async (): Promise<void> => {
    if (confirmId == null) return
    try {
      await window.api.copy.discard(confirmId)
      toast('已放入回收站')
      setRows((r) => r?.filter((x) => x.id !== confirmId) ?? null)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setConfirmId(null)
    }
  }

  // 标签筛选值：库内出现过的三标签值动态生成（全部 | 各枚举值中在库的）
  const tagValues = [...new Set((rows ?? []).flatMap((r) => [r.category, r.mood, r.era]))]
  const tagOptions = [...COPY_CATEGORIES, ...COPY_MOODS, ...COPY_ERAS].filter((t) => tagValues.includes(t))

  const matchFilter = (c: CopyCard): boolean =>
    (source === '' || c.source === source) && (tag === '' || c.category === tag || c.mood === tag || c.era === tag)

  // v2.2：收藏库只呈已读存档（在读属「进行中」页签、未读属待读区）
  const finished = (rows ?? []).filter((c) => c.state === 'finished' && matchFilter(c))

  const renderRow = (c: CopyCard): ReactNode => (
    <div key={c.id} className="fuben-row" onClick={() => onRead(c.id)}>
      <span className="material-symbols-outlined fuben-row-icon">task_alt</span>
      <div className="fuben-row-main">
        <div className="fuben-row-title">{c.title}</div>
        <div className="fuben-row-sub">{c.subtitle}</div>
      </div>
      <div className="fuben-row-meta">
        <span className="fuben-chip">{c.category}</span>
        <span className="fuben-chip">{c.mood}</span>
        <span className="fuben-chip">{c.era}</span>
        <span className="fuben-row-info">
          {SOURCE_ZH[c.source] ?? c.source} · {c.wordCount} 字 · 读毕于 {(c.finishedAt ?? '').slice(0, 10)}
        </span>
      </div>
      <button
        className="fuben-row-del"
        title="放入回收站"
        onClick={(e) => {
          e.stopPropagation()
          setConfirmId(c.id)
        }}
      >
        <span className="material-symbols-outlined">delete</span>
      </button>
    </div>
  )

  return (
    <div className="fuben-library">
      <div className="fuben-filter-row">
        <span className="fuben-filter-label">来源</span>
        {['', 'official', 'daily', 'diy'].map((v) => (
          <button key={v || 'all'} className={`fuben-chip-btn${source === v ? ' active' : ''}`} onClick={() => setSource(v)}>
            {v === '' ? '全部' : SOURCE_ZH[v]}
          </button>
        ))}
      </div>
      {tagOptions.length > 0 && (
        <div className="fuben-filter-row">
          <span className="fuben-filter-label">标签</span>
          <button className={`fuben-chip-btn${tag === '' ? ' active' : ''}`} onClick={() => setTag('')}>
            全部
          </button>
          {tagOptions.map((v) => (
            <button key={v} className={`fuben-chip-btn${tag === v ? ' active' : ''}`} onClick={() => setTag(v)}>
              {v}
            </button>
          ))}
        </div>
      )}

      {finished.length === 0 ? (
        <div className="fuben-empty">还没有存档的人生——读完一段并选「存档入库」，它就会收藏在这里</div>
      ) : (
        <div className="fuben-finished-zone">
          <button className="fuben-finished-toggle" onClick={() => setShowAll((v) => !v)}>
            <span className="material-symbols-outlined">{showAll ? 'expand_less' : 'expand_more'}</span>
            已读人生 {finished.length} 段
          </button>
          {showAll && <div className="fuben-list">{finished.map(renderRow)}</div>}
        </div>
      )}

      <ConfirmDialog
        open={confirmId != null}
        title="放入回收站"
        confirmText="删除"
        danger
        onConfirm={() => void discard()}
        onCancel={() => setConfirmId(null)}
      >
        确定把这段人生放入回收站吗？3 天内可在回收站恢复，逾期自动彻底删除。
      </ConfirmDialog>
    </div>
  )
}
