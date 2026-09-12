// 收藏夹（收藏夹 specs §3.1）：大类 tab + 直属/子类分组列表 + 拖拽移动 + 跨分类搜索 + 三弹窗
// 可发现性优化：tab 行尾「+」一键建大类、按钮「分类管理」、零分类引导行
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FavoriteCategory, FavoriteItem } from '../../shared/types'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { FavoriteDetailDialog, FavoriteAddDialog, CategoryManagerDialog } from './FavoriteDialogs'
import './favorites.css'

/** 域名摘要（解析失败退原串） */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** 简介首行轻剥 md 记号做一行摘要 */
function descPreview(md: string): string {
  const firstLine = md.trim().split('\n').find((l) => l.trim() !== '') ?? ''
  return firstLine
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*`>_~[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

export default function FavoritesModule() {
  const { toast } = useToast()
  const [categories, setCategories] = useState<FavoriteCategory[]>([])
  const [items, setItems] = useState<FavoriteItem[]>([])
  const [activeTop, setActiveTop] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  // 弹窗
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detailEdit, setDetailEdit] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<FavoriteItem | null>(null)
  // 拖拽（灵感泉同款 HTML5 拖拽；搜索视图禁拖——跨大类走编辑弹窗）
  const dragIdRef = useRef<number | null>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  // tab 行尾「+」一键建大类（可发现性：建好即成 tab 并切换过去）
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [quickName, setQuickName] = useState('')
  const quickRef = useRef<HTMLSpanElement>(null)
  // 主视图大类分组区尾「＋ 新增子类」行内入口
  const [addSubOpen, setAddSubOpen] = useState(false)
  const [subName, setSubName] = useState('')

  const load = useCallback(async () => {
    const lv = await window.api.favorites.list()
    setCategories(lv.categories)
    setItems(lv.items)
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  // 260912 收藏夹+藏书架合并藏阅阁：激活 id 随壳（zangyue）
  useModuleActivated('zangyue', () => void load())

  // 一键建大类输入框打开时，点击外部关闭
  useEffect(() => {
    if (!quickAddOpen) return
    const onDoc = (ev: MouseEvent): void => {
      if (quickRef.current && !quickRef.current.contains(ev.target as Node)) setQuickAddOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [quickAddOpen])

  const topCats = useMemo(() => categories.filter((c) => c.parent_id === null), [categories])
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const curTop = topCats.find((c) => c.id === activeTop) ?? topCats[0] ?? null
  const childrenByParent = useMemo(() => {
    const m = new Map<number, FavoriteCategory[]>()
    for (const c of categories) {
      if (c.parent_id == null) continue
      const arr = m.get(c.parent_id) ?? []
      arr.push(c)
      m.set(c.parent_id, arr)
    }
    return m
  }, [categories])

  /** 分类路径文案：大类 / 子类 */
  const pathOf = useCallback(
    (catId: number): string => {
      const c = catById.get(catId)
      if (!c) return ''
      if (c.parent_id == null) return c.name
      return `${catById.get(c.parent_id)?.name ?? ''} / ${c.name}`
    },
    [catById]
  )

  const keyword = search.trim().toLowerCase()
  const searching = keyword !== ''
  const curChildren = curTop ? childrenByParent.get(curTop.id) ?? [] : []
  const directItems = curTop && !searching ? items.filter((i) => i.category_id === curTop.id) : []
  const itemsOf = (catId: number): FavoriteItem[] => items.filter((i) => i.category_id === catId)
  const searchItems = searching
    ? items.filter(
        (i) =>
          i.name.toLowerCase().includes(keyword) ||
          i.url.toLowerCase().includes(keyword) ||
          i.desc_md.toLowerCase().includes(keyword)
      )
    : []
  const detailItem = items.find((i) => i.id === detailId) ?? null

  // 切大类 tab 时收起行内新增子类输入
  useEffect(() => {
    setAddSubOpen(false)
    setSubName('')
  }, [curTop?.id])

  const togglePin = async (item: FavoriteItem): Promise<void> => {
    try {
      await window.api.favorites.updateItem(item.id, { pinned: !item.pinned })
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败')
    }
  }

  /** tab 行尾「+」：一键建大类并切到新 tab */
  const doQuickAdd = async (): Promise<void> => {
    const name = quickName.trim()
    if (!name) {
      toast('大类名不能为空')
      return
    }
    try {
      const cat = await window.api.favorites.addCategory(name, null)
      setQuickAddOpen(false)
      setQuickName('')
      setSearch('')
      setActiveTop(cat.id)
      await load()
      toast(`已创建大类「${cat.name}」`)
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建失败')
    }
  }

  /** 主视图分组区尾：当前大类下新建子类 */
  const doAddSub = async (): Promise<void> => {
    const name = subName.trim()
    if (!name) {
      toast('子类名不能为空')
      return
    }
    if (!curTop || curTop.is_system) return
    try {
      await window.api.favorites.addCategory(name, curTop.id)
      setAddSubOpen(false)
      setSubName('')
      await load()
      toast(`已在「${curTop.name}」下创建子类「${name}」`)
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建失败')
    }
  }

  /** 行渲染（tag：搜索结果带的分类路径标签） */
  const renderRow = (item: FavoriteItem, tag?: string) => (
    <div
      key={item.id}
      className={`fav-item${draggingId === item.id ? ' dragging' : ''}`}
      draggable={!searching}
      onDragStart={(e: React.DragEvent) => {
        dragIdRef.current = item.id
        setDraggingId(item.id)
        e.dataTransfer.setData('text/plain', String(item.id))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => {
        setDraggingId(null)
        setDragOverKey(null)
        dragIdRef.current = null
      }}
      onClick={(e: React.MouseEvent) => {
        // Ctrl/⌘+单击 = 系统浏览器打开；单击 = 详情弹窗
        if (e.ctrlKey || e.metaKey) {
          void window.api.shell.openExternal(item.url)
          return
        }
        setDetailEdit(false)
        setDetailId(item.id)
      }}
      title={item.url}
    >
      {item.pinned && (
        <span className="material-symbols-outlined fav-pin" title="已置顶">
          push_pin
        </span>
      )}
      <div className="fav-main">
        <div className="fav-name">
          {tag && <span className="fav-path-tag">{tag}</span>}
          {item.name}
        </div>
        <div className="fav-sub">
          {hostOf(item.url)}
          {descPreview(item.desc_md) ? ` · ${descPreview(item.desc_md)}` : ''}
        </div>
      </div>
      <div className="row-actions">
        <button
          className="icon-btn"
          title="编辑"
          onClick={(e) => {
            e.stopPropagation()
            setDetailEdit(true)
            setDetailId(item.id)
          }}
        >
          <span className="material-symbols-outlined">edit</span>
        </button>
        <button
          className="icon-btn"
          title={item.pinned ? '取消置顶' : '置顶'}
          onClick={(e) => {
            e.stopPropagation()
            void togglePin(item)
          }}
        >
          <span className="material-symbols-outlined">push_pin</span>
        </button>
        <button
          className="icon-btn"
          title="删除"
          onClick={(e) => {
            e.stopPropagation()
            setRemoveTarget(item)
          }}
        >
          <span className="material-symbols-outlined">delete</span>
        </button>
      </div>
    </div>
  )

  /** 拖拽目标（直属区 / 子类分组容器共用） */
  const dropProps = (key: string, catId: number) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragIdRef.current) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDragOverKey(key)
    },
    onDragLeave: () => {
      setDragOverKey((k) => (k === key ? null : k))
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDragOverKey(null)
      const id = Number(e.dataTransfer.getData('text/plain')) || dragIdRef.current
      dragIdRef.current = null
      if (!id) return
      const it = items.find((x) => x.id === id)
      if (it && it.category_id !== catId) {
        void window.api.favorites
          .updateItem(id, { category_id: catId })
          .then(() => load())
          .catch((err: unknown) => toast(err instanceof Error ? err.message : '移动失败'))
      }
    }
  })

  return (
    <div className="fav-page">
      {/* 顶栏：大类 tab（未分类常驻末位）+ 搜索 + 分类管理 + 新增 */}
      <div className="fav-header">
        <div className="recycle-tabs fav-tabs">
          {topCats.map((c) => (
            <button
              key={c.id}
              className={`recycle-tab${curTop?.id === c.id && !searching ? ' active' : ''}`}
              onClick={() => {
                setActiveTop(c.id)
                setSearch('')
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
        {/* tab 行尾「+」：一键建大类（弹小输入框，建好即成 tab 并切换过去） */}
        <span className="fav-tab-add" ref={quickRef}>
          <button
            className="fav-tab-add-btn"
            title="新建大类"
            onClick={() => {
              setQuickAddOpen((v) => !v)
              setQuickName('')
            }}
          >
            <span className="material-symbols-outlined">add</span>
          </button>
          {quickAddOpen && (
            <div className="fav-quick-add">
              <input
                className="field"
                placeholder="新大类名"
                value={quickName}
                autoFocus
                onChange={(e) => setQuickName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doQuickAdd()
                  if (e.key === 'Escape') setQuickAddOpen(false)
                }}
              />
              <button className="btn btn-primary" onClick={() => void doQuickAdd()}>
                创建
              </button>
            </div>
          )}
        </span>
        <input
          className="field fav-search"
          placeholder="搜索全部收藏"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
        />
        <button className="btn" onClick={() => setManagerOpen(true)} title="分类管理">
          <span className="material-symbols-outlined">category</span>
          分类管理
        </button>
        <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
          <span className="material-symbols-outlined">add</span>
          新增收藏
        </button>
      </div>

      {/* 列表体 */}
      <div className="fav-body">
        {searching ? (
          searchItems.length > 0 ? (
            <div className="fav-group">
              <div className="fav-group-head">
                <span className="material-symbols-outlined">search</span>
                搜索「{search.trim()}」· {searchItems.length} 条
              </div>
              {searchItems.map((i) => renderRow(i, pathOf(i.category_id)))}
            </div>
          ) : (
            <div className="fav-empty">
              <span className="material-symbols-outlined">search_off</span>
              <div>无匹配收藏</div>
            </div>
          )
        ) : items.length === 0 ? (
          <div className="fav-empty">
            <span className="material-symbols-outlined">bookmark</span>
            <div>
              收藏常用网站、文章、视频、工具……
              <br />
              单击看介绍，Ctrl+单击直接在浏览器打开
            </div>
            <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
              <span className="material-symbols-outlined">add</span>
              新增第一条收藏
            </button>
            <button className="btn" onClick={() => setManagerOpen(true)}>
              <span className="material-symbols-outlined">category</span>
              创建分类
            </button>
          </div>
        ) : (
          curTop && (
            <>
              {/* 零分类引导：已有收藏但只有「未分类」时，指明分类创建入口 */}
              {categories.length === 1 && (
                <div className="fav-cat-hint-row">
                  <span className="material-symbols-outlined">lightbulb</span>
                  还没有自己的分类——点上方「＋」新建大类，子类与排序在「分类管理」里整理
                </div>
              )}
              <div className={`fav-group${dragOverKey === 'top' ? ' drag-over' : ''}`} {...dropProps('top', curTop.id)}>
                <div className="fav-group-head">
                  <span className="material-symbols-outlined">bookmark</span>
                  直属收藏 · {directItems.length}
                </div>
                {directItems.length === 0 && (
                  <div className="fav-group-empty">暂无——可把收藏拖到这里，或新增时不选子类</div>
                )}
                {directItems.map((i) => renderRow(i))}
              </div>
              {curChildren.map((ch) => (
                <div
                  key={ch.id}
                  className={`fav-group${dragOverKey === `cat-${ch.id}` ? ' drag-over' : ''}`}
                  {...dropProps(`cat-${ch.id}`, ch.id)}
                >
                  <div className="fav-group-head">
                    <span className="material-symbols-outlined">folder</span>
                    {ch.name} · {itemsOf(ch.id).length}
                  </div>
                  {itemsOf(ch.id).length === 0 && <div className="fav-group-empty">暂无收藏</div>}
                  {itemsOf(ch.id).map((i) => renderRow(i))}
                </div>
              ))}
              {/* 新增子类入口：当前大类分组区尾（「未分类」为系统锁定类，不参与建子类） */}
              {!curTop.is_system &&
                (addSubOpen ? (
                  <div className="fav-add-sub">
                    <input
                      className="field"
                      placeholder={`在「${curTop.name}」下新建子类`}
                      value={subName}
                      autoFocus
                      onChange={(e) => setSubName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void doAddSub()
                        if (e.key === 'Escape') setAddSubOpen(false)
                      }}
                    />
                    <button className="btn btn-primary" onClick={() => void doAddSub()}>
                      创建
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        setAddSubOpen(false)
                        setSubName('')
                      }}
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button className="fav-add-sub-btn" onClick={() => setAddSubOpen(true)}>
                    <span className="material-symbols-outlined">add</span>
                    新增子类
                  </button>
                ))}
            </>
          )
        )}
      </div>

      {/* 三弹窗 + 删除确认 */}
      {detailItem && (
        <FavoriteDetailDialog
          item={detailItem}
          categories={categories}
          initialEdit={detailEdit}
          onClose={() => setDetailId(null)}
          onChanged={() => void load()}
        />
      )}
      {addOpen && (
        <FavoriteAddDialog
          categories={categories}
          items={items}
          defaultCatId={curTop?.id ?? null}
          onClose={() => setAddOpen(false)}
          onChanged={() => void load()}
        />
      )}
      {managerOpen && (
        <CategoryManagerDialog categories={categories} onClose={() => setManagerOpen(false)} onChanged={() => void load()} />
      )}
      <ConfirmDialog
        open={!!removeTarget}
        title="删除收藏"
        danger
        confirmText="删除"
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          const t = removeTarget
          setRemoveTarget(null)
          if (t) {
            void window.api.favorites.deleteItem(t.id).then(() => {
              toast('已删除')
              void load()
            })
          }
        }}
      >
        将彻底删除收藏「{removeTarget?.name ?? ''}」，不可恢复（不入回收站）。
      </ConfirmDialog>
    </div>
  )
}
