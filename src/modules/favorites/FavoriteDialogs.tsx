// 收藏夹三弹窗（收藏夹 specs §3.2-§3.4）：详情（MdDialog 同款「渲染态+双击进编辑」交互，内容存 DB 非 md 文件）、新增（URL+抓取）、分类管理
import { useEffect, useMemo, useState } from 'react'
import type { FavoriteCategory, FavoriteItem } from '../../shared/types'
import { renderMd } from '../../components/MdView'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'

const URL_RE = /^https?:\/\//i

/** 无协议自动补 https://（specs §3.3） */
export function normalizeFavUrl(u: string): string {
  const t = u.trim()
  return URL_RE.test(t) ? t : `https://${t}`
}

/** 分类路径文案：大类 / 子类 */
function pathOf(catId: number, catMap: Map<number, FavoriteCategory>): string {
  const c = catMap.get(catId)
  if (!c) return ''
  if (c.parent_id == null) return c.name
  return `${catMap.get(c.parent_id)?.name ?? ''} / ${c.name}`
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : '操作失败'
}

// ---------- 详情弹窗（specs §3.2） ----------

interface DetailProps {
  item: FavoriteItem
  categories: FavoriteCategory[]
  /** 行内「编辑」按钮直开编辑态；单击行打开为渲染态 */
  initialEdit: boolean
  onClose: () => void
  onChanged: () => void
}

export function FavoriteDetailDialog(props: DetailProps) {
  const { item, categories, initialEdit, onClose, onChanged } = props
  const { toast } = useToast()
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const topCats = useMemo(() => categories.filter((c) => c.parent_id === null), [categories])
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

  const [editing, setEditing] = useState(initialEdit)
  const [name, setName] = useState(item.name)
  const [url, setUrl] = useState(item.url)
  const [desc, setDesc] = useState(item.desc_md)
  const [pinned, setPinned] = useState(item.pinned)
  const [topId, setTopId] = useState<number>(item.category_id)
  const [childId, setChildId] = useState<number | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)

  // 进入编辑态时从当前 item 重建草稿（item.id 变化 / 点「编辑」都会走这里）
  useEffect(() => {
    if (!editing) return
    setName(item.name)
    setUrl(item.url)
    setDesc(item.desc_md)
    setPinned(item.pinned)
    const c = catMap.get(item.category_id)
    if (c && c.parent_id != null) {
      setTopId(c.parent_id)
      setChildId(c.id)
    } else {
      setTopId(item.category_id)
      setChildId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, item.id])

  const dirty =
    name !== item.name ||
    url !== item.url ||
    desc !== item.desc_md ||
    pinned !== item.pinned ||
    (childId ?? topId) !== item.category_id

  const attemptClose = (): void => {
    if (editing && dirty) setConfirmClose(true)
    else onClose()
  }

  const doSave = async (): Promise<void> => {
    const normUrl = normalizeFavUrl(url)
    if (!name.trim()) {
      toast('名称不能为空')
      return
    }
    if (!URL_RE.test(normUrl)) {
      toast('链接格式不正确')
      return
    }
    try {
      await window.api.favorites.updateItem(item.id, {
        name: name.trim(),
        url: normUrl,
        desc_md: desc,
        pinned,
        category_id: childId ?? topId
      })
      toast('已保存')
      setEditing(false)
      onChanged()
    } catch (err) {
      toast(errMsg(err))
    }
  }

  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && attemptClose()}>
      <div className="dialog fav-detail" style={{ width: 560 }}>
        <div className="dialog-header">
          <span className="dialog-title" title={item.name}>
            {item.name}
          </span>
          <span className="dialog-subtitle-inline">{pathOf(item.category_id, catMap)}</span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setEditing((v) => !v)}>
            {editing ? '查看' : '编辑'}
          </button>
        </div>
        {editing ? (
          <div className="dialog-body">
            <div className="fav-form">
              <label>
                名称
                <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                链接（无协议自动补 https://）
                <input className="field" value={url} onChange={(e) => setUrl(e.target.value)} />
              </label>
              <div className="fav-cat-selects">
                <label>
                  大类
                  <select
                    className="field"
                    value={topId}
                    onChange={(e) => {
                      setTopId(Number(e.target.value))
                      setChildId(null)
                    }}
                  >
                    {topCats.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  子类（可不选 = 挂大类直属）
                  <select
                    className="field"
                    value={childId ?? ''}
                    onChange={(e) => setChildId(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">（直属）</option>
                    {(childrenByParent.get(topId) ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="fav-check">
                <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
                置顶（排在所属分组最前）
              </label>
              <label>
                简介（支持 Markdown）
                <textarea className="field" value={desc} onChange={(e) => setDesc(e.target.value)} rows={6} />
              </label>
            </div>
          </div>
        ) : (
          <div
            className="dialog-body fav-detail-body"
            onDoubleClick={() => setEditing(true)}
            title="双击进入编辑"
          >
            <div className="fav-url-row">
              <span className="fav-url-text">{item.url}</span>
              <button
                className="icon-btn"
                title="复制链接"
                onClick={() => void window.api.clipboard.writeText(item.url).then(() => toast('已复制'))}
              >
                <span className="material-symbols-outlined">content_copy</span>
              </button>
              <button
                className="icon-btn"
                title="在系统浏览器打开"
                onClick={() => void window.api.shell.openExternal(item.url)}
              >
                <span className="material-symbols-outlined">open_in_new</span>
              </button>
            </div>
            {item.desc_md.trim() ? (
              <div className="fav-md" dangerouslySetInnerHTML={{ __html: renderMd(item.desc_md) }} />
            ) : (
              <div className="fav-md-empty">（无简介——双击此处添加）</div>
            )}
          </div>
        )}
        <div className="dialog-footer">
          <button className="btn" onClick={attemptClose}>
            关闭
          </button>
          {editing && (
            <button className="btn btn-primary" onClick={() => void doSave()}>
              保存
            </button>
          )}
        </div>
      </div>
      {/* 编辑态有改动时防误关（MdDialog 防丢稿惯例） */}
      <ConfirmDialog
        open={confirmClose}
        title="有未保存的修改"
        danger
        confirmText="放弃修改"
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => {
          setConfirmClose(false)
          onClose()
        }}
      >
        关闭将丢失未保存的修改，确认放弃？
      </ConfirmDialog>
    </div>
  )
}

// ---------- 新增收藏弹窗（specs §3.3） ----------

interface AddProps {
  categories: FavoriteCategory[]
  items: FavoriteItem[]
  /** 默认分类 = 当前所在大类 */
  defaultCatId: number | null
  onClose: () => void
  onChanged: () => void
}

export function FavoriteAddDialog(props: AddProps) {
  const { categories, items, defaultCatId, onClose, onChanged } = props
  const { toast } = useToast()
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const topCats = useMemo(
    () => categories.filter((c) => c.parent_id === null),
    [categories]
  )
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

  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [topId, setTopId] = useState<number | null>(defaultCatId ?? topCats[0]?.id ?? null)
  const [childId, setChildId] = useState<number | null>(null)
  const [fetching, setFetching] = useState(false)

  const validUrl = url.trim() !== '' && URL_RE.test(normalizeFavUrl(url))
  const canSave = !fetching && validUrl && name.trim() !== ''

  const doFetch = async (): Promise<void> => {
    const norm = normalizeFavUrl(url)
    if (!URL_RE.test(norm)) {
      toast('链接格式不正确')
      return
    }
    setFetching(true)
    try {
      const meta = await window.api.favorites.fetchMeta(norm)
      if (meta.title) setName(meta.title)
      if (meta.desc) setDesc(meta.desc)
      toast(meta.title || meta.desc ? '抓取成功' : '抓取失败，请手动填写')
    } finally {
      setFetching(false)
    }
  }

  const doSave = async (): Promise<void> => {
    const norm = normalizeFavUrl(url)
    const dup = items.find((i) => i.url === norm)
    if (dup) toast(`已收藏于「${pathOf(dup.category_id, catMap)}」，将重复保存`)
    try {
      await window.api.favorites.addItem(name.trim(), norm, desc, childId ?? topId ?? defaultCatId ?? 1)
      toast('已收藏')
      onChanged()
      onClose()
    } catch (err) {
      toast(errMsg(err))
    }
  }

  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 520 }}>
        <div className="dialog-header">新增收藏</div>
        <div className="dialog-body">
          <div className="fav-form">
            <label>
              链接（无协议自动补 https://）
              <div className="fav-url-input">
                <input
                  className="field"
                  placeholder="https://…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onBlur={() => url.trim() && !URL_RE.test(url) && setUrl(normalizeFavUrl(url))}
                  autoFocus
                />
                <button className="btn" disabled={fetching || !url.trim()} onClick={() => void doFetch()}>
                  {fetching ? '抓取中…' : '抓取'}
                </button>
              </div>
            </label>
            <label>
              名称
              <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="fav-cat-selects">
              <label>
                大类
                <select
                  className="field"
                  value={topId ?? ''}
                  onChange={(e) => {
                    setTopId(Number(e.target.value))
                    setChildId(null)
                  }}
                >
                  {topCats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                子类（可不选）
                <select
                  className="field"
                  value={childId ?? ''}
                  onChange={(e) => setChildId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">（直属）</option>
                  {(childrenByParent.get(topId ?? 0) ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              简介（支持 Markdown）
              <textarea className="field" value={desc} onChange={(e) => setDesc(e.target.value)} rows={5} />
            </label>
          </div>
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!canSave} onClick={() => void doSave()}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- 分类管理弹窗（specs §3.4） ----------

interface ManagerProps {
  categories: FavoriteCategory[]
  onClose: () => void
  onChanged: () => void
}

export function CategoryManagerDialog(props: ManagerProps) {
  const { categories, onClose, onChanged } = props
  const { toast } = useToast()
  const topCats = useMemo(
    () => categories.filter((c) => c.parent_id === null),
    [categories]
  )
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

  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameText, setRenameText] = useState('')
  const [addChildFor, setAddChildFor] = useState<number | null>(null)
  const [childText, setChildText] = useState('')
  const [newTopText, setNewTopText] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<FavoriteCategory | null>(null)

  const doRename = async (id: number): Promise<void> => {
    if (!renameText.trim()) return
    try {
      await window.api.favorites.renameCategory(id, renameText)
      setRenamingId(null)
      onChanged()
    } catch (err) {
      toast(errMsg(err))
    }
  }

  const doAddTop = async (): Promise<void> => {
    if (!newTopText.trim()) return
    try {
      await window.api.favorites.addCategory(newTopText, null)
      setNewTopText('')
      onChanged()
    } catch (err) {
      toast(errMsg(err))
    }
  }

  const doAddChild = async (parentId: number): Promise<void> => {
    if (!childText.trim()) return
    try {
      await window.api.favorites.addCategory(childText, parentId)
      setChildText('')
      setAddChildFor(null)
      onChanged()
    } catch (err) {
      toast(errMsg(err))
    }
  }

  const doMove = async (id: number, dir: 'up' | 'down'): Promise<void> => {
    try {
      await window.api.favorites.moveCategory(id, dir)
      onChanged()
    } catch (err) {
      toast(errMsg(err))
    }
  }

  const doDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    try {
      const r = await window.api.favorites.deleteCategory(deleteTarget.id)
      toast(
        `已删除「${deleteTarget.name}」` +
          (r.movedItems > 0 ? `：${r.movedItems} 条收藏移入未分类` : '') +
          (r.movedChildren > 0 ? `，${r.movedChildren} 个子类上移一级` : '')
      )
      setDeleteTarget(null)
      onChanged()
    } catch (err) {
      toast(errMsg(err))
    }
  }

  /** 分类行（大类/子类通用；system 类只读置灰） */
  const renderCatRow = (c: FavoriteCategory, child: boolean): React.ReactNode => (
    <div key={c.id} className={`fav-cat-row${c.is_system ? ' system' : ''}${child ? ' child' : ''}`}>
      {child && <span className="material-symbols-outlined">subdirectory_arrow_right</span>}
      {renamingId === c.id ? (
        <input
          className="field fav-cat-rename"
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void doRename(c.id)}
          autoFocus
        />
      ) : (
        <span className="fav-cat-name">{c.name}</span>
      )}
      {!c.is_system && (
        <div className="row-actions">
          {!child && (
            <button className="icon-btn" title="新增子类" onClick={() => { setAddChildFor(addChildFor === c.id ? null : c.id); setChildText('') }}>
              <span className="material-symbols-outlined">add</span>
            </button>
          )}
          <button className="icon-btn" title="上移" onClick={() => void doMove(c.id, 'up')}>
            <span className="material-symbols-outlined">arrow_upward</span>
          </button>
          <button className="icon-btn" title="下移" onClick={() => void doMove(c.id, 'down')}>
            <span className="material-symbols-outlined">arrow_downward</span>
          </button>
          {renamingId === c.id ? (
            <button className="icon-btn" title="保存改名" onClick={() => void doRename(c.id)}>
              <span className="material-symbols-outlined">check</span>
            </button>
          ) : (
            <button
              className="icon-btn"
              title="改名"
              onClick={() => {
                setRenamingId(c.id)
                setRenameText(c.name)
              }}
            >
              <span className="material-symbols-outlined">edit</span>
            </button>
          )}
          <button className="icon-btn" title="删除" onClick={() => setDeleteTarget(c)}>
            <span className="material-symbols-outlined">delete</span>
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 480 }}>
        <div className="dialog-header">分类管理</div>
        <div className="dialog-body fav-cat-manager">
          {topCats.map((t) => {
            const children = childrenByParent.get(t.id) ?? []
            return (
              <div key={t.id} className="fav-cat-block">
                {renderCatRow(t, false)}
                <div className="fav-cat-children">
                  {children.map((c) => renderCatRow(c, true))}
                  {addChildFor === t.id && !t.is_system && (
                    <div className="fav-cat-add">
                      <input
                        className="field"
                        placeholder="子类名"
                        value={childText}
                        onChange={(e) => setChildText(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && void doAddChild(t.id)}
                        autoFocus
                      />
                      <button className="btn" onClick={() => void doAddChild(t.id)}>
                        添加
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          <div className="fav-cat-add">
            <input
              className="field"
              placeholder="新大类名"
              value={newTopText}
              onChange={(e) => setNewTopText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void doAddTop()}
            />
            <button className="btn btn-primary" onClick={() => void doAddTop()}>
              新增大类
            </button>
          </div>
          <div className="fav-cat-hint">最多两级（大类 &gt; 子类）；删除非空分类时，子类上移一级、直属收藏移入「未分类」。</div>
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
      {/* 删分类二次确认（文案写明去向） */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除分类"
        danger
        confirmText="删除"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void doDelete()}
      >
        {deleteTarget?.parent_id == null
          ? `将删除大类「${deleteTarget?.name}」：其子类上移为大类，直属收藏移入「未分类」。`
          : `将删除子类「${deleteTarget?.name}」：其直属收藏移入「未分类」。`}
      </ConfirmDialog>
    </div>
  )
}
