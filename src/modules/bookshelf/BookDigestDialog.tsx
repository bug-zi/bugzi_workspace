// 书籍 AI 解读弹窗（超级工作台 2.0 批次E spec §3）：状态机（none/running/done/failed，库行为准）
// + 导读 MdDialog（readOnly + 重新生成二次确认 + 追问注入「文献·追问」频道）；
// book_digest 队列事件驱动状态刷新，done 自动打开导读，生成中可先关窗。
import { useCallback, useEffect, useRef, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import MdDialog from '../../components/MdDialog'
import KnowledgeLinksDialog, { type RelatedLink } from '../../components/KnowledgeLinksDialog'
import { useToast } from '../../components/Toast'
import { openRelated, relatedIcon } from '../../services/relatedNav'
import type { BooksRecord } from '../../shared/types'

interface Props {
  book: BooksRecord
  onClose: () => void
}

export default function BookDigestDialog({ book, onClose }: Props) {
  const { toast } = useToast()
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<'none' | 'running' | 'done' | 'failed'>('none')
  const [mdPath, setMdPath] = useState<string | null>(null)
  const [viewOpen, setViewOpen] = useState(false)
  const [mdVersion, setMdVersion] = useState(0)
  const [confirmRegen, setConfirmRegen] = useState(false)
  const [starting, setStarting] = useState(false)
  // 相关内容 / 关联知识（批次F）
  const [bookLinks, setBookLinks] = useState<RelatedLink[]>([])
  const [linksOpen, setLinksOpen] = useState(false)
  // done 自动打开导读仅一次（用户手关后不再抢开；重生成时复位）
  const autoOpenedRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const st = await window.api.bookDigest.get(book.id)
      setStatus(st.status)
      setMdPath(st.md_path)
      if (st.status === 'failed') toast('导读生成失败，详见控制台 [agent] 日志')
    } catch {
      /* 书刚被删等场景静默 */
    } finally {
      setLoaded(true)
    }
  }, [book.id, toast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // book_digest 队列事件 → 刷新（running 中完成自动打开导读）
  useEffect(() => {
    const off = window.api.agent.onAgentStatus((s) => {
      const ev = s.lastEvent
      if (!ev || ev.type !== 'book_digest' || ev.status === 'enqueued') return
      void refresh()
    })
    return off
  }, [refresh])

  useEffect(() => {
    if (loaded && status === 'done' && mdPath && !autoOpenedRef.current) {
      autoOpenedRef.current = true
      setViewOpen(true)
    }
  }, [loaded, status, mdPath])

  // 相关内容（批次F）：导读视图打开时加载双向链接
  useEffect(() => {
    if (!viewOpen || status !== 'done') {
      setBookLinks([])
      return
    }
    void window.api.links
      .list('book', book.id)
      .then((rows) => setBookLinks(rows as RelatedLink[]))
      .catch(() => setBookLinks([]))
  }, [viewOpen, status, book.id])

  const start = (force = false): void => {
    if (starting) return
    setStarting(true)
    autoOpenedRef.current = false
    void window.api.bookDigest
      .run(book.id, force)
      .then(() => {
        void refresh()
      })
      .catch((e: unknown) => {
        const msg = (e as Error).message
        if (msg.includes('INTERPRET_EXISTS')) setConfirmRegen(true)
        else if (msg.includes('正在进行中')) toast(msg)
        else toast(`触发失败：${msg}`)
      })
      .finally(() => setStarting(false))
  }

  const openDigest = (): void => {
    if (mdPath) {
      setMdVersion((v) => v + 1)
      setViewOpen(true)
    }
  }

  // 导读视图（done 态主视图）
  if (viewOpen && status === 'done' && mdPath) {
    return (
      <>
        <MdDialog
          key={mdVersion}
          open
          title={`导读：${book.title}`}
          titleTag="AI 解读"
          subtitle={book.author || undefined}
          filePath={mdPath}
          readOnly
          headerAction={{ label: '重新生成', icon: 'refresh', onClick: () => setConfirmRegen(true) }}
          footerBar={
            <div className="sci-footer">
              {bookLinks.length > 0 && (
                <div className="sci-footer-row sci-concepts">
                  <span className="sci-concepts-label">相关内容</span>
                  {bookLinks.map((l) => (
                    <button
                      key={l.link_id}
                      className="sci-chip"
                      title={l.origin === 'manual' ? '手动关联，点击打开' : `语义相似 ${Math.round(l.score * 100)}%，点击打开`}
                      onClick={() => {
                        setViewOpen(false)
                        openRelated(l)
                      }}
                    >
                      <span className="material-symbols-outlined sci-chip-icon">{relatedIcon(l.peer_type)}</span>
                      {l.title}
                    </button>
                  ))}
                </div>
              )}
              <div className="sci-footer-row">
                <button
                  className="btn btn-primary"
                  onClick={() => void window.api.agent.askLiterature('book', book.id)}
                  title="注入全书导读上下文，在右栏「文献·追问」场景继续提问"
                >
                  <span className="material-symbols-outlined">forum</span>
                  追问
                </button>
                <button className="btn" onClick={() => setLinksOpen(true)} title="管理本书的手动/语义关联">
                  <span className="material-symbols-outlined">hub</span>
                  关联知识
                </button>
              </div>
            </div>
          }
          onClose={() => setViewOpen(false)}
        />
        <KnowledgeLinksDialog
          open={linksOpen}
          srcType="book"
          srcId={book.id}
          title={book.title}
          onClose={() => setLinksOpen(false)}
        />
        <ConfirmDialog
          open={confirmRegen}
          title="重新生成导读"
          danger
          confirmText="重新生成"
          onConfirm={() => {
            setConfirmRegen(false)
            setViewOpen(false)
            start(true)
          }}
          onCancel={() => setConfirmRegen(false)}
        >
          已有导读产物，重新生成将覆盖现有内容（全书重新通读，需数分钟）。确定继续？
        </ConfirmDialog>
      </>
    )
  }

  return (
    <>
      <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="dialog" style={{ width: 420 }}>
          <div className="dialog-header">AI 解读 · {book.title}</div>
          <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {status === 'running' ? (
              <div className="empty-state" style={{ padding: '18px 0' }}>
                <span className="material-symbols-outlined spin">progress_activity</span>
                <div>正在通读全书并生成中文导读…</div>
                <div className="module-sub">可先关闭本窗，完成后任务中心与本书卡入口均可见</div>
              </div>
            ) : status === 'done' ? (
              <div className="module-sub">已有导读产物，可直接查看，或重新生成覆盖。</div>
            ) : status === 'failed' ? (
              <div className="module-sub">
                上次生成失败（扫描版 PDF 无文本层或服务异常）。可重试；失败不影响书籍的其他功能。
              </div>
            ) : (
              <div className="module-sub">
                AI 通读全书后生成中文导读：这本书讲什么 / 全书结构 / 各部分要点 / 适合谁 / 怎么读。
                生成需数分钟，后台进行。扫描版 PDF（无文本层）会失败。
              </div>
            )}
          </div>
          <div className="dialog-footer">
            <button className="btn" onClick={onClose}>
              关闭
            </button>
            {status === 'done' && (
              <button className="btn" onClick={openDigest}>
                <span className="material-symbols-outlined">visibility</span>
                查看导读
              </button>
            )}
            <button
              className="btn btn-primary"
              disabled={status === 'running' || starting}
              onClick={() => {
                if (status === 'done') setConfirmRegen(true)
                else start(status === 'failed')
              }}
            >
              <span className={`material-symbols-outlined${status === 'running' || starting ? ' spin' : ''}`}>
                {status === 'running' || starting ? 'progress_activity' : 'auto_awesome'}
              </span>
              {status === 'running' || starting
                ? '生成中…'
                : status === 'done' || status === 'failed'
                  ? '重新生成'
                  : '生成全书导读'}
            </button>
          </div>
        </div>
      </div>
      {/* done 态重生成二次确认（MdDialog headerAction 与本弹窗主钮共用） */}
      <ConfirmDialog
        open={confirmRegen}
        title="重新生成导读"
        danger
        confirmText="重新生成"
        onConfirm={() => {
          setConfirmRegen(false)
          start(true)
        }}
        onCancel={() => setConfirmRegen(false)}
      >
        已有导读产物，重新生成将覆盖现有内容（全书重新通读，需数分钟）。确定继续？
      </ConfirmDialog>
    </>
  )
}
