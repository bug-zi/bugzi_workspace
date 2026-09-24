// 「进行中」页签（v2.2，specs §2 ReadingPanel）：读到一半的副本（in_progress），
// 继续阅读 / 删除；未读属待读区、读毕属收藏库，本页签只管「翻开没读完的」。
import { useCallback, useEffect, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import type { CopyCard } from '../../shared/types'

const SOURCE_ZH: Record<string, string> = { official: '官方', daily: '每日', diy: 'DIY' }

export default function ReadingPanel(props: { onRead: (id: number) => void }) {
  const { onRead } = props
  const { toast } = useToast()
  const [rows, setRows] = useState<CopyCard[] | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      setRows(await window.api.copy.list())
    } catch {
      /* 拉取失败保留旧列表 */
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useModuleActivated('fuben', () => void load())

  const discard = async (): Promise<void> => {
    if (confirmId == null) return
    try {
      await window.api.copy.discard(confirmId)
      toast('已放入回收站')
      setRows((r) => r?.filter((x) => x.id !== confirmId) ?? null)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setConfirmId(null)
    }
  }

  const ongoing = (rows ?? []).filter((c) => c.state === 'in_progress')

  return (
    <div className="fuben-library">
      {ongoing.length === 0 ? (
        <div className="fuben-empty">没有翻开未读完的人生——去「待读区」开一段，读到一半它就会出现在这里</div>
      ) : (
        <div className="fuben-list">
          {ongoing.map((c) => (
            <div key={c.id} className="fuben-row" onClick={() => onRead(c.id)}>
              <span className="material-symbols-outlined fuben-row-icon">schedule</span>
              <div className="fuben-row-main">
                <div className="fuben-row-title">{c.title}</div>
                <div className="fuben-row-sub">{c.subtitle}</div>
                <div className="fuben-card-meta">
                  <span className="fuben-chip">{c.category}</span>
                  <span className="fuben-chip">{c.mood}</span>
                  <span className="fuben-chip">{c.era}</span>
                  <span className="fuben-card-words">
                    {SOURCE_ZH[c.source] ?? c.source} · 读到第 {(c.progress?.stage ?? 0) + 1}/{c.stageCount} 章
                  </span>
                </div>
              </div>
              <div className="fuben-row-actions">
                <button className="fuben-btn-ghost" onClick={() => onRead(c.id)}>
                  继续阅读
                </button>
                <button
                  className="fuben-row-del"
                  title="放入回收站"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmId(c.id)
                  }}
                >
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmId != null}
        title="放入回收站"
        confirmText="删除"
        danger
        onConfirm={() => void discard()}
        onCancel={() => setConfirmId(null)}
      >
        确定把这段人生放入回收站吗？3 天内可在回收站恢复，逾期自动彻底删除。
      </ConfirmDialog>
    </div>
  )
}
