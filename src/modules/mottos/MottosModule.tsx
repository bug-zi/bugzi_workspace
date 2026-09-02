// 格言库模块（格言库 specs 全量 + v2.0 §7：标签/搜索/生成/去重）
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  const [addTags, setAddTags] = useState('')
  // 编辑
  const [editTags, setEditTags] = useState('')
  // v2.0 §7.2 搜索 + §7.1 标签筛选/行内编辑
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [tagEditId, setTagEditId] = useState<number | null>(null)
  const [tagInput, setTagInput] = useState('')
  // 导航栏标签弹层开关 + 外部点击收起判定容器
  const [tagPopOpen, setTagPopOpen] = useState(false)
  const tagNavRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!tagPopOpen) return
    const onDown = (e: MouseEvent): void => {
      if (tagNavRef.current && e.target instanceof Node && !tagNavRef.current.contains(e.target)) {
        setTagPopOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [tagPopOpen])
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

  // ---------- v2.0：标签聚合 + 过滤（§7.1/§7.2） ----------
  /** 全部标签（按使用条数降序，同数按名称），筛选条数据源 */
  const allTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of mottos) {
      for (const t of m.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
  }, [mottos])

  const filterActive = (searchOpen && searchText.trim() !== '') || tagFilter != null

  /** 搜索（正文/出处/标签，不区分大小写）AND 标签筛选（单选） */
  const visibleMotto = useCallback(
    (m: MottoRecord): boolean => {
      const kw = searchText.trim().toLowerCase()
      if (kw) {
        const hit =
          m.content.toLowerCase().includes(kw) ||
          m.source.toLowerCase().includes(kw) ||
          (m.tags ?? []).some((t) => t.toLowerCase().includes(kw))
        if (!hit) return false
      }
      if (tagFilter != null && !(m.tags ?? []).includes(tagFilter)) return false
      return true
    },
    [searchText, tagFilter]
  )

  /** 区计数：过滤时显示 命中/总数 */
  const zoneCountLabel = useCallback(
    (status: string): string => {
      const total = mottos.filter((m) => m.status === status).length
      if (!filterActive) return String(total)
      return `${mottos.filter((m) => m.status === status && visibleMotto(m)).length}/${total}`
    },
    [mottos, filterActive, visibleMotto]
  )

  /** 标签弹窗输入解析：逗号（,，）或顿号（、）分隔多个 */
  const parseTagInput = (raw: string): string[] =>
    raw
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean)

  /** 快速添加候选：已有标签中不在当前输入里的（最多 8 个） */
  const tagsNotIn = useCallback(
    (raw: string): string[] => {
      const cur = new Set(parseTagInput(raw))
      return allTags
        .filter(([t]) => !cur.has(t))
        .slice(0, 8)
        .map(([t]) => t)
    },
    [allTags]
  )

  /** 弹窗输入框追加一个标签（顿号衔接） */
  const appendTagToInput = (raw: string, t: string): string =>
    raw.trim() ? `${raw.replace(/[，、,\s]+$/, '')}、${t}` : t

  /** 行内标签编辑：添加（回车确认，同名去重） */
  const addTagTo = async (m: MottoRecord, raw: string): Promise<void> => {
    const t = raw.trim()
    if (!t) return
    const next = [...(m.tags ?? [])]
    if (!next.includes(t)) next.push(t)
    await window.api.mottos.setTags(m.id, next)
    setMottos((prev) => prev.map((x) => (x.id === m.id ? { ...x, tags: next } : x)))
  }

  /** 行内标签编辑：删除 */
  const removeTagFrom = async (m: MottoRecord, tag: string): Promise<void> => {
    const next = (m.tags ?? []).filter((t) => t !== tag)
    await window.api.mottos.setTags(m.id, next)
    setMottos((prev) => prev.map((x) => (x.id === m.id ? { ...x, tags: next } : x)))
  }

  const generate = async (): Promise<void> => {
    if (generating) return
    setGenerating(true)
    try {
      const r = await window.api.mottos.generate()
      toast(
        `本次生成 ${r.generated} 条（摘录 ${r.excerptInserted} + 编撰 ${r.composedInserted}），去重后入库 ${r.inserted} 条`
      )
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
    await window.api.mottos.update(editing.id, editContent.trim(), editSource.trim(), parseTagInput(editTags))
    setEditing(null)
    await load()
  }

  const doAdd = async (): Promise<void> => {
    if (!addContent.trim()) return
    await window.api.mottos.create(addContent.trim(), addSource.trim(), 'formal', parseTagInput(addTags))
    setAdding(false)
    setAddContent('')
    setAddSource('')
    setAddTags('')
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
    // 查重（v2.0 §7.4：主进程规范化 + 包含判重，仅未删除区）
    const fresh: { content: string; source: string }[] = []
    for (const it of items) {
      if (!(await window.api.mottos.checkDuplicate(it.content))) fresh.push(it)
    }
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

      {/* 吸顶导航栏（优化建议区 + v2.0）：左侧区导航跳转，右侧标签筛选 + 搜索，滚动时常驻可用 */}
      <div className="zone-nav">
        {ZONES.map((z) => (
          <button key={z.status} className="zone-nav-btn" onClick={() => jumpToZone(z.status)}>
            <span>{z.label}</span>
            <span className="zone-count">{zoneCountLabel(z.status)}</span>
          </button>
        ))}
        <div className="zone-nav-right">
          {/* 标签筛选：点击图标弹层列出全部标签，快速筛选（§7.1） */}
          <div className="zone-nav-pop-wrap" ref={tagNavRef}>
            <button
              className={`zone-nav-btn${tagPopOpen || tagFilter != null ? ' on' : ''}`}
              title="标签筛选"
              onClick={() => setTagPopOpen((v) => !v)}
            >
              <span className="material-symbols-outlined">sell</span>
              {tagFilter != null && <span className="zone-count">{tagFilter}</span>}
            </button>
            {tagPopOpen && (
              <div className="tag-pop">
                {allTags.length === 0 ? (
                  <span className="tag-pop-empty">还没有任何标签</span>
                ) : (
                  allTags.map(([t, n]) => (
                    <button
                      key={t}
                      className={`tag-chip${tagFilter === t ? ' active' : ''}`}
                      title={`${tagFilter === t ? '取消筛选' : '筛选'}标签「${t}」：${n} 条`}
                      onClick={() => {
                        setTagFilter((cur) => (cur === t ? null : t))
                        setTagPopOpen(false)
                      }}
                    >
                      {t}
                      <span className="tag-chip-count">{n}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {/* 搜索：图标展开输入框，实时过滤三区（§7.2） */}
          {searchOpen && (
            <input
              className="field search-input nav-search"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchText('')
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              placeholder="搜索正文 / 出处 / 标签…"
              autoFocus
            />
          )}
          <button
            className={`zone-nav-btn${searchOpen ? ' on' : ''}`}
            title={searchOpen ? '关闭搜索' : '搜索格言'}
            onClick={() => {
              setSearchOpen((v) => !v)
              setSearchText('')
            }}
          >
            <span className="material-symbols-outlined">{searchOpen ? 'close' : 'search'}</span>
          </button>
        </div>
      </div>

      {/* v2.0 §7.1 标签汇总条：聚合全部标签，单选切换（与导航栏弹层同数据源） */}
      {allTags.length > 0 && (
        <div className="tag-bar">
          <span className="material-symbols-outlined tag-bar-icon">sell</span>
          {allTags.map(([t, n]) => (
            <button
              key={t}
              className={`tag-chip${tagFilter === t ? ' active' : ''}`}
              onClick={() => setTagFilter((cur) => (cur === t ? null : t))}
              title={`筛选标签「${t}」：${n} 条`}
            >
              {t}
              <span className="tag-chip-count">{n}</span>
            </button>
          ))}
        </div>
      )}

      {ZONES.map((z) => {
        const zoneAll = mottos.filter((m) => m.status === z.status)
        // v2.0：搜索 + 标签筛选作用于三区（§7.1/§7.2）
        const items = zoneAll.filter(visibleMotto)
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
                {zoneAll.length === 0 ? (
                  <div className="empty-state">
                    <span className="material-symbols-outlined">format_quote</span>
                    暂无格言
                  </div>
                ) : items.length === 0 ? (
                  <div className="empty-state">
                    <span className="material-symbols-outlined">search_off</span>
                    无匹配
                  </div>
                ) : null}
                {items.map((m, idx) => (
                  <Fragment key={m.id}>
                  <div
                    className="row-item motto-row"
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
                        {(m.tags ?? []).length > 0 && (
                          <span className="motto-tags" title={m.tags.join('、')}>
                            {m.tags.slice(0, 3).map((t) => (
                              <span key={t} className="tag-chip mini">
                                {t}
                              </span>
                            ))}
                            {m.tags.length > 3 && (
                              <span className="tag-chip mini more">+{m.tags.length - 3}</span>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      {/* AI 徽章仅编撰条显示（v2.0：现实摘录条不打） */}
                      {m.origin === 'ai' && m.gen_kind !== 'excerpt' && <span className="badge">AI</span>}
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
                            setEditTags((m.tags ?? []).join('、'))
                          }}
                        >
                          <span className="material-symbols-outlined">edit</span>
                        </button>
                      )}
                      <button
                        className="icon-btn"
                        title="标签"
                        onClick={() => {
                          setTagEditId((cur) => (cur === m.id ? null : m.id))
                          setTagInput('')
                        }}
                      >
                        <span className="material-symbols-outlined">sell</span>
                      </button>
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
                  {/* v2.0 §7.1 行内标签编辑条：回车添加，点 × 删除；虚线胶囊快速添加已有标签 */}
                  {tagEditId === m.id && (
                    <div className="tag-edit-row">
                      {(m.tags ?? []).map((t) => (
                        <span key={t} className="tag-chip removable">
                          {t}
                          <button onClick={() => void removeTagFrom(m, t)} title={`删除标签「${t}」`}>
                            <span className="material-symbols-outlined">close</span>
                          </button>
                        </span>
                      ))}
                      {tagsNotIn((m.tags ?? []).join('、')).map((t) => (
                        <button
                          key={t}
                          className="tag-chip addable"
                          title={`添加已有标签「${t}」`}
                          onClick={() => void addTagTo(m, t)}
                        >
                          <span className="material-symbols-outlined">add</span>
                          {t}
                        </button>
                      ))}
                      <input
                        className="field tag-input"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            void addTagTo(m, tagInput)
                            setTagInput('')
                          }
                        }}
                        placeholder="输入标签，回车添加"
                      />
                    </div>
                  )}
                  </Fragment>
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
              <input
                className="field"
                value={editTags}
                onChange={(e) => setEditTags(e.target.value)}
                placeholder="标签（可选，逗号/顿号分隔多个）"
              />
              {tagsNotIn(editTags).length > 0 && (
                <div className="dialog-quick-tags">
                  {tagsNotIn(editTags).map((t) => (
                    <button
                      key={t}
                      className="tag-chip addable"
                      title={`添加已有标签「${t}」`}
                      onClick={() => setEditTags((v) => appendTagToInput(v, t))}
                    >
                      <span className="material-symbols-outlined">add</span>
                      {t}
                    </button>
                  ))}
                </div>
              )}
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
              <input
                className="field"
                value={addTags}
                onChange={(e) => setAddTags(e.target.value)}
                placeholder="标签（可选，逗号/顿号分隔多个）"
              />
              {tagsNotIn(addTags).length > 0 && (
                <div className="dialog-quick-tags">
                  {tagsNotIn(addTags).map((t) => (
                    <button
                      key={t}
                      className="tag-chip addable"
                      title={`添加已有标签「${t}」`}
                      onClick={() => setAddTags((v) => appendTagToInput(v, t))}
                    >
                      <span className="material-symbols-outlined">add</span>
                      {t}
                    </button>
                  ))}
                </div>
              )}
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
