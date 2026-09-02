// 灵感泉模块（灵感泉 specs 全量）：四区看板、拖拽/菜单移动、标题编辑、丢弃
// v2.0（specs §6）：来5条灵感 / AI 完善（预览追加）/ 问 AI 预填边栏
import { useCallback, useEffect, useRef, useState } from 'react'
import type { InspirationRecord } from '../../renderer/api'
import MdDialog from '../../components/MdDialog'
import MdView from '../../components/MdView'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

const ZONES: { status: InspirationRecord['status']; label: string }[] = [
  { status: 'draft', label: '草稿区' },
  { status: 'project', label: '立项区' },
  { status: 'develop', label: '开发区' },
  { status: 'archive', label: '归档区' }
]

export interface InspirationsModuleProps {
  onOpenAi: (prefill?: string) => void
}

export default function InspirationsModule(props: InspirationsModuleProps) {
  const { toast } = useToast()
  const [items, setItems] = useState<InspirationRecord[]>([])
  const [openDoc, setOpenDoc] = useState<InspirationRecord | null>(null)
  const [addingZone, setAddingZone] = useState<InspirationRecord['status'] | null>(null)
  const [newTitle, setNewTitle] = useState('')
  // 移动菜单
  const [menuFor, setMenuFor] = useState<{ item: InspirationRecord; left: number; top: number } | null>(null)
  // 丢弃
  const [discardTarget, setDiscardTarget] = useState<InspirationRecord | null>(null)
  // 拖拽状态
  const dragIdRef = useRef<number | null>(null)
  const [dragOverZone, setDragOverZone] = useState<string | null>(null)
  // v2.0：AI 生成/完善
  const [generating, setGenerating] = useState(false)
  const [goConfig, setGoConfig] = useState(false)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const [refineFor, setRefineFor] = useState<InspirationRecord | null>(null)
  const [refineResult, setRefineResult] = useState<string | null>(null)
  const [refining, setRefining] = useState(false)

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

  // ---------- v2.0：AI 生成/完善/问 AI（specs §6） ----------

  /** 「来5条灵感」：画像生成 5 条入草稿区；未配置弹「去配置」，其余失败弹框可重试 */
  const doGenerate = async (): Promise<void> => {
    if (generating) return
    setGenerating(true)
    try {
      const r = await window.api.inspirations.generate()
      toast(`已生成 ${r.inserted} 条灵感，已入草稿区`)
      await load()
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
      else setFailMsg(msg)
    } finally {
      setGenerating(false)
    }
  }

  /** AI 完善：生成扩展建议 → 预览弹窗（specs §6.3，失败 toast 后关闭预览） */
  const doRefine = async (item: InspirationRecord): Promise<void> => {
    setMenuFor(null)
    setRefineFor(item)
    setRefineResult(null)
    setRefining(true)
    try {
      const content = await window.api.inspirations.refine(item.id)
      setRefineResult(content)
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
      else toast(`AI 完善失败：${msg}`)
      setRefineFor(null)
    } finally {
      setRefining(false)
    }
  }

  /** 预览确认后追加进该条 md 末尾（段落时间戳以追加时刻为准） */
  const doAppendRefine = async (): Promise<void> => {
    if (!refineFor || !refineResult) return
    try {
      await window.api.inspirations.appendRefine(refineFor.id, refineResult)
      toast('已追加到文档')
      setRefineFor(null)
      setRefineResult(null)
      await load()
    } catch (e) {
      toast(`追加失败：${(e as Error).message}`)
    }
  }

  /** 问 AI：预填灵感上下文直达边栏（specs §6.4；正文读失败仅用标题） */
  const askAi = async (item: InspirationRecord): Promise<void> => {
    setMenuFor(null)
    let prefill = `请围绕我的项目灵感「${item.title}」帮我头脑风暴：`
    try {
      const raw = await window.api.md.read(item.md_path)
      const body = raw.replace(/^#\s.*\n?/, '').replace(/\s+/g, ' ').trim().slice(0, 300)
      if (body) prefill += body
    } catch {
      /* 正文读取失败仅用标题 */
    }
    props.onOpenAi(prefill)
  }

  return (
    <div className="module-page" style={{ maxWidth: 1200 }}>
      <div className="module-header">
        <span className="material-symbols-outlined">lightbulb</span>
        <span className="module-title">灵感泉</span>
        <span className="module-sub">想法流转：草稿 → 立项 → 开发 → 归档（可自由跨区拖拽）</span>
        <button
          className="btn"
          disabled={generating}
          style={{ marginLeft: 'auto' }}
          onClick={() => void doGenerate()}
        >
          {generating ? '生成中…' : '来5条灵感'}
        </button>
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
                      <div className="row-title-wrap">
                        <span className="row-title" title={it.title}>
                          {it.title}
                        </span>
                        {it.origin === 'ai' && <span className="badge insp-ai-badge">AI</span>}
                      </div>
                      <div className="row-sub">{fmtDate(it.updated_at)}</div>
                    </div>
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="icon-btn"
                        title="更多操作"
                        onClick={(e) => {
                          // 菜单锚定触发按钮（优化建议区：原 ctx-menu 写死 top/left 不跟随按钮）
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
          <div
            className="ctx-menu"
            style={{ position: 'fixed', top: menuFor.top, left: Math.max(8, menuFor.left - 140), zIndex: 300 }}
          >
            <div className="module-sub" style={{ padding: '2px 10px' }}>移动到</div>
            {ZONES.filter((z) => z.status !== menuFor.item.status).map((z) => (
              <button
                key={z.status}
                className="btn btn-ghost"
                onClick={() => {
                  void moveTo(menuFor.item, z.status)
                  setMenuFor(null)
                }}
              >
                {z.label}
              </button>
            ))}
            {/* v2.0（specs §3.5/§6）：通用菜单第二组 —— AI 完善 / 问 AI */}
            <div className="ctx-menu-sep" />
            <button className="btn btn-ghost" onClick={() => void doRefine(menuFor.item)}>
              <span className="material-symbols-outlined">auto_awesome</span>
              AI 完善
            </button>
            <button className="btn btn-ghost" onClick={() => void askAi(menuFor.item)}>
              <span className="material-symbols-outlined">forum</span>
              问 AI
            </button>
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

      {/* v2.0：AI 完善预览（specs §6.3，渲染最终追加效果，时间戳为近似展示） */}
      {refineFor && (
        <div
          className="dialog-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && setRefineFor(null)}
        >
          <div className="dialog" style={{ width: 560 }}>
            <div className="dialog-header">AI 完善 · {refineFor.title}</div>
            <div className="dialog-body" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
              {refining || !refineResult ? (
                <div className="empty-state" style={{ padding: '24px 0' }}>
                  <span className="material-symbols-outlined spin">progress_activity</span>
                  正在生成扩展建议…
                </div>
              ) : (
                <MdView md={`## AI 补充 · ${fmtDateTime(new Date())}\n\n${refineResult}`} />
              )}
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setRefineFor(null)}>
                放弃
              </button>
              <button
                className="btn btn-primary"
                disabled={refining || !refineResult}
                onClick={() => void doAppendRefine()}
              >
                追加到文档
              </button>
            </div>
          </div>
        </div>
      )}

      {/* v2.0：LLM 未配置 → 去配置（全局规则） */}
      <GoConfigDialog
        open={goConfig}
        kind="llm"
        onGoConfig={() => setGoConfig(false)}
        onCancel={() => setGoConfig(false)}
      />

      {/* v2.0：生成失败（可重试，同格言库模式） */}
      {failMsg && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setFailMsg(null)}>
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-header">生成失败</div>
            <div className="dialog-body" style={{ lineHeight: 1.7, wordBreak: 'break-all' }}>
              {failMsg}
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setFailMsg(null)}>
                关闭
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setFailMsg(null)
                  void doGenerate()
                }}
              >
                重试
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 预览弹窗段落标题时间戳（近似展示；实际以追加时刻为准） */
function fmtDateTime(d: Date): string {
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${mm}`
}
