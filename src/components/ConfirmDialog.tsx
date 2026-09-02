// 二次确认弹窗（总需求文档第 1 条：所有丢弃/删除操作必须）
import type { ReactNode } from 'react'

/** 额外动作按钮（如格言删除弹窗的「直接删除」），渲染在确认按钮右侧 */
export interface ConfirmDialogExtraAction {
  text: string
  danger?: boolean
  /** 比 danger 更深一档的删除色（btn-danger-deep） */
  deep?: boolean
  onAction: () => void
}

export interface ConfirmDialogProps {
  open: boolean
  title: string
  children?: ReactNode
  confirmText?: string
  danger?: boolean
  extraAction?: ConfirmDialogExtraAction
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog(props: ConfirmDialogProps) {
  const { open, title, children, confirmText = '确认', danger = false, extraAction, onConfirm, onCancel } = props
  if (!open) return null
  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" style={{ width: 400 }}>
        <div className="dialog-header">{title}</div>
        <div className="dialog-body" style={{ lineHeight: 1.7 }}>
          {children}
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
            {confirmText}
          </button>
          {extraAction && (
            <button
              className={`btn ${extraAction.deep ? 'btn-danger-deep' : extraAction.danger ? 'btn-danger' : ''}`}
              onClick={extraAction.onAction}
            >
              {extraAction.text}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
