// 格言库模块（格言库 specs 全量）
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MottoRecord } from '../../renderer/api'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { SettingsKeys } from '../../shared/types'

export interface MottosModuleProps {
  onOpenAi: (prefill?: string) => void
  bumpAi: () => void
}

const ZONES: { status: 'draft' | 'settled' | 'formal'; label: string }[] = [
  { status: 'draft', label: '草稿区' },
  { status: 'settled', label: '沉淀区' },
  { status: 'formal', label: '正式区' }
]

export default function MottosModule(props: MottosModuleProps) {
  const { toast } = useToast()
  const [mottos, setMottos] = useState<MottoRecord[]>([])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [generating, setGenerating] = useState(false)
  const [goConfig, setGoConfig] = useState(false)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  // MdDialog
  const [viewId, setViewId] = useState<number | null>(null)
  const viewing = mottos.find((m) => m.id === viewId) ?? null
  // 编辑
  const [editing, setEditing] = useState<MottoRecord | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editSource, setEditSource] = useState('')
  // 新增
  const [adding, setAdding] = useState(false)
  const [addContent, setAddContent] = useState('')
  const [addSource, setAddSource] = useState('')
  // 批量导入
  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')
  // 定时设置
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleTime, setScheduleTime] = useState('22:00')
  // 丢弃确认
  const [discardTarget, setDiscardTarget] = useState<MottoRecord | null>(null)
  // 拖拽排序（区内）
  const dragIdRef = useRef<number | null>(null)
  // 快速导航（优化建议区）：跳转到目标区——折叠则先展开，再平滑滚动到该区
  const zoneRefs = useRef<Record<string, HTMLElement | null>>({})
  const jumpToZone = (status: string): void => {
    if (collapsed[status]) setCollapsed((c) => ({ ...c, [status]: false }))
    // 折叠刚展开时 DOM 未渲染，等下一帧再滚动
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        zoneRefs.current[status]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    })
  }

  const load = useCallback(async () => {
    const rows = await window.api.mottos.list()
    setMottos(rows)
  }, [])

  useEffect(() => {
    void load()
    void window.api.settings.get(SettingsKeys.MottoSchedule).then((t) => {
      if (t) setScheduleTime(t)
    })
  }, [load])

  // keep-alive：切回格言库时刷新（定时任务可能在后台已生成）
  useModuleActivated('mottos', () => void load())

  const generate = async (): Promise<void> => {
    if (generating) return
    setGenerating(true)
    try {
      const r = await window.api.mottos.generate()
      toast(`本次生成 ${r.generated} 条，去重后入库 ${r.inserted} 条`)
      await load()
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
      else setFailMsg(msg)
    } finally {
      setGenerating(false)
    }
  }

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    await window.api.mottos.discard(discardTarget.id)
    toast('已放入回收站')
    setDiscardTarget(null)
    await load()
  }

  const saveEdit = async (): Promise<void> => {
    if (!editing) return
    if (!editContent.trim()) return
    await window.api.mottos.update(editing.id, editContent.trim(), editSource.trim())
    setEditing(null)
    await load()
  }

  const doAdd = async (): Promise<void> => {
    if (!addContent.trim()) return
    await window.api.mottos.create(addContent.trim(), addSource.trim(), 'formal')
    setAdding(false)
    setAddContent('')
    setAddSource('')
    toast('已新增到正式区')
    await load()
  }

  const doImport = async (): Promise<void> => {
    const lines = importText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) return
    // 解析「格言 —— 出处」/「格言——出处」
    const items: { content: string; source: string }[] = lines.map((l) => {
      const m = l.match(/^(.+?)\s*——\s*(.+)$/)
      return m ? { content: m[1].trim(), source: m[2].trim() } : { content: l, source: '' }
    })
    // 查重（与现有全部格言）
    const existing = new Set(mottos.map((m) => m.content.replace(/\s/g, '')))
    const fresh = items.filter((it) => !existing.has(it.content.replace(/\s/g, '')))
    for (const it of fresh) {
      await window.api.mottos.create(it.content, it.source, 'formal')
    }
    toast(`共 ${items.length} 条，去重后导入 ${fresh.length} 条`)
    setImporting(false)
    setImportText('')
    await load()
  }

  const saveSchedule = async (): Promise<void> => {
    if (!/^\d{1,2}:\d{2}$/.test(scheduleTime)) {
      toast('时间格式：HH:mm')
      return
    }
    await window.api.settings.set(SettingsKeys.MottoSchedule, scheduleTime)
    toast('定时已保存')
    setScheduleOpen(false)
  }

  /** 复制「格言 —— 出处」（无出处只复制正文） */
  const copyMotto = async (m: MottoRecord): Promise<void> => {
    const text = m.source.trim() ? `${m.content} —— ${m.source.trim()}` : m.content
    await window.api.clipboard.writeText(text)
    toast('已复制')
  }

  // 区内拖拽排序（HTML5 DnD，模式同灵感泉）
  const onDragStart = (e: React.DragEvent, m: MottoRecord): void => {
    dragIdRef.current = m.id
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(m.id))
    ;(e.currentTarget as HTMLElement).classList.add('dragging')
  }
  const onDragEnd = (e: React.DragEvent): void => {
    ;(e.currentTarget as HTMLElement).classList.remove('dragging')
    dragIdRef.current = null
  }
  /** 拖到某行上 → 插入该位置：目标 sort 减半差，随后全区归一化 */
  const onDropToRow = async (e: React.DragEvent, target: MottoRecord): Promise<void> => {
    e.preventDefault()
    const id = Number(e.dataTransfer.getData('text/plain')) || dragIdRef.current
    if (!id || id === target.id) return
    const source = mottos.find((m) => m.id === id)
    if (!source || source.status !== target.status) return // 仅区内排序，跨区走流转按钮
    const zoneItems = mottos
      .filter((m) => m.status === target.status)
      .sort((a, b) => a.sort - b.sort || a.id - b.id)
    const targetIdx = zoneItems.findIndex((m) => m.id === target.id)
    const sourceIdx = zoneItems.findIndex((m) => m.id === id)
    const next = [...zoneItems]
    next.splice(sourceIdx, 1)
    next.splice(targetIdx, 0, source)
    await window.api.mottos.reorder(next.map((m, i) => ({ id: m.id, sort: i })))
    await load()
  }

  return (
    <div className="module-page mottos-page">
      <div className="module-header">
        <span className="material-symbols-outlined">format_quote</span>
        <span className="module-title">格言库</span>
        <span className="module-sub">三级流转：草稿 → 沉淀 → 正式</span>
      </div>

      {/* 快速导航（优化建议区）：点击跳转到对应区 */}
      <div className="zone-nav">
        {ZONES.map((z) => (
          <button key={z.status} className="zone-nav-btn" onClick={() => jumpToZone(z.status)}>
            <span>{z.label}</span>
            <span className="zone-count">{mottos.filter((m) => m.status === z.status).length}</span>
          </button>
        ))}
      </div>

      {ZONES.map((z) => {
        const items = mottos.filter((m) => m.status === z.status)
        const isCollapsed = collapsed[z.status]
        return (
          <section
            className="zone"
            key={z.status}
            ref={(el) => {
              zoneRefs.current[z.status] = el
            }}
          >
            <div
              className="zone-header"
              onClick={() => setCollapsed((c) => ({ ...c, [z.status]: !c[z.status] }))}
            >
              <span className="material-symbols-outlined">
                {isCollapsed ? 'expand_more' : 'expand_less'}
              </span>
              <span>{z.label}</span>
              <span className="zone-count">{items.length}</span>
              <div className="zone-actions" onClick={(e) => e.stopPropagation()}>
                {z.status === 'draft' && (
                  <>
                    <button
                      className="btn btn-primary"
                      onClick={() => void generate()}
                      disabled={generating}
                    >
                      <span className="material-symbols-outlined">auto_awesome</span>
                      {generating ? '生成中…' : '来10条格言'}
                    </button>
                    <button className="icon-btn" title="定时设置" onClick={() => setScheduleOpen(true)}>
                      <span className="material-symbols-outlined">schedule</span>
                    </button>
                  </>
                )}
                {z.status === 'formal' && (
                  <>
                    <button className="btn" onClick={() => setAdding(true)}>
                      <span className="material-symbols-outlined">add</span>
                      新增格言
                    </button>
                    <button className="btn" onClick={() => setImporting(true)}>
                      <span className="material-symbols-outlined">upload</span>
                      批量导入
                    </button>
                  </>
                )}
              </div>
            </div>
            {!isCollapsed && (
              <div className="zone-body">
                {items.length === 0 && (
                  <div className="empty-state">
                    <span className="material-symbols-outlined">format_quote</span>
                    暂无格言
                  </div>
                )}
                {items.map((m, idx) => (
                  <div
                    className="row-item motto-row"
                    key={m.id}
                    draggable
                    onDragStart={(e) => onDragStart(e, m)}
                    onDragEnd={onDragEnd}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => void onDropToRow(e, m)}
                    onClick={() => m.status === 'formal' && m.note_path && setViewId(m.id)}
                  >
                    <span className="row-index">{idx + 1}</span>
                    <div className="row-main">
                      <div className="motto-line">
                        <span className="motto-content" title={m.content}>
                          {m.content}
                        </span>
                        <span className="motto-source">—— {m.source || '（出处待补）'}</span>
                      </div>
                    </div>
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      {m.origin === 'ai' && <span className="badge">AI</span>}
                      {z.status === 'draft' && (
                        <button
                          className="icon-btn"
                          title="加入沉淀区"
                          onClick={() => void window.api.mottos.setStatus(m.id, 'settled').then(load)}
                        >
                          <span className="material-symbols-outlined">moving</span>
                        </button>
                      )}
                      {z.status === 'settled' && (
                        <>
                          <button
                            className="icon-btn"
                            title="加入正式区"
                            onClick={() => void window.api.mottos.setStatus(m.id, 'formal').then(load)}
                          >
                            <span className="material-symbols-outlined">workspace_premium</span>
                          </button>
                        </>
                      )}
                      {z.status === 'formal' && (
                        <button
                          className="icon-btn"
                          title="编辑"
                          onClick={() => {
                            setEditing(m)
                            setEditContent(m.content)
                            setEditSource(m.source)
                          }}
                        >
                          <span className="material-symbols-outlined">edit</span>
                        </button>
                      )}
                      <button
                        className="icon-btn"
                        title="复制格言+出处"
                        onClick={() => void copyMotto(m)}
                      >
                        <span className="material-symbols-outlined">content_copy</span>
                      </button>
                      <button className="icon-btn danger" title="丢弃" onClick={() => setDiscardTarget(m)}>
                        <span className="material-symbols-outlined">delete</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )
      })}

      {/* 正式区笔记弹窗 */}
      <MdDialog
        open={viewing != null && !!viewing?.note_path}
        title={viewing?.content ?? ''}
        filePath={viewing?.note_path ?? ''}
        onClose={() => setViewId(null)}
        onChanged={load}
      />

      {/* 编辑弹窗 */}
      {editing && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="dialog" style={{ width: 480 }}>
            <div className="dialog-header">编辑格言</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <textarea
                className="field"
                rows={3}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                placeholder="格言正文"
              />
              <input
                className="field"
                value={editSource}
                onChange={(e) => setEditSource(e.target.value)}
                placeholder="出处（书名/作者/AI 编撰）"
              />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setEditing(null)}>取消</button>
              <button className="btn btn-primary" onClick={() => void saveEdit()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 新增弹窗 */}
      {adding && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAdding(false)}>
          <div className="dialog" style={{ width: 480 }}>
            <div className="dialog-header">新增格言（正式区）</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <textarea
                className="field"
                rows={3}
                value={addContent}
                onChange={(e) => setAddContent(e.target.value)}
                placeholder="格言正文"
              />
              <input
                className="field"
                value={addSource}
                onChange={(e) => setAddSource(e.target.value)}
                placeholder="出处"
              />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAdding(false)}>取消</button>
              <button className="btn btn-primary" onClick={() => void doAdd()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 批量导入 */}
      {importing && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setImporting(false)}>
          <div className="dialog" style={{ width: 560 }}>
            <div className="dialog-header">批量导入（正式区）</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="module-sub">每行一条，格式：格言 —— 出处（无分隔则出处留空）</div>
              <textarea
                className="field"
                rows={10}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={'示例：\n生活是苦难的，我又划着我的断桨出发了。—— 博尔赫斯\n知行合一'}
              />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setImporting(false)}>取消</button>
              <button className="btn btn-primary" onClick={() => void doImport()}>导入</button>
            </div>
          </div>
        </div>
      )}

      {/* 定时设置 */}
      {scheduleOpen && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setScheduleOpen(false)}>
          <div className="dialog" style={{ width: 360 }}>
            <div className="dialog-header">定时生成设置</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="module-sub">每天到点自动生成 10 条（App 未运行时跳过）</div>
              <input
                className="field"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                placeholder="HH:mm"
              />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setScheduleOpen(false)}>取消</button>
              <button className="btn btn-primary" onClick={() => void saveSchedule()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 丢弃二次确认 */}
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

      {/* LLM 未配置引导 */}
      <GoConfigDialog open={goConfig} kind="llm" onGoConfig={() => setGoConfig(false)} onCancel={() => setGoConfig(false)} />

      {/* 生成失败 */}
      {failMsg && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setFailMsg(null)}>
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-header">生成失败</div>
            <div className="dialog-body" style={{ lineHeight: 1.7, wordBreak: 'break-all' }}>{failMsg}</div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setFailMsg(null)}>关闭</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setFailMsg(null)
                  void generate()
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
