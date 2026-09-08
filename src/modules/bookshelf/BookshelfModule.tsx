// 书架（书架 specs §3 + 优化第1轮 §8.3-8.5）：封面网格 + 导入 + 主栏内阅读切换
// （阅读编排：双模式全局记忆 + 目录/笔记侧栏 + 划词笔记闭环；零 AI 模块，无 LLM/边栏联动）
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BooksNote, BooksRecord } from '../../shared/types'
import { SettingsKeys } from '../../shared/types'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useAppSettings } from '../../theme/ThemeProvider'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import EpubReader, { type EpubReaderHandle } from './EpubReader'
import PdfReader, { type PdfReaderHandle } from './PdfReader'
import ReaderSidebar, { type ReaderLocate, type ReaderTocItem, type SidebarTab } from './ReaderSidebar'
import type { ReadingMode } from './readerKeys'
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
  // ----- 阅读编排（优化第1轮） -----
  /** 阅读模式（全局记忆；点书时从 settings 读取） */
  const [mode, setMode] = useState<ReadingMode>('scroll')
  const [toc, setToc] = useState<ReaderTocItem[]>([])
  const [locate, setLocate] = useState<ReaderLocate | null>(null)
  /** epub 笔记（pdf 为 null → 侧栏占位） */
  const [notes, setNotes] = useState<BooksNote[] | null>(null)
  const [side, setSide] = useState<{ open: boolean; tab: SidebarTab }>({ open: false, tab: 'toc' })
  const [confirmNote, setConfirmNote] = useState<BooksNote | null>(null)
  const epubRef = useRef<EpubReaderHandle>(null)
  const pdfRef = useRef<PdfReaderHandle>(null)
  /** 笔记最新值（EpubReader 挂载 effect 捕获的回调里做查重用） */
  const notesRef = useRef<BooksNote[]>([])
  notesRef.current = notes ?? []

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

  /** 打开书：读模式设置 + 重置阅读编排状态 + epub 载笔记 */
  const openBook = async (b: BooksRecord): Promise<void> => {
    let m: ReadingMode = 'scroll'
    try {
      const saved = await window.api.settings.get(SettingsKeys.BooksReadingMode)
      if (saved === 'page') m = 'page'
    } catch {
      /* 读失败用默认 */
    }
    setMode(m)
    setToc([])
    setLocate(null)
    setReaderLabel('')
    setSide({ open: false, tab: 'toc' })
    setNotes(null)
    setReading(b)
    if (b.format === 'epub') {
      try {
        setNotes(await window.api.books.notesList(b.id))
      } catch {
        setNotes([])
      }
    }
  }

  /** 模式切换：即时生效 + 全局记忆。
   *  epub 走全量重挂（key 含 mode）——先取最新进度行防回跳到开书位置（DB 每 3 秒节流落库）；
   *  pdf 阅读器内部重建视图，无需重挂。 */
  const toggleMode = async (): Promise<void> => {
    const next: ReadingMode = mode === 'scroll' ? 'page' : 'scroll'
    if (reading?.format === 'epub') {
      try {
        const fresh = await window.api.books.list()
        setReading((r) => (r ? (fresh.find((b) => b.id === r.id) ?? r) : r))
      } catch {
        /* 取失败沿用现值 */
      }
    }
    setMode(next)
    try {
      await window.api.settings.set(SettingsKeys.BooksReadingMode, next)
    } catch {
      /* 持久化失败不阻断本次切换 */
    }
  }

  // ----- 阅读回调（useCallback 稳定身份：EpubReader 挂载 effect 捕获首帧引用） -----
  const onToc = useCallback((list: ReaderTocItem[]) => setToc(list), [])
  const onLocateCb = useCallback((l: ReaderLocate) => {
    setLocate((prev) => (prev?.href === l.href && prev?.page === l.page ? prev : l))
  }, [])
  const onAddNote = useCallback(
    (n: { cfiRange: string; quote: string; note: string }) => {
      if (notesRef.current.some((x) => x.cfi_range === n.cfiRange)) {
        toast('已有高光')
        return
      }
      const bid = reading?.id
      if (bid == null) return
      void window.api.books.noteAdd(bid, n).then((row) => {
        setNotes((prev) => [row, ...(prev ?? [])])
        toast(n.note ? '批注已保存' : '已高光')
      })
    },
    [reading?.id, toast]
  )
  const onUpdateNote = useCallback((id: number, note: string) => {
    void window.api.books.noteUpdate(id, note).then(() => {
      setNotes((prev) => prev?.map((n) => (n.id === id ? { ...n, note } : n)) ?? prev)
    })
  }, [])
  const onRemoveNote = useCallback((id: number) => {
    const target = notesRef.current.find((n) => n.id === id)
    if (target) setConfirmNote(target)
  }, [])

  /** 笔记删除确认后执行（彻底删除不入回收站） */
  const doDeleteNote = async (): Promise<void> => {
    const target = confirmNote
    if (!target) return
    setConfirmNote(null)
    await window.api.books.noteRemove(target.id)
    setNotes((prev) => prev?.filter((n) => n.id !== target.id) ?? prev)
  }

  /** 侧栏跳转：epub 按 href / pdf 按页码 */
  const jumpToc = (item: ReaderTocItem): void => {
    if (reading?.format === 'epub' && item.href) epubRef.current?.jumpToToc(item.href)
    else if (reading?.format === 'pdf' && item.page != null) pdfRef.current?.jumpToPage(item.page)
  }
  const jumpNote = (n: BooksNote): void => {
    epubRef.current?.jumpToCfi(n.cfi_range)
  }

  // ----- 阅读视图（主栏整体切换） -----
  if (reading) {
    return (
      <div className={`module-page bk-reader-page${reading.format === 'epub' ? ' bk-reader-wide' : ''}`}>
        <div className="bk-reader-bar">
          <button
            className="btn"
            onClick={() => {
              setReading(null)
              void load() // 回书架刷新进度角标
            }}
          >
            <span className="material-symbols-outlined">arrow_back</span>藏书架
          </button>
          <div className="bk-reader-title" title={reading.title}>
            {reading.title}
          </div>
          <div className="bk-reader-progress">{readerLabel}</div>
          <button
            className={`btn bk-bar-btn${side.open ? ' active' : ''}`}
            onClick={() => setSide((s) => ({ ...s, open: !s.open }))}
            title="目录 / 笔记侧栏"
          >
            <span className="material-symbols-outlined">toc</span>
          </button>
          <button className="btn bk-bar-btn" onClick={() => void toggleMode()} title="切换阅读模式（滚动 / 翻页，WASD 与方向键同效）">
            <span className="material-symbols-outlined">{mode === 'scroll' ? 'unfold_more' : 'menu_book'}</span>
            {mode === 'scroll' ? '滚动' : '翻页'}
          </button>
        </div>
        <div className={`bk-reader-flex${side.open ? ' with-side' : ''}`}>
          {side.open && (
            <ReaderSidebar
              tab={side.tab}
              onTabChange={(t) => setSide((s) => ({ ...s, tab: t }))}
              toc={toc}
              locate={locate}
              notes={reading.format === 'epub' ? notes : null}
              onJumpToc={jumpToc}
              onJumpNote={jumpNote}
              onDeleteNote={(n) => setConfirmNote(n)}
              onCollapse={() => setSide((s) => ({ ...s, open: false }))}
            />
          )}
          <div className="bk-reader-body">
            {reading.format === 'epub' ? (
              <EpubReader
                key={`${reading.id}-${mode}`}
                ref={epubRef}
                book={reading}
                theme={theme}
                mode={mode}
                notes={notes ?? []}
                onProgress={setReaderLabel}
                onToc={onToc}
                onLocate={onLocateCb}
                onAddNote={onAddNote}
                onUpdateNote={onUpdateNote}
                onRemoveNote={onRemoveNote}
              />
            ) : (
              <PdfReader
                key={reading.id}
                ref={pdfRef}
                book={reading}
                mode={mode}
                onProgress={setReaderLabel}
                onToc={onToc}
                onLocate={onLocateCb}
              />
            )}
          </div>
        </div>

        {/* 删除笔记：二次确认（彻底删除不入回收站） */}
        <ConfirmDialog
          open={!!confirmNote}
          title="删除笔记"
          danger
          confirmText="彻底删除"
          onCancel={() => setConfirmNote(null)}
          onConfirm={() => void doDeleteNote()}
        >
          将删除这条{confirmNote?.note ? '批注' : '高光'}及其书内标记，不可恢复。
        </ConfirmDialog>
      </div>
    )
  }

  // ----- 书架视图 -----
  return (
    <div className="module-page">
      <div className="module-header">
        <div className="module-title">藏书架</div>
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
          藏书架还空着，导入一本 epub 或 pdf 开始阅读
        </div>
      ) : (
        <div className="bk-grid">
          {items.map((b) => (
            <div key={b.id} className="bk-card" onClick={() => void openBook(b)} title={b.title}>
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
        将删除《{delTarget?.title}》及其封面文件与划词笔记，不可恢复（不入回收站）。
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
        以下书籍可能与藏书架中已有的书重复：
        <br />
        {dupPending?.titles.map((t) => `《${t}》`).join('、')}
        <br />
        仍要导入吗？
      </ConfirmDialog>
    </div>
  )
}
