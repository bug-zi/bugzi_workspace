// 挑战池管理弹窗（260916 新功能开发区）：列表 + 添加 + 行内编辑 + 删除（二次确认，全局规则）。
// 样式走全局 dialog-overlay/dialog 惯例（ConfirmDialog 同源类）。
import { useCallback, useEffect, useState } from 'react'
import type { ChallengePoolRow } from '../../shared/types'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'

interface Props {
  open: boolean
  onClose: () => void
  /** 池变动后通知父级刷新（挑战卡 poolCount；热力图不受池变动影响） */
  onChanged: () => void
}

export default function ChallengeManageDialog(props: Props) {
  const { toast } = useToast()
  const [rows, setRows] = useState<ChallengePoolRow[]>([])
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingText, setEditingText] = useState('')
  const [deleting, setDeleting] = useState<ChallengePoolRow | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setRows(await window.api.challenge.listPool())
    } catch {
      setRows([])
    }
  }, [])

  useEffect(() => {
    if (props.open) {
      setEditingId(null)
      setEditingText('')
      setDraft('')
      void load()
    }
  }, [props.open, load])

  if (!props.open) return null

  const add = async (): Promise<void> => {
    const c = draft.trim()
    if (!c) return
    try {
      await window.api.challenge.add(c)
      setDraft('')
      await load()
      props.onChanged()
    } catch (e) {
      toast(`添加失败：${(e as Error).message}`)
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (editingId == null) return
    const c = editingText.trim()
    if (!c) return
    try {
      await window.api.challenge.update(editingId, c)
      setEditingId(null)
      setEditingText('')
      await load()
    } catch (e) {
      toast(`保存失败：${(e as Error).message}`)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return
    try {
      await window.api.challenge.remove(deleting.id)
      setDeleting(null)
      await load()
      props.onChanged()
    } catch (e) {
      toast(`删除失败：${(e as Error).message}`)
      setDeleting(null)
    }
  }

  return (
    <>
      <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
        <div className="dialog" style={{ width: 480 }}>
          <div className="dialog-header">挑战池管理</div>
          <div className="dialog-body zl-challenge-body">
            {rows.length === 0 && <div className="module-sub">还没有挑战项目，在下方添加第一条吧</div>}
            {rows.map((r) => (
              <div className="zl-challenge-row" key={r.id}>
                {editingId === r.id ? (
                  <>
                    <input
                      className="zl-challenge-input"
                      value={editingText}
                      autoFocus
                      onChange={(e) => setEditingText(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && void saveEdit()}
                    />
                    <button className="icon-btn" title="保存" onClick={() => void saveEdit()}>
                      <span className="material-symbols-outlined">check</span>
                    </button>
                    <button
                      className="icon-btn"
                      title="取消"
                      onClick={() => {
                        setEditingId(null)
                        setEditingText('')
                      }}
                    >
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  </>
                ) : (
                  <>
                    <span className="zl-challenge-text">{r.content}</span>
                    <button
                      className="icon-btn"
                      title="编辑"
                      onClick={() => {
                        setEditingId(r.id)
                        setEditingText(r.content)
                      }}
                    >
                      <span className="material-symbols-outlined">edit</span>
                    </button>
                    <button className="icon-btn" title="删除" onClick={() => setDeleting(r)}>
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="dialog-footer zl-challenge-footer">
            <input
              className="zl-challenge-input"
              placeholder="新的挑战项目，如：去跑步 2000m"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void add()}
            />
            <button className="btn btn-primary" disabled={!draft.trim()} onClick={() => void add()}>
              添加
            </button>
            <button className="btn" onClick={props.onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        title="删除挑战"
        danger
        confirmText="删除"
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      >
        <span>
          确定删除「{deleting?.content}」？该操作不可恢复；已定档日期的完成记录会保留（显示「已删除的挑战」）。
        </span>
      </ConfirmDialog>
    </>
  )
}
