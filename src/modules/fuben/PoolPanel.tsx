// 待读区页签（v2 泵可视化，specs §2 PoolPanel）：补库泵维持 10-12 篇库存，用户可浏览、
// 直接开读、不喜欢删除（入回收站，删后泵自动补货）。每日三选一即从本区抽取。
import { useCallback, useEffect, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import type { CopyCard } from '../../shared/types'

export default function PoolPanel(props: {
  onRead: (id: number) => void
  /** FubenModule 传入的补库泵刷新信号：递增时重拉库存 */
  stockVersion: number
}) {
  const { onRead, stockVersion } = props
  const { toast } = useToast()
  const [rows, setRows] = useState<CopyCard[] | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      setRows(await window.api.copy.poolList())
    } catch {
      /* 拉取失败保留旧列表 */
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, stockVersion])

  const discard = async (): Promise<void> => {
    if (confirmId == null) return
    try {
      await window.api.copy.discard(confirmId)
      toast('已放入回收站，AI 会自动补货')
      setRows((r) => r?.filter((x) => x.id !== confirmId) ?? null)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setConfirmId(null)
    }
  }

  return (
    <div className="fuben-library">
      <div className="fuben-daily-head">
        <span className="fuben-daily-title">
          待读库存 {rows == null ? '' : `· ${rows.length} / 12 篇`}
        </span>
        <span className="module-sub">每日副本从这里随机抽三篇；不喜欢的可删去，AI 会自动补货</span>
      </div>

      {rows != null && rows.length === 0 ? (
        <div className="fuben-empty">AI 正在后台备货，稍候回来刷新即有新人生</div>
      ) : (
        <div className="fuben-list">
          {(rows ?? []).map((c) => (
            <div key={c.id} className="fuben-row">
              <div className="fuben-row-main">
                <div className="fuben-row-title">{c.title}</div>
                <div className="fuben-row-sub">{c.subtitle}</div>
                <div className="fuben-card-meta">
                  <span className="fuben-chip">{c.category}</span>
                  <span className="fuben-chip">{c.mood}</span>
                  <span className="fuben-chip">{c.era}</span>
                  <span className="fuben-card-words">{c.wordCount} 字</span>
                </div>
              </div>
              <div className="fuben-row-actions">
                <button className="fuben-btn-ghost" onClick={() => onRead(c.id)}>
                  立即开读
                </button>
                <button
                  className="fuben-row-del"
                  title="放入回收站"
                  onClick={() => setConfirmId(c.id)}
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
        确定把这段人生放入回收站吗？3 天内可恢复，逾期彻底删除；AI 之后会自动补一篇新的。
      </ConfirmDialog>
    </div>
  )
}
