// 经验书分类弹窗组（2026-09-17 优化轮）：快建 + 管理（改名/删除二次确认）。壳复用全局 dialog 类。
import { useEffect, useState } from 'react'
import type { ExpCategoryRecord } from '../../shared/types'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'

/** 新建分类（tab 行「＋」）：Enter/按钮提交，重名 toast */
export function ExpCategoryCreateDialog(props: {
  open: boolean
  onClose: () => void
  onCreated: (c: ExpCategoryRecord) => void
}) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  useEffect(() => {
    if (props.open) setName('')
  }, [props.open])
  const submit = async (): Promise<void> => {
    const n = name.trim()
    if (!n) return
    try {
      const c = await window.api.wenbi.expCategoryCreate(n)
      props.onCreated(c)
    } catch (e) {
      toast(String(e).includes('DUP_NAME') ? '分类已存在' : '创建失败')
    }
  }
  if (!props.open) return null
  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog" style={{ width: 360 }}>
        <div className="dialog-header">新建分类</div>
        <div className="dialog-body">
          <input
            className="exp-cat-input"
            autoFocus
            placeholder="分类名称…（如：系统整理）"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
              if (e.key === 'Escape') props.onClose()
            }}
          />
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void submit()}>
            创建
          </button>
        </div>
      </div>
    </div>
  )
}

/** 分类管理：顶部快建 + 行内改名（Enter 保存/Esc 取消/失焦保存）+ 删除（二次确认，条目回未分类） */
export function ExpCategoryManageDialog(props: {
  open: boolean
  cats: ExpCategoryRecord[]
  onClose: () => void
  onChanged: () => void
}) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [editId, setEditId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [delTarget, setDelTarget] = useState<ExpCategoryRecord | null>(null)
  useEffect(() => {
    if (props.open) {
      setName('')
      setEditId(null)
    }
  }, [props.open])

  const create = async (): Promise<void> => {
    const n = name.trim()
    if (!n) return
    try {
      await window.api.wenbi.expCategoryCreate(n)
      setName('')
      props.onChanged()
    } catch (e) {
      toast(String(e).includes('DUP_NAME') ? '分类已存在' : '创建失败')
    }
  }
  const commitRename = async (c: ExpCategoryRecord): Promise<void> => {
    const n = editName.trim()
    setEditId(null)
    if (!n || n === c.name) return
    try {
      await window.api.wenbi.expCategoryRename(c.id, n)
      props.onChanged()
    } catch (e) {
      toast(String(e).includes('DUP_NAME') ? '分类已存在' : '保存失败')
    }
  }
  const doDelete = async (): Promise<void> => {
    if (!delTarget) return
    try {
      await window.api.wenbi.expCategoryDelete(delTarget.id)
      toast('已删除，条目回未分类')
    } catch {
      toast('删除失败')
    }
    setDelTarget(null)
    props.onChanged()
  }

  if (!props.open) return null
  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog" style={{ width: 420 }}>
        <div className="dialog-header">管理分类</div>
        <div className="dialog-body">
          <div className="exp-cat-create">
            <input
              className="exp-cat-input"
              placeholder="新建分类…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
            />
            <button className="btn btn-primary" onClick={() => void create()}>
              添加
            </button>
          </div>
          <div className="exp-cat-list">
            {props.cats.map((c) =>
              editId === c.id ? (
                <input
                  key={c.id}
                  className="exp-cat-input"
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(c)
                    if (e.key === 'Escape') setEditId(null)
                  }}
                  onBlur={() => void commitRename(c)}
                />
              ) : (
                <div
                  key={c.id}
                  className="exp-cat-item"
                  onDoubleClick={() => {
                    setEditId(c.id)
                    setEditName(c.name)
                  }}
                  title="双击改名"
                >
                  <span className="exp-cat-name">{c.name}</span>
                  <div className="row-actions">
                    <button
                      className="icon-btn"
                      title="改名"
                      onClick={() => {
                        setEditId(c.id)
                        setEditName(c.name)
                      }}
                    >
                      <span className="material-symbols-outlined">edit</span>
                    </button>
                    <button className="icon-btn danger" title="删除" onClick={() => setDelTarget(c)}>
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                  </div>
                </div>
              )
            )}
            {props.cats.length === 0 && <div className="exp-cat-empty">暂无分类——条目都在「未分类」</div>}
          </div>
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={props.onClose}>
            完成
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={delTarget != null}
        title="删除分类"
        confirmText="删除"
        danger
        onConfirm={() => void doDelete()}
        onCancel={() => setDelTarget(null)}
      >
        删除「{delTarget?.name}」？该分类下的条目将回到「未分类」。
      </ConfirmDialog>
    </div>
  )
}
