// 经验书（文笔坊·2026-09-17 新功能开发区）：一句话经验道理手册——分类 tab + 行内快记/编辑，零 AI 硬边界
// 优化轮（同日设计）：行去时间列；夹内拖拽排序（格言库同款半差插入）+ 拖到 tab 归类；「全部」按分类分节。
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ExpCategoryRecord, WenbiExperienceRecord } from '../../shared/types'
import ActionMenu from '../../components/ActionMenu'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { ExpCategoryCreateDialog, ExpCategoryManageDialog } from './ExpCategoryDialogs'

const DRAG_EDGE = 64
const DRAG_MAX_SPEED = 12

/** 当前 tab：'all'=全部（分节视图）；'none'=未分类；数字=分类 id */
type ExpTab = 'all' | 'none' | number

export default function ExperiencePanel(props: { active: boolean }) {
  const { toast } = useToast()
  const [rows, setRows] = useState<WenbiExperienceRecord[]>([])
  const [cats, setCats] = useState<ExpCategoryRecord[]>([])
  const [tab, setTab] = useState<ExpTab>('all')
  const [draft, setDraft] = useState('')
  // 行内编辑：editId 驱动渲染；ref 镜像供失焦保存读最新值（连点切行时闭包不串行）
  const [editId, setEditId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const editIdRef = useRef<number | null>(null)
  const editTextRef = useRef('')
  const [discardTarget, setDiscardTarget] = useState<WenbiExperienceRecord | null>(null)
  const [moveMenu, setMoveMenu] = useState<{ id: number; anchorEl: HTMLElement } | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const quickRef = useRef<HTMLTextAreaElement>(null)

  // ----- 拖拽排序（格言库同款）+ 拖到 tab 归类 -----
  const dragIdRef = useRef<number | null>(null)
  const [dragOverTab, setDragOverTab] = useState<string | null>(null)
  // 拖拽边缘自动滚动（移植自格言库第42轮）：rAF 循环，速度随贴近边缘渐增
  const dragScrollRef = useRef<{ el: HTMLElement | null; dir: number; raf: number; lastOver: number }>({
    el: null,
    dir: 0,
    raf: 0,
    lastOver: 0
  })
  useEffect(
    () => () => {
      if (dragScrollRef.current.raf) cancelAnimationFrame(dragScrollRef.current.raf)
    },
    []
  )

  const load = useCallback(async () => {
    try {
      const [list, catList] = await Promise.all([window.api.wenbi.expList(), window.api.wenbi.expCategoryList()])
      setRows(list)
      setCats(catList)
      // 自愈：激活分类已被删（管理弹窗删除/他路径）则回「全部」
      setTab((t) => (typeof t === 'number' && !catList.some((c) => c.id === t) ? 'all' : t))
    } catch {
      toast('经验书加载失败')
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])
  // keep-alive：切回文笔坊模块时刷新（回收站恢复可能改动了列表）
  useModuleActivated('wenbi', () => void load())
  // 板块切回时刷新（四板块常驻挂载，board 切换不触发组件重挂）
  useEffect(() => {
    if (props.active) void load()
  }, [props.active, load])

  /** 夹内条目（sort ASC, id ASC） */
  const entriesOf = useCallback(
    (categoryId: number | null): WenbiExperienceRecord[] =>
      rows.filter((r) => r.category_id === categoryId).sort((a, b) => a.sort - b.sort || a.id - b.id),
    [rows]
  )

  /** 「全部」视图分节：分类按 cat.sort，未分类节居末；空节不显示 */
  const sections = useMemo(() => {
    const list: { key: string; cat: ExpCategoryRecord | null; items: WenbiExperienceRecord[] }[] = cats
      .map((c) => ({ key: String(c.id), cat: c, items: entriesOf(c.id) }))
      .filter((s) => s.items.length > 0)
    const noneItems = entriesOf(null)
    if (noneItems.length > 0) list.push({ key: 'none', cat: null, items: noneItems })
    return list
  }, [cats, entriesOf])

  /** 快记新建：落当前激活分类（全部/未分类 tab → NULL），服务端插夹顶；空内容静默不建 */
  const doCreate = async (): Promise<void> => {
    const content = draft.trim()
    if (!content) return
    const categoryId = tab === 'all' || tab === 'none' ? null : tab
    try {
      const rec = await window.api.wenbi.expCreate(content, categoryId)
      setRows((rs) => [rec, ...rs])
      setDraft('')
      quickRef.current?.focus()
    } catch {
      toast('新建失败')
    }
  }

  const beginEdit = (it: WenbiExperienceRecord): void => {
    setEditId(it.id)
    editIdRef.current = it.id
    setEditText(it.content)
    editTextRef.current = it.content
  }

  /** 保存当前编辑（Enter / 失焦共用）：空内容视为取消 + 提示；内容未变跳过写库 */
  const commitEdit = async (): Promise<void> => {
    const id = editIdRef.current
    if (id == null) return
    const content = editTextRef.current.trim()
    setEditId(null)
    editIdRef.current = null
    if (!content) {
      toast('内容为空，未保存')
      return
    }
    if (content === rows.find((r) => r.id === id)?.content) return
    try {
      const rec = await window.api.wenbi.expUpdate(id, content)
      setRows((rs) => rs.map((r) => (r.id === id ? rec : r)))
    } catch {
      toast('保存失败')
    }
  }

  const cancelEdit = (): void => {
    setEditId(null)
    editIdRef.current = null
  }

  const onEditChange = (v: string): void => {
    setEditText(v)
    editTextRef.current = v
  }

  /** 归入分类（拖到 tab / 「移动到…」菜单共用）：原夹不变为无操作 */
  const moveTo = async (id: number, categoryId: number | null): Promise<void> => {
    const src = rows.find((r) => r.id === id)
    if (!src || src.category_id === categoryId) return
    try {
      await window.api.wenbi.expMove(id, categoryId)
      toast(categoryId == null ? '已移入未分类' : `已移入「${cats.find((c) => c.id === categoryId)?.name ?? ''}」`)
    } catch {
      toast('移动失败')
    }
    await load()
  }

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    try {
      await window.api.wenbi.expDiscard(discardTarget.id)
      toast('已放入回收站')
    } catch {
      toast('丢弃失败')
    }
    setDiscardTarget(null)
    await load()
  }

  // ----- 拖拽（移植自格言库：HTML5 DnD + 半差插入 + 边缘自动滚动） -----
  const findScrollParent = (el: HTMLElement): HTMLElement | null => {
    let p = el.parentElement
    while (p) {
      const oy = getComputedStyle(p).overflowY
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight) return p
      p = p.parentElement
    }
    return null
  }
  const stopDragScroll = (): void => {
    const a = dragScrollRef.current
    if (a.raf) cancelAnimationFrame(a.raf)
    a.raf = 0
    a.dir = 0
    a.el = null
  }
  const stepDragScroll = (): void => {
    const a = dragScrollRef.current
    // 护栏：指针拖出滚动区后 dragover 停发，0.5s 内自动停
    if (!a.el || a.dir === 0 || performance.now() - a.lastOver > 500) {
      a.raf = 0
      return
    }
    a.el.scrollTop += a.dir * DRAG_MAX_SPEED
    a.raf = requestAnimationFrame(stepDragScroll)
  }
  const onPageDragOver = (e: React.DragEvent): void => {
    const a = dragScrollRef.current
    if (!a.el) return
    a.lastOver = performance.now()
    const r = a.el.getBoundingClientRect()
    const y = e.clientY
    if (y < r.top + DRAG_EDGE) a.dir = -Math.min(1, (r.top + DRAG_EDGE - y) / DRAG_EDGE)
    else if (y > r.bottom - DRAG_EDGE) a.dir = Math.min(1, (y - (r.bottom - DRAG_EDGE)) / DRAG_EDGE)
    else a.dir = 0
    if (a.dir !== 0 && !a.raf) a.raf = requestAnimationFrame(stepDragScroll)
  }
  const onDragStart = (e: React.DragEvent, it: WenbiExperienceRecord): void => {
    dragIdRef.current = it.id
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(it.id))
    ;(e.currentTarget as HTMLElement).classList.add('dragging')
    dragScrollRef.current.el = findScrollParent(e.currentTarget as HTMLElement)
  }
  const onDragEnd = (e: React.DragEvent): void => {
    ;(e.currentTarget as HTMLElement).classList.remove('dragging')
    dragIdRef.current = null
    setDragOverTab(null)
    stopDragScroll()
  }
  /** 拖到行上 → 夹内插入该位置（半差插入 + 夹内归一化）；跨夹（「全部」视图跨节）忽略 */
  const onDropToRow = async (e: React.DragEvent, target: WenbiExperienceRecord): Promise<void> => {
    e.preventDefault()
    stopDragScroll()
    const id = Number(e.dataTransfer.getData('text/plain')) || dragIdRef.current
    if (!id || id === target.id) return
    const source = rows.find((r) => r.id === id)
    if (!source || source.category_id !== target.category_id) return
    const zoneItems = rows
      .filter((r) => r.category_id === target.category_id)
      .sort((a, b) => a.sort - b.sort || a.id - b.id)
    const targetIdx = zoneItems.findIndex((r) => r.id === target.id)
    const sourceIdx = zoneItems.findIndex((r) => r.id === id)
    const next = [...zoneItems]
    next.splice(sourceIdx, 1)
    next.splice(targetIdx, 0, source)
    await window.api.wenbi.expReorder(next.map((r, i) => ({ id: r.id, sort: i })))
    await load()
  }
  /** 分类/未分类 tab 的拖拽归类目标：dragover 高亮，drop 移入（插夹顶） */
  const onTabDragOver = (e: React.DragEvent, key: string): void => {
    if (dragIdRef.current == null) return
    e.preventDefault()
    setDragOverTab(key)
  }
  const onTabDrop = (e: React.DragEvent, categoryId: number | null): void => {
    e.preventDefault()
    setDragOverTab(null)
    stopDragScroll()
    const id = Number(e.dataTransfer.getData('text/plain')) || dragIdRef.current
    if (id) void moveTo(id, categoryId)
  }

  /** 快记键位：Enter 新建 / Shift+Enter 换行 / Esc 清空 */
  const onQuickKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void doCreate()
    } else if (e.key === 'Escape') {
      setDraft('')
    }
  }
  /** 编辑键位：Enter 保存 / Shift+Enter 换行 / Esc 取消 */
  const onEditKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void commitEdit()
    } else if (e.key === 'Escape') {
      cancelEdit()
    }
  }

  /** 行渲染（去时间列）：编辑态行内 textarea；常态内容 + 移动/编辑/丢弃 */
  const rowOf = (it: WenbiExperienceRecord): ReactNode =>
    editId === it.id ? (
      <div className="row-item" key={it.id} style={{ cursor: 'default' }}>
        <div className="row-main" style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <textarea
            className="exp-edit"
            autoFocus
            rows={1}
            value={editText}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={onEditKey}
            onBlur={() => void commitEdit()}
          />
        </div>
      </div>
    ) : (
      <div
        className="row-item exp-row"
        key={it.id}
        style={{ cursor: 'default' }}
        draggable
        onDragStart={(e) => onDragStart(e, it)}
        onDragEnd={onDragEnd}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => void onDropToRow(e, it)}
        onDoubleClick={() => beginEdit(it)}
        title="双击编辑；拖拽排序，拖到顶部标签归类"
      >
        <span className="exp-content">{it.content}</span>
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="icon-btn"
            title="移动到…"
            onClick={(e) => setMoveMenu({ id: it.id, anchorEl: e.currentTarget })}
          >
            <span className="material-symbols-outlined">drive_file_move</span>
          </button>
          <button className="icon-btn" title="编辑" onClick={() => beginEdit(it)}>
            <span className="material-symbols-outlined">edit</span>
          </button>
          <button className="icon-btn danger" title="丢弃" onClick={() => setDiscardTarget(it)}>
            <span className="material-symbols-outlined">delete</span>
          </button>
        </div>
      </div>
    )

  /** 当前单夹视图（分类/未分类 tab）条目与标题 */
  const currentItems = tab === 'none' ? entriesOf(null) : typeof tab === 'number' ? entriesOf(tab) : []
  const currentTitle =
    tab === 'none' ? '未分类' : typeof tab === 'number' ? (cats.find((c) => c.id === tab)?.name ?? '') : ''

  return (
    <div onDragOver={onPageDragOver}>
      {/* 分类 tab 行：全部｜各分类｜未分类（锁定末位）｜工具（＋快建/管理） */}
      <div className="exp-tab-row">
        <div className="recycle-tabs">
          <button className={`recycle-tab${tab === 'all' ? ' active' : ''}`} onClick={() => setTab('all')}>
            全部
          </button>
          {cats.map((c) => (
            <button
              key={c.id}
              className={`recycle-tab${tab === c.id ? ' active' : ''}${dragOverTab === String(c.id) ? ' drop-target' : ''}`}
              onClick={() => setTab(c.id)}
              onDragOver={(e) => onTabDragOver(e, String(c.id))}
              onDragLeave={() => setDragOverTab(null)}
              onDrop={(e) => onTabDrop(e, c.id)}
            >
              {c.name}
            </button>
          ))}
          <button
            className={`recycle-tab${tab === 'none' ? ' active' : ''}${dragOverTab === 'none' ? ' drop-target' : ''}`}
            onClick={() => setTab('none')}
            onDragOver={(e) => onTabDragOver(e, 'none')}
            onDragLeave={() => setDragOverTab(null)}
            onDrop={(e) => onTabDrop(e, null)}
          >
            未分类
          </button>
        </div>
        <div className="exp-tab-tools">
          <button className="icon-btn" title="新建分类" onClick={() => setCreateOpen(true)}>
            <span className="material-symbols-outlined">add</span>
          </button>
          <button className="icon-btn" title="管理分类" onClick={() => setManageOpen(true)}>
            <span className="material-symbols-outlined">settings</span>
          </button>
        </div>
      </div>

      <textarea
        ref={quickRef}
        className="exp-quick"
        placeholder="记一条经验道理…（Enter 保存，Shift+Enter 换行）"
        value={draft}
        rows={1}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onQuickKey}
      />

      {tab === 'all'
        ? sections.map((s) => (
            <section key={s.key} className="zone">
              <div className="zone-header">
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                  {s.cat ? 'folder' : 'folder_off'}
                </span>
                <span>{s.cat ? s.cat.name : '未分类'}</span>
                <span className="zone-count">{s.items.length}</span>
              </div>
              <div className="zone-body">{s.items.map((it) => rowOf(it))}</div>
            </section>
          ))
        : currentItems.length > 0 && (
            <section className="zone">
              <div className="zone-header">
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                  {tab === 'none' ? 'folder_off' : 'folder'}
                </span>
                <span>{currentTitle}</span>
                <span className="zone-count">{currentItems.length}</span>
              </div>
              <div className="zone-body">{currentItems.map((it) => rowOf(it))}</div>
            </section>
          )}
      {(tab === 'all' ? sections.length === 0 : currentItems.length === 0) && (
        <div className="empty-state" style={{ padding: '40px 0' }}>
          <span className="material-symbols-outlined">menu_book</span>
          把踩过的坑和悟出的道理记在这里
        </div>
      )}

      {/* 「移动到…」菜单：各分类 + 未分类（当前夹不列出） */}
      {moveMenu && (
        <ActionMenu
          anchorEl={moveMenu.anchorEl}
          onClose={() => setMoveMenu(null)}
          items={[
            ...cats
              .filter((c) => c.id !== rows.find((r) => r.id === moveMenu.id)?.category_id)
              .map((c) => ({
                key: `c${c.id}`,
                icon: 'folder',
                label: c.name,
                onClick: () => void moveTo(moveMenu.id, c.id)
              })),
            ...(rows.find((r) => r.id === moveMenu.id)?.category_id != null
              ? [
                  {
                    key: 'none',
                    icon: 'folder_off',
                    label: '未分类',
                    onClick: () => void moveTo(moveMenu.id, null)
                  }
                ]
              : [])
          ]}
        />
      )}

      <ExpCategoryCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(c) => {
          setCreateOpen(false)
          setTab(c.id)
          void load()
        }}
      />
      <ExpCategoryManageDialog
        open={manageOpen}
        cats={cats}
        onClose={() => setManageOpen(false)}
        onChanged={() => void load()}
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
