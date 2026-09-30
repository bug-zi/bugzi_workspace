// 历史版本（specs §6）：AI 写入前快照列表（时间 + 需求摘要），恢复二次确认后整篇/全簿覆盖。
import { useEffect, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import type { OfficeVersionRow } from '../../shared/types'

interface Props {
  open: boolean
  docId: number
  onClose: () => void
  onRestored: () => void
}

function fmt(iso: string): string {
  const d = new Date(iso)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function HistoryDialog({ open, docId, onClose, onRestored }: Props) {
  const [rows, setRows] = useState<OfficeVersionRow[]>([])
  const [target, setTarget] = useState<OfficeVersionRow | null>(null)

  useEffect(() => {
    if (open) void window.api.office.versions(docId).then(setRows)
  }, [open, docId])

  if (!open) return null

  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 480 }}>
        <div className="dialog-header">历史版本（AI 写入前快照，最多保留 10 份）</div>
        <div className="dialog-body">
          {rows.length === 0 && (
            <div className="module-sub">还没有历史版本——AI 每次写入文档前会自动存一版。</div>
          )}
          {rows.map((v) => (
            <div key={v.id} className="zl-row" style={{ cursor: 'default' }}>
              <span className="module-sub">{fmt(v.created_at)}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {v.note ?? '（无需求摘要）'}
              </span>
              <button className="btn" onClick={() => setTarget(v)}>
                恢复
              </button>
            </div>
          ))}
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={target != null}
        title="恢复该版本？"
        confirmText="恢复"
        onConfirm={async () => {
          if (!target) return
          await window.api.office.restoreVersion(target.id)
          setTarget(null)
          onRestored()
        }}
        onCancel={() => setTarget(null)}
      >
        当前内容将被该版本覆盖（恢复后自动保存）。
      </ConfirmDialog>
    </div>
  )
}
