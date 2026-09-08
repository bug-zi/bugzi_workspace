// 写作台（文笔坊 specs §3/§4 + 2026-09-08 页面化 design）：文章四区流转（构思/写作/完稿/已发布）+ 文章页（Copilot/自动保存）+ 复制/导出
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WenbiArticleRecord } from '../../shared/types'
import ArticlePage from './ArticlePage'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

const ZONES: { zone: WenbiArticleRecord['zone']; label: string }[] = [
  { zone: 'idea', label: '构思区' },
  { zone: 'writing', label: '写作区' },
  { zone: 'done', label: '完稿区' },
  { zone: 'published', label: '已发布区' }
]

export default function WritingPanel(props: { active: boolean }) {
  const { toast } = useToast()
  const [items, setItems] = useState<WenbiArticleRecord[]>([])
  const [openDoc, setOpenDoc] = useState<WenbiArticleRecord | null>(null)
  const [addingZone, setAddingZone] = useState<WenbiArticleRecord['zone'] | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [menuFor, setMenuFor] = useState<{ item: WenbiArticleRecord; left: number; top: number } | null>(null)
  const [discardTarget, setDiscardTarget] = useState<WenbiArticleRecord | null>(null)
  const [goConfig, setGoConfig] = useState(false)
  const [exporting, setExporting] = useState(false)
  const dragIdRef = useRef<number | null>(null)
  const [dragOverZone, setDragOverZone] = useState<string | null>(null)

  const load = useCallback(async () => {
    setItems(await window.api.wenbi.articleList())
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useModuleActivated('wenbi', () => void load())
  useEffect(() => {
    if (props.active) void load()
  }, [props.active, load])

  const itemsOf = (zone: WenbiArticleRecord['zone']): WenbiArticleRecord[] =>
    items.filter((i) => i.zone === zone).sort((a, b) => a.sort - b.sort || a.id - b.id)

  const doAdd = async (): Promise<void> => {
    if (!addingZone || !newTitle.trim()) return
    const id = await window.api.wenbi.articleCreate(addingZone, newTitle.trim())
    setAddingZone(null)
    setNewTitle('')
    const created = (await window.api.wenbi.articleList()).find((a) => a.id === id)
    if (created) setOpenDoc(created)
  }

  /** 跨区移动到目标区末尾（specs §3.1 即时生效，无确认） */
  const moveTo = async (item: WenbiArticleRecord, zone: WenbiArticleRecord['zone']): Promise<void> => {
    if (item.zone === zone) return
    const target = itemsOf(zone)
    const sort = (target.length ? Math.max(...target.map((t) => t.sort)) : 0) + 1
    await window.api.wenbi.articleMove(item.id, zone, sort)
    await load()
  }

  // HTML5 拖拽（灵感泉同构）
  const onDragStart = (e: React.DragEvent, item: WenbiArticleRecord): void => {
    dragIdRef.current = item.id
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(item.id))
    ;(e.currentTarget as HTMLElement).classList.add('dragging')
  }
  const onDragEnd = (e: React.DragEvent): void => {
    ;(e.currentTarget as HTMLElement).classList.remove('dragging')
    dragIdRef.current = null
    setDragOverZone(null)
  }
  const onDropToZone = async (e: React.DragEvent, zone: WenbiArticleRecord['zone']): Promise<void> => {
    e.preventDefault()
    setDragOverZone(null)
    const id = Number(e.dataTransfer.getData('text/plain')) || dragIdRef.current
    if (!id) return
    const item = items.find((i) => i.id === id)
    if (!item || item.zone === zone) return
    await moveTo(item, zone)
  }
  /** 拖到某卡片前插入（跨区拖到具体卡片 = 移动到该区该位置） */
  const onDropToCard = async (e: React.DragEvent, target: WenbiArticleRecord): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverZone(null)
    const id = Number(e.dataTransfer.getData('text/plain')) || dragIdRef.current
    if (!id || id === target.id) return
    const source = items.find((i) => i.id === id)
    if (!source) return
    await window.api.wenbi.articleMove(source.id, target.zone, target.sort - 0.5)
    await normalizeSort(target.zone)
    await load()
  }
  /** 重排后归一化 sort（0..n） */
  const normalizeSort = async (zone: WenbiArticleRecord['zone']): Promise<void> => {
    const zoneItems = items.filter((i) => i.zone === zone).sort((a, b) => a.sort - b.sort || a.id - b.id)
    const moves = zoneItems.map((i, idx) => ({ id: i.id, zone, sort: idx }))
    if (moves.length > 0) await window.api.wenbi.articleReorder(moves)
  }

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    await window.api.wenbi.articleDiscard(discardTarget.id)
    toast('已放入回收站')
    setDiscardTarget(null)
    setOpenDoc(null)
    await load()
  }

  /** 复制 Markdown（specs §3.3） */
  const copyMd = async (item: WenbiArticleRecord): Promise<void> => {
    setMenuFor(null)
    try {
      const raw = await window.api.md.read(item.md_path)
      await window.api.clipboard.writeText(raw)
      toast('已复制 Markdown')
    } catch (e) {
      toast(`复制失败：${(e as Error).message}`)
    }
  }

  /** 导出 .md（specs §3.3：系统保存对话框，取消静默返回 null） */
  const exportMd = async (item: WenbiArticleRecord): Promise<void> => {
    setMenuFor(null)
    if (exporting) return
    setExporting(true)
    try {
      const saved = await window.api.wenbi.articleExport(item.id)
      if (saved) toast('已导出')
    } catch (e) {
      toast(`导出失败：${(e as Error).message}`)
    } finally {
      setExporting(false)
    }
  }

  /** 返回看板：ArticlePage 返回前已 flush，这里刷新列表（标题/时间）并清 openDoc */
  const handleBack = useCallback(async (): Promise<void> => {
    await load()
    setOpenDoc(null)
  }, [load])

  return (
    <div className="writing-panel">
      {openDoc ? (
        <ArticlePage
          key={openDoc.id}
          item={openDoc}
          active={props.active}
          onBack={() => void handleBack()}
          onRenamed={(t) => setOpenDoc((d) => (d ? { ...d, title: t } : d))}
          onGoConfig={() => setGoConfig(true)}
        />
      ) : (
        <>
          <div className="module-sub" style={{ marginBottom: 8 }}>
            文章流转：构思 → 写作 → 完稿 → 已发布（发布在博客站手动完成，拖入已发布区作状态记录）
          </div>
          <div className="kanban">
            {ZONES.map((z) => {
              const zoneItems = itemsOf(z.zone)
              return (
                <section className="zone" key={z.zone}>
                  <div className="zone-header">
                    <span>{z.label}</span>
                    <span className="zone-count">{zoneItems.length}</span>
                    <div className="zone-actions">
                      <button
                        className="icon-btn"
                        title="新建"
                        onClick={() => {
                          setAddingZone(z.zone)
                          setNewTitle('')
                        }}
                      >
                        <span className="material-symbols-outlined">add</span>
                      </button>
                    </div>
                  </div>
                  <div
                    className={`zone-body${dragOverZone === z.zone ? ' drag-over' : ''}`}
                    onDragOver={(e) => {
                      e.preventDefault()
                      setDragOverZone(z.zone)
                    }}
                    onDragLeave={(e) => {
                      if (e.currentTarget === e.target) setDragOverZone(null)
                    }}
                    onDrop={(e) => void onDropToZone(e, z.zone)}
                  >
                    <div className="drop-hint">松开放入{z.label}</div>
                    {zoneItems.length === 0 && (
                      <div className="empty-state" style={{ padding: '14px 0' }}>
                        <span className="material-symbols-outlined">history_edu</span>
                        暂无文章
                      </div>
                    )}
                    {zoneItems.map((it) => (
                      <div
                        className="row-item kanban-card"
                        key={it.id}
                        draggable
                        onDragStart={(e) => onDragStart(e, it)}
                        onDragEnd={onDragEnd}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => void onDropToCard(e, it)}
                        onClick={() => setOpenDoc(it)}
                      >
                        <div className="row-main">
                          <div className="row-title" title={it.title}>
                            {it.title}
                          </div>
                          <div className="row-sub">{fmtDate(it.updated_at)}</div>
                        </div>
                        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="icon-btn"
                            title="更多操作"
                            onClick={(e) => {
                              const r = e.currentTarget.getBoundingClientRect()
                              setMenuFor({ item: it, left: r.right, top: r.bottom + 4 })
                            }}
                          >
                            <span className="material-symbols-outlined">more_horiz</span>
                          </button>
                          <button className="icon-btn danger" title="丢弃" onClick={() => setDiscardTarget(it)}>
                            <span className="material-symbols-outlined">delete</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        </>
      )}

      {/* 新建 */}
      {addingZone && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAddingZone(null)}>
          <div className="dialog" style={{ width: 400 }}>
            <div className="dialog-header">新建文章（{ZONES.find((z) => z.zone === addingZone)?.label}）</div>
            <div className="dialog-body">
              <input
                className="field"
                value={newTitle}
                autoFocus
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doAdd()
                }}
                placeholder="文章标题"
              />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAddingZone(null)}>
                取消
              </button>
              <button className="btn btn-primary" disabled={!newTitle.trim()} onClick={() => void doAdd()}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 通用菜单：移动到 + 复制/导出（specs §3.2） */}
      {menuFor && (
        <>
          <div className="dialog-overlay" style={{ background: 'transparent' }} onMouseDown={() => setMenuFor(null)} />
          <div
            className="ctx-menu"
            style={{ position: 'fixed', top: menuFor.top, left: Math.max(8, menuFor.left - 140), zIndex: 300 }}
          >
            <div className="module-sub" style={{ padding: '2px 10px' }}>
              移动到
            </div>
            {ZONES.filter((z) => z.zone !== menuFor.item.zone).map((z) => (
              <button
                key={z.zone}
                className="btn btn-ghost"
                onClick={() => {
                  void moveTo(menuFor.item, z.zone)
                  setMenuFor(null)
                }}
              >
                {z.label}
              </button>
            ))}
            <div className="ctx-menu-sep" />
            <button className="btn btn-ghost" onClick={() => void copyMd(menuFor.item)}>
              <span className="material-symbols-outlined">content_copy</span>
              复制 Markdown
            </button>
            <button className="btn btn-ghost" disabled={exporting} onClick={() => void exportMd(menuFor.item)}>
              <span className="material-symbols-outlined">download</span>
              导出 .md
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={discardTarget != null}
        title="放入回收站"
        confirmText="丢弃"
        danger
        onConfirm={() => void doDiscard()}
        onCancel={() => setDiscardTarget(null)}
      >
        放入回收站，3 天后自动彻底删除；恢复时回到构思区。
      </ConfirmDialog>

      {/* LLM 未配置 → 去配置（全局规则） */}
      <GoConfigDialog
        open={goConfig}
        kind="llm"
        onGoConfig={() => setGoConfig(false)}
        onCancel={() => setGoConfig(false)}
      />
    </div>
  )
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
