// 书架（书架 specs §3）：封面网格 + 导入 + 主栏内阅读切换（零 AI 模块，无 LLM/边栏联动）
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BooksRecord } from '../../shared/types'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useAppSettings } from '../../theme/ThemeProvider'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import EpubReader from './EpubReader'
import PdfReader from './PdfReader'
import './bookshelf.css'

/** 卡片进度角标：读过显百分比，没读过显「未读」 */
function progressLabel(b: BooksRecord): string {
  if (!b.last_read_at) return '未读'
  if (b.progress_percent > 0) return `${Math.round(b.progress_percent)}%`
  return '在读'
}

export default function BookshelfModule() {
  const { toast } = useToast()
  const { theme } = useAppSettings()
  const [items, setItems] = useState<BooksRecord[]>([])
  const [reading, setReading] = useState<BooksRecord | null>(null)
  const [readerLabel, setReaderLabel] = useState('')
  const [delTarget, setDelTarget] = useState<BooksRecord | null>(null)
  const [dupPending, setDupPending] = useState<{ paths: string[]; titles: string[] } | null>(null)
  const importingRef = useRef(false)

  const load = useCallback(async () => {
    setItems(await window.api.books.list())
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useModuleActivated('bookshelf', () => void load())

  /** 导入：对话框 → 复制解析 → duplicate 弹确认可 force 重导 */
  const doImport = async (paths?: string[], force?: boolean): Promise<void> => {
    if (importingRef.current) return
    importingRef.current = true
    try {
      const picked = paths ?? (await window.api.books.browse())
      if (picked.length === 0) return
      const results = await window.api.books.import(picked, force)
      const ok = results.filter((r) => r.status === 'imported').length
      const dups = results.filter((r) => r.status === 'duplicate')
      const fails = results.filter((r) => r.status === 'failed')
      if (dups.length > 0 && !force) {
        setDupPending({ paths: dups.map((d) => d.path), titles: dups.map((d) => d.title) })
        if (ok > 0) toast(`已导入 ${ok} 本`)
      } else if (ok > 0) {
        toast(`已导入 ${ok} 本`)
      }
      if (fails.length > 0) toast(`${fails.length} 本导入失败：${fails[0].error}`)
      await load()
    } catch (e) {
      toast(`导入失败：${(e as Error).message}`)
    } finally {
      importingRef.current = false
    }
  }

  const doDelete = async (): Promise<void> => {
    if (!delTarget) return
    await window.api.books.delete(delTarget.id)
    toast('已彻底删除')
    setDelTarget(null)
    await load()
  }

  // ----- 阅读视图（主栏整体切换） -----
  if (reading) {
    return (
      <div className="module-page bk-reader-page">
        <div className="bk-reader-bar">
          <button
            className="btn"
            onClick={() => {
              setReading(null)
              void load() // 回书架刷新进度角标
            }}
          >
            <span className="material-symbols-outlined">arrow_back</span>书架
          </button>
          <div className="bk-reader-title" title={reading.title}>
            {reading.title}
          </div>
          <div className="bk-reader-progress">{readerLabel}</div>
        </div>
        <div className="bk-reader-body">
          {reading.format === 'epub' ? (
            <EpubReader key={reading.id} book={reading} theme={theme} onProgress={setReaderLabel} />
          ) : (
            <PdfReader key={reading.id} book={reading} onProgress={setReaderLabel} />
          )}
        </div>
      </div>
    )
  }

  // ----- 书架视图 -----
  return (
    <div className="module-page">
      <div className="module-header">
        <div className="module-title">书架</div>
        <div className="module-sub">{items.length} 本</div>
        <div style={{ marginLeft: 'auto' }}>
          <button className="btn" onClick={() => void doImport()}>
            <span className="material-symbols-outlined">upload_file</span>导入书籍
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <span className="material-symbols-outlined">auto_stories</span>
          书架还空着，导入一本 epub 或 pdf 开始阅读
        </div>
      ) : (
        <div className="bk-grid">
          {items.map((b) => (
            <div key={b.id} className="bk-card" onClick={() => setReading(b)} title={b.title}>
              {b.cover_path ? (
                <img className="bk-cover" src={`bzres://root/${b.cover_path}`} alt={b.title} loading="lazy" />
              ) : (
                <div className="bk-cover bk-cover-empty">
                  <span className="bk-cover-title">{b.title}</span>
                </div>
              )}
              <div className="bk-info">
                <div className="bk-title">{b.title}</div>
                <div className="bk-meta">{b.author || b.format.toUpperCase()}</div>
                <div className="bk-progress">{progressLabel(b)}</div>
              </div>
              <button
                className="icon-btn bk-menu"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation()
                  setDelTarget(b)
                }}
              >
                <span className="material-symbols-outlined">delete</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 删除：二次确认直接彻底删（不入回收站） */}
      <ConfirmDialog
        open={!!delTarget}
        title="彻底删除书籍"
        danger
        confirmText="彻底删除"
        onCancel={() => setDelTarget(null)}
        onConfirm={() => void doDelete()}
      >
        将删除《{delTarget?.title}》及其封面文件，不可恢复（不入回收站）。
      </ConfirmDialog>

      {/* 疑似重复导入确认（仍要导入 → force 重导） */}
      <ConfirmDialog
        open={!!dupPending}
        title="疑似已导入"
        confirmText="仍要导入"
        onCancel={() => setDupPending(null)}
        onConfirm={() => {
          const p = dupPending
          setDupPending(null)
          if (p) void doImport(p.paths, true)
        }}
      >
        以下书籍可能与书架中已有的书重复：
        <br />
        {dupPending?.titles.map((t) => `《${t}》`).join('、')}
        <br />
        仍要导入吗？
      </ConfirmDialog>
    </div>
  )
}
