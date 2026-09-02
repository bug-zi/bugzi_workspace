// 灵感泉模块（灵感泉 specs 全量）：四区看板、拖拽/菜单移动、标题编辑、丢弃
import { useCallback, useEffect, useRef, useState } from 'react'
import type { InspirationRecord } from '../../renderer/api'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

const ZONES: { status: InspirationRecord['status']; label: string }[] = [
  { status: 'draft', label: '草稿区' },
  { status: 'project', label: '立项区' },
  { status: 'develop', label: '开发区' },
  { status: 'archive', label: '归档区' }
]

export default function InspirationsModule() {
  const { toast } = useToast()
  const [items, setItems] = useState<InspirationRecord[]>([])
  const [openDoc, setOpenDoc] = useState<InspirationRecord | null>(null)
  const [addingZone, setAddingZone] = useState<InspirationRecord['status'] | null>(null)
  const [newTitle, setNewTitle] = useState('')
  // 移动菜单
  const [menuFor, setMenuFor] = useState<InspirationRecord | null>(null)
  // 丢弃
  const [discardTarget, setDiscardTarget] = useState<InspirationRecord | null>(null)
  // 拖拽状态
  const dragIdRef = useRef<number | null>(null)
  const [dragOverZone, setDragOverZone] = useState<string | null>(null)

  const load = useCallback(async () => {
    setItems(await window.api.inspirations.list())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // keep-alive：切回灵感泉时刷新（回收站恢复操作可能改动了列表）
  useModuleActivated('inspirations', () => void load())

  const itemsOf = (status: InspirationRecord['status']): InspirationRecord[] =>
    items.filter((i) => i.status === status).sort((a, b) => a.sort - b.sort || a.id - b.id)

  const doAdd = async (): Promise<void> => {
    if (!addingZone || !newTitle.trim()) return
    await window.api.inspirations.create(newTitle.trim(), addingZone)
    setAddingZone(null)
    setNewTitle('')
    await load()
  }

  /** 跨区/区内移动：目标区末尾插入（specs §3.3 即时生效） */
  const moveTo = async (item: InspirationRecord, status: InspirationRecord['status']): Promise<void> => {
    if (item.status === status) return
    const target = itemsOf(status)
    const sort = (target.length ? Math.max(...target.map((t) => t.sort)) : 0) + 1
    await window.api.inspirations.move(item.id, status, sort)
    await load()
  }

  // HTML5 拖拽
  const onDragStart = (e: React.DragEvent, item: InspirationRecord): void => {
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
  const onDropToZone = async (e: React.DragEvent, status: InspirationRecord['status']): Promise<void> => {
    e.preventDefault()
    setDragOverZone(null)
    const id = Number(e.dataTransfer.getData('text/plain')) || dragIdRef.current
    if (!id) return
    const item = items.find((i) => i.id === id)
    if (!item) return
    if (item.status === status) return // 区内排序：放下到区即无操作（排序用卡片间插入）
    await moveTo(item, status)
  }
  /** 区内排序：拖到某卡片前插入 */
  const onDropToCard = async (e: React.DragEvent, target: InspirationRecord): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverZone(null)
    const id = Number(e.dataTransfer.getData('text/plain')) || dragIdRef.current
    if (!id || id === target.id) return
    const source = items.find((i) => i.id === id)
    if (!source) return
    if (source.status !== target.status) {
      // 跨区拖到具体卡片 → 移动到该区该位置
      await window.api.inspirations.move(source.id, target.status, target.sort - 0.5)
      await normalizeSort(target.status)
    } else {
      await window.api.inspirations.move(source.id, source.status, target.sort - 0.5)
      await normalizeSort(target.status)
    }
    await load()
  }
  /** 重排后归一化 sort（0..n） */
  const normalizeSort = async (status: InspirationRecord['status']): Promise<void> => {
    const zoneItems = items
      .filter((i) => i.status === status)
      .sort((a, b) => a.sort - b.sort || a.id - b.id)
    const moves = zoneItems.map((i, idx) => ({ id: i.id, status, sort: idx }))
    if (moves.length > 0) await window.api.inspirations.reorder(moves)
  }

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    await window.api.inspirations.discard(discardTarget.id)
    toast('已放入回收站')
    setDiscardTarget(null)
    setOpenDoc(null)
    await load()
  }

  return (
    <div className="module-page" style={{ maxWidth: 1200 }}>
      <div className="module-header">
        <span className="material-symbols-outlined">lightbulb</span>
        <span className="module-title">灵感泉</span>
        <span className="module-sub">想法流转：草稿 → 立项 → 开发 → 归档（可自由跨区拖拽）</span>
      </div>

      <div className="kanban">
        {ZONES.map((z) => {
          const zoneItems = itemsOf(z.status)
          return (
            <section className="zone" key={z.status}>
              <div className="zone-header">
                <span>{z.label}</span>
                <span className="zone-count">{zoneItems.length}</span>
                <div className="zone-actions">
                  <button
                    className="icon-btn"
                    title="新建"
                    onClick={() => {
                      setAddingZone(z.status)
                      setNewTitle('')
                    }}
                  >
                    <span className="material-symbols-outlined">add</span>
                  </button>
                </div>
              </div>
              <div
                className={`zone-body${dragOverZone === z.status ? ' drag-over' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOverZone(z.status)
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget === e.target) setDragOverZone(null)
                }}
                onDrop={(e) => void onDropToZone(e, z.status)}
              >
                <div className="drop-hint">松开放入{z.label}</div>
                {zoneItems.length === 0 && (
                  <div className="empty-state" style={{ padding: '14px 0' }}>
                    <span className="material-symbols-outlined">lightbulb</span>
                    暂无灵感
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
                      <button className="icon-btn" title="移动到" onClick={() => setMenuFor(it)}>
                        <span className="material-symbols-outlined">drive_file_move</span>
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

      {/* 文档 MdDialog（标题可编辑，改后列表同步） */}
      <MdDialog
        open={openDoc != null}
        title={openDoc?.title ?? ''}
        filePath={openDoc?.md_path ?? ''}
        onClose={() => setOpenDoc(null)}
        onChanged={() => void load()}
        onTitleChange={
          openDoc
            ? (t) => {
                void window.api.inspirations.updateTitle(openDoc.id, t).then(load)
                setOpenDoc({ ...openDoc, title: t })
              }
            : undefined
        }
      />

      {/* 新建 */}
      {addingZone && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAddingZone(null)}>
          <div className="dialog" style={{ width: 400 }}>
            <div className="dialog-header">
              新建灵感（{ZONES.find((z) => z.status === addingZone)?.label}）
            </div>
            <div className="dialog-body">
              <input
                className="field"
                value={newTitle}
                autoFocus
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doAdd()
                }}
                placeholder="灵感标题"
              />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAddingZone(null)}>取消</button>
              <button className="btn btn-primary" disabled={!newTitle.trim()} onClick={() => void doAdd()}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 移动菜单 */}
      {menuFor && (
        <>
          <div className="dialog-overlay" style={{ background: 'transparent' }} onMouseDown={() => setMenuFor(null)} />
          <div className="ctx-menu" style={{ position: 'fixed', zIndex: 300 }}>
            <div className="module-sub" style={{ padding: '2px 10px' }}>移动到</div>
            {ZONES.filter((z) => z.status !== menuFor.status).map((z) => (
              <button
                key={z.status}
                className="btn btn-ghost"
                onClick={() => {
                  void moveTo(menuFor, z.status)
                  setMenuFor(null)
                }}
              >
                {z.label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* 丢弃 */}
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

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
