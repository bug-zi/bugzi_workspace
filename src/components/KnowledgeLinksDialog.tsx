// 知识链接管理弹窗（超级工作台 2.0 批次F spec §2，共享组件）：双向链接列表（类型图标 +
// 来源徽章 + 移除二次确认）+「添加关联」（目标类型下拉 + 标题检索即输即搜）。
// 供文献详情 / 科普详情 / 书解读弹窗 / 万象词条弹窗四处复用。
import { useCallback, useEffect, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import './KnowledgeLinksDialog.css'

/** 五类实体的展示元数据（图标/名称；与 knowledge_links dst_type 口径一致） */
const TYPE_META: { type: string; label: string; icon: string }[] = [
  { type: 'paper', label: '论文', icon: 'description' },
  { type: 'science_article', label: '科普文章', icon: 'science' },
  { type: 'wiki', label: '词条', icon: 'menu_book' },
  { type: 'book', label: '书', icon: 'auto_stories' },
  { type: 'learn_node', label: '知识点', icon: 'school' }
]

export interface RelatedLink {
  link_id: number
  peer_type: string
  peer_id: number
  title: string
  origin: string
  score: number
}

interface Props {
  open: boolean
  srcType: string
  srcId: number
  /** 宿主标题（弹窗副题） */
  title: string
  onClose: () => void
}

export default function KnowledgeLinksDialog({ open, srcType, srcId, title, onClose }: Props) {
  const [links, setLinks] = useState<RelatedLink[]>([])
  const [addType, setAddType] = useState<string>('wiki')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ id: number; title: string }[]>([])
  const [delTarget, setDelTarget] = useState<RelatedLink | null>(null)

  const reload = useCallback((): void => {
    void window.api.links
      .list(srcType, srcId)
      .then((rows) => setLinks(rows as RelatedLink[]))
      .catch(() => setLinks([]))
  }, [srcType, srcId])

  useEffect(() => {
    if (open) reload()
  }, [open, reload])

  // 添加搜索：即输即搜（≥1 字符）
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q) {
      setResults([])
      return
    }
    let alive = true
    void window.api.links
      .entitySearch(addType, q)
      .then((rows) => {
        if (alive) setResults(rows)
      })
      .catch(() => setResults([]))
    return () => {
      alive = false
    }
  }, [query, addType, open])

  const addLink = async (dstType: string, dstId: number): Promise<void> => {
    await window.api.links.add(srcType, srcId, dstType, dstId)
    setQuery('')
    setResults([])
    reload()
  }

  if (!open) return null

  const metaOf = (t: string): { label: string; icon: string } => {
    const m = TYPE_META.find((x) => x.type === t)
    return { label: m?.label ?? t, icon: m?.icon ?? 'link' }
  }

  return (
    <>
      <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="dialog klinks-dialog" style={{ width: 520 }}>
          <div className="dialog-header">关联知识 · {title}</div>
          <div className="dialog-body klinks-body">
            {/* 现有链接（双向合并） */}
            <div className="setting-label">现有关联（{links.length}）</div>
            {links.length === 0 && <div className="module-sub">暂无关联——在下方添加，或等语义推荐自动生成。</div>}
            {links.map((l) => {
              const m = metaOf(l.peer_type)
              return (
                <div className="klinks-row" key={l.link_id}>
                  <span className="material-symbols-outlined">{m.icon}</span>
                  <span className="klinks-title" title={l.title}>
                    {l.title}
                  </span>
                  <span className="badge">{m.label}</span>
                  <span className={`badge ${l.origin === 'manual' ? 'primary' : ''}`}>
                    {l.origin === 'manual' ? '手动' : `相似 ${Math.round(l.score * 100)}%`}
                  </span>
                  <button className="icon-btn danger klinks-del" title="移除此关联" onClick={() => setDelTarget(l)}>
                    <span className="material-symbols-outlined">link_off</span>
                  </button>
                </div>
              )
            })}

            {/* 添加关联 */}
            <div className="setting-label klinks-add-label">添加关联</div>
            <div className="klinks-add-ctrl">
              <select className="field klinks-type" value={addType} onChange={(e) => setAddType(e.target.value)}>
                {TYPE_META.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </select>
              <input
                className="field klinks-search"
                placeholder={`按标题搜索${TYPE_META.find((t) => t.type === addType)?.label ?? ''}…`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {results.length > 0 && (
              <div className="klinks-results">
                {results.map((r) => (
                  <div
                    className="klinks-result-row"
                    key={r.id}
                    onClick={() => void addLink(addType, r.id)}
                    title="点击建立关联"
                  >
                    <span className="material-symbols-outlined">add_link</span>
                    {r.title}
                  </div>
                ))}
              </div>
            )}
            {query.trim() && results.length === 0 && <div className="module-sub">无匹配结果</div>}
          </div>
          <div className="dialog-footer">
            <button className="btn" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={delTarget !== null}
        title="移除关联"
        danger
        confirmText="移除"
        onConfirm={() => {
          const t = delTarget
          setDelTarget(null)
          if (!t) return
          void window.api.links.del(t.link_id).then(reload)
        }}
        onCancel={() => setDelTarget(null)}
      >
        确认移除与「{delTarget?.title}」的关联？仅解除链接，不删除双方任何内容。
      </ConfirmDialog>
    </>
  )
}
