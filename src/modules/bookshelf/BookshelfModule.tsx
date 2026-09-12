// 书架（书架 specs §3 + 优化第1轮 §8.3-8.5 + v2.0）：封面网格 + 导入 + 主栏内阅读切换
// （阅读编排：双模式每书记忆 + 目录/笔记/书签侧栏 + 划词笔记闭环 + 字号每书独立 + 阅读统计；零 AI 模块）
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BookMark, BooksNote, BooksReadingBg, BooksRecord, ReadStats } from '../../shared/types'
import { SettingsKeys } from '../../shared/types'
import ConfirmDialog from '../../components/ConfirmDialog'
import MdDialog from '../../components/MdDialog'
import { useToast } from '../../components/Toast'
import { useAppSettings } from '../../theme/ThemeProvider'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { useModuleNavigate } from '../../hooks/useModuleNavigate'
import EpubReader, { type EpubReaderHandle } from './EpubReader'
import PdfReader, { type PdfReaderHandle } from './PdfReader'
import ReaderSidebar, { flattenToc, relTime, tocAnchorAt, epubChapterAt, type ReaderLocate, type ReaderTocItem, type SidebarTab } from './ReaderSidebar'
import { useReadingTimer } from './useReadingTimer'
import type { ReadingMode } from './readerKeys'
import ActionMenu from '../../components/ActionMenu'
import { FONT_FAMILIES, READER_FONTS } from '../../theme/fonts'
import './bookshelf.css'

/** 卡片进度角标：读过显百分比，没读过显「未读」 */
function progressLabel(b: BooksRecord): string {
  if (!b.last_read_at) return '未读'
  if (b.progress_percent > 0) return `${Math.round(b.progress_percent)}%`
  return '在读'
}

/** 阅读背景纯色预设（260911 阅读背景设计 §三）：低饱和纸感色 + 配对正文字色 */
const READER_BG_PRESETS: { id: string; label: string; color: string; textColor: 'dark' | 'light' }[] = [
  { id: 'paper', label: '纸黄', color: '#f5ecd7', textColor: 'dark' },
  { id: 'cream', label: '米白', color: '#f7f3ea', textColor: 'dark' },
  { id: 'green', label: '护眼绿', color: '#cde6c8', textColor: 'dark' },
  { id: 'celadon', label: '青瓷', color: '#d3e3e0', textColor: 'dark' },
  { id: 'warm', label: '暖灰', color: '#e8e2da', textColor: 'dark' },
  { id: 'night', label: '夜读黑', color: '#1e2226', textColor: 'light' }
]

/** 图片平均亮度采样（0~1；设计 §六）：32×32 缩略图 Rec.709 加权均值，< 0.5 判深图配浅字 */
async function sampleImageBrightness(url: string): Promise<number> {
  const blob = await (await fetch(url)).blob()
  const bmp = await createImageBitmap(blob)
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return 1 // 拿不到 2d 上下文按浅图处理（配深字，安全侧）
  ctx.drawImage(bmp, 0, 0, size, size)
  const { data } = ctx.getImageData(0, 0, size, size)
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.2125 * data[i] + 0.7154 * data[i + 1] + 0.0721 * data[i + 2]
  }
  return sum / (data.length / 4) / 255
}

/** 秒 → 分钟文案（统计条/面板共用；>0 不足 1 分显「<1 分钟」；书架 v2.0 §五） */
function fmtMinutes(seconds: number): string {
  if (seconds <= 0) return '0 分钟'
  const m = Math.floor(seconds / 60)
  if (m < 1) return '<1 分钟'
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest > 0 ? `${h} 小时 ${rest} 分钟` : `${h} 小时`
}

/** 当前时刻 → YYYY-MM-DD HH:mm（总览副标题「生成于」） */
function fmtNow(): string {
  const t = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
}

export interface BookshelfModuleProps {
  /** 阅读态上报（藏阅阁壳据此隐藏头部与页签条；不传=行为不变） */
  onReadingChange?: (reading: boolean) => void
}

export default function BookshelfModule(props: BookshelfModuleProps) {
  const { toast } = useToast()
  const { theme, settings } = useAppSettings()
  const [items, setItems] = useState<BooksRecord[]>([])
  /** items 最新值（总导览续读深链查书用） */
  const itemsRef = useRef(items)
  itemsRef.current = items
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
  // ----- v2.0 编排：书签 / 统计 / 笔记总览 -----
  const [marks, setMarks] = useState<BookMark[]>([])
  const [confirmMark, setConfirmMark] = useState<BookMark | null>(null)
  const [stats, setStats] = useState<ReadStats | null>(null)
  const [statsOpen, setStatsOpen] = useState(false)
  /** 非空 = 打开笔记总览弹窗（内容快照） */
  const [overview, setOverview] = useState<string | null>(null)
  /** 阅读视图根节点（计时器组件可见性判定锚点） */
  const readerPageRef = useRef<HTMLDivElement>(null)
  const epubRef = useRef<EpubReaderHandle>(null)
  const pdfRef = useRef<PdfReaderHandle>(null)
  /** 笔记最新值（EpubReader 挂载 effect 捕获的回调里做查重用） */
  const notesRef = useRef<BooksNote[]>([])
  notesRef.current = notes ?? []
  /** 字体浮层锚点（null=关） */
  const [fontAnchor, setFontAnchor] = useState<HTMLButtonElement | null>(null)
  // ----- 阅读背景（全局一份，所有书共用；260911 阅读背景设计） -----
  const [readingBg, setReadingBg] = useState<BooksReadingBg>({ kind: 'theme' })
  /** 自定义图文件名（null=无图；文件在 userData/bg/，bzres://bg/ 加载） */
  const [readerBgImage, setReaderBgImage] = useState<string | null>(null)
  /** 背景菜单锚点（null=关） */
  const [bgAnchor, setBgAnchor] = useState<HTMLButtonElement | null>(null)

  // 背景偏好启动恢复（坏 JSON 静默保持默认）
  useEffect(() => {
    void window.api.settings.get(SettingsKeys.BooksReadingBg).then((raw) => {
      if (!raw) return
      try {
        const v = JSON.parse(raw) as BooksReadingBg
        if (v && (v.kind === 'theme' || v.kind === 'color' || v.kind === 'image')) setReadingBg(v)
      } catch {
        /* 坏数据保持默认 */
      }
    })
    void window.api.settings.get(SettingsKeys.ReaderBgImage).then((v) => setReaderBgImage(v || null))
  }, [])

  /** 背景偏好应用（即落库） */
  const applyReadingBg = (next: BooksReadingBg): void => {
    setReadingBg(next)
    void window.api.settings.set(SettingsKeys.BooksReadingBg, JSON.stringify(next))
  }

  /** 上传自定义背景图：pick → 读回文件名 → 亮度采样定字色 → kind=image（设计 §六） */
  const uploadReaderBg = async (): Promise<void> => {
    const ok = await window.api.image.pick('reader-bg')
    if (!ok) return // null=取消 / false=异常，均不动作
    const file = await window.api.settings.get(SettingsKeys.ReaderBgImage)
    setReaderBgImage(file || null)
    let textColor: 'dark' | 'light' = 'dark'
    if (file) {
      try {
        textColor = (await sampleImageBrightness(`bzres://bg/${file}`)) < 0.5 ? 'light' : 'dark'
      } catch {
        /* 采样失败按浅色图深字处理（安全侧） */
      }
    }
    applyReadingBg({ kind: 'image', textColor })
  }

  /** 清除自定义图：清引用回落主题，文件由下次上传覆盖清理（设计 §四） */
  const clearReaderBgImage = (): void => {
    applyReadingBg({ kind: 'theme' })
    setReaderBgImage(null)
    void window.api.settings.set(SettingsKeys.ReaderBgImage, '')
  }

  const load = useCallback(async () => {
    setItems(await window.api.books.list())
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  // 260912 收藏夹+藏书架合并藏阅阁：激活 id 随壳（zangyue）
  useModuleActivated('zangyue', () => {
    void load()
    void refreshStats()
  })
  // 总导览深链（260912）：续读直达——找书 openBook 进阅读器（列表未载完则现拉一次）
  useModuleNavigate('zangyue', (target, payload) => {
    if (target !== 'read') return
    const bookId = payload?.bookId
    if (typeof bookId !== 'number') return
    void (async () => {
      const hit =
        itemsRef.current.find((b) => b.id === bookId) ??
        (await window.api.books.list()).find((b) => b.id === bookId)
      if (hit) void openBook(hit)
    })()
  })

  /** 阅读统计加载（失败静默，不阻断书架；书架 v2.0 §五） */
  const refreshStats = useCallback(async () => {
    try {
      setStats(await window.api.books.readStats())
    } catch {
      /* 静默 */
    }
  }, [])
  useEffect(() => {
    void refreshStats()
  }, [refreshStats])
  // 阅读计时（三条件口径 + 30 秒 flush；书架 v2.0 §五）
  useReadingTimer(reading != null, reading?.id ?? null, readerPageRef)

  // 阅读态上报（ref 转发防 inline prop 身份变化重触发；进/出阅读器各一次）
  const readingActive = reading != null
  const onReadingChangeRef = useRef(props.onReadingChange)
  onReadingChangeRef.current = props.onReadingChange
  useEffect(() => {
    onReadingChangeRef.current?.(readingActive)
  }, [readingActive])

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

  /** 打开书：书级模式优先（NULL 回落全局「最近使用」）+ 重置编排状态 + epub 载笔记 + 载书签（书架 v2.0 §四） */
  const openBook = async (b: BooksRecord): Promise<void> => {
    let m: ReadingMode = b.reading_mode ?? 'scroll'
    if (b.reading_mode == null) {
      try {
        const saved = await window.api.settings.get(SettingsKeys.BooksReadingMode)
        if (saved === 'page') m = 'page'
      } catch {
        /* 读失败用默认 */
      }
    }
    setMode(m)
    setToc([])
    setLocate(null)
    setReaderLabel('')
    setSide({ open: false, tab: 'toc' })
    setNotes(null)
    setMarks([])
    setReading(b)
    try {
      setMarks(await window.api.books.marksList(b.id))
    } catch {
      setMarks([])
    }
    if (b.format === 'epub') {
      try {
        setNotes(await window.api.books.notesList(b.id))
      } catch {
        setNotes([])
      }
    }
  }

  /** 模式切换：写书级偏好（每书独立）+ 全局键刷「最近使用」（NULL 书跟随）——书架 v2.0 §四；
   *  epub 全量重挂前取最新进度行防回跳（specs §8.3 机制不变） */
  const toggleMode = async (): Promise<void> => {
    if (!reading) return
    const next: ReadingMode = mode === 'scroll' ? 'page' : 'scroll'
    if (reading.format === 'epub') {
      try {
        const fresh = await window.api.books.list()
        setReading((r) => (r ? (fresh.find((b) => b.id === r.id) ?? r) : r))
      } catch {
        /* 取失败沿用现值 */
      }
    }
    setMode(next)
    const bid = reading.id
    void window.api.books.setReadingPref(bid, { mode: next }).then(() => {
      setReading((r) => (r && r.id === bid ? { ...r, reading_mode: next } : r))
    })
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

  /** 加书签：当前位置 + label「章节名 · 位置」（书签优化轮 §二，区间锚点解析）；同位置去重 toast */
  const addBookmark = (): void => {
    if (!reading) return
    if (reading.format === 'epub') {
      const cur = epubRef.current?.getCurrent()
      if (!cur?.cfi) {
        toast('正在加载，稍后再试')
        return
      }
      if (marks.some((m) => m.cfi === cur.cfi)) {
        toast('已有书签')
        return
      }
      const pct = Math.round(cur.percent * 100)
      // 反馈修订：locate.href 为锚点级解析结果（含 #anchor）时精确命中真章节；回落文件粒度区间
      const anchor = flattenToc(toc).find((it) => it.href === locate?.href)?.label ?? null
      const chapter =
        anchor ?? (locate?.spineIndex != null ? (epubChapterAt(toc, locate.spineIndex)?.label ?? null) : null)
      const label = chapter ? `${chapter} · ${pct}%` : `约 ${pct}%`
      void window.api.books.markAdd(reading.id, { cfi: cur.cfi, label }).then((row) => {
        setMarks((prev) => [row, ...prev])
        toast('已加书签')
      })
    } else {
      const page = locate?.page ?? reading.progress_page ?? 1
      if (marks.some((m) => m.page === page)) {
        toast('已有书签')
        return
      }
      const anchor = tocAnchorAt(toc, page)?.label
      const label = anchor ? `${anchor} · 第 ${page} 页` : `第 ${page} 页`
      void window.api.books.markAdd(reading.id, { page, label }).then((row) => {
        setMarks((prev) => [row, ...prev])
        toast('已加书签')
      })
    }
  }

  /** 书签跳回（epub 按 CFI / pdf 按页码） */
  const jumpMark = (m: BookMark): void => {
    if (reading?.format === 'epub' && m.cfi) epubRef.current?.jumpToCfi(m.cfi)
    else if (reading?.format === 'pdf' && m.page != null) pdfRef.current?.jumpToPage(m.page)
  }

  /** 书签改名/备注保存（书签优化轮 §四）：整行回填本地 */
  const updateMark = (id: number, m: { label: string; note: string }): void => {
    void window.api.books
      .markUpdate(id, m)
      .then((row) => {
        setMarks((prev) => prev.map((x) => (x.id === id ? row : x)))
        toast('已保存')
      })
      .catch(() => toast('保存失败'))
  }

  /** 书签删除确认后执行（彻底删除不入回收站） */
  const doDeleteMark = async (): Promise<void> => {
    const target = confirmMark
    if (!target) return
    setConfirmMark(null)
    await window.api.books.markRemove(target.id)
    setMarks((prev) => prev.filter((m) => m.id !== target.id))
  }

  /** 字号步进（0.75~1.5 步 0.05 钳制；NULL 视作 1.0；书架 v2.0 §四） */
  const stepFont = (delta: number): void => {
    if (!reading || reading.format !== 'epub') return
    const cur = reading.font_scale ?? 1
    const next = Math.round(Math.min(1.5, Math.max(0.75, cur + delta)) * 100) / 100
    if (next === cur) return
    void window.api.books.setReadingPref(reading.id, { fontScale: next }).then(() => {
      setReading((r) => (r && r.id === reading.id ? { ...r, font_scale: next } : r))
    })
  }

  /** 字号回落全局（清除书级值） */
  const resetFont = (): void => {
    if (!reading) return
    void window.api.books.setReadingPref(reading.id, { fontScale: null }).then(() => {
      setReading((r) => (r && r.id === reading.id ? { ...r, font_scale: null } : r))
    })
  }

  /** 书级字体设置（null=跟随全局；字体选择轮 §1.2，镜像 stepFont） */
  const setBookFont = (value: string | null): void => {
    if (!reading || reading.format !== 'epub') return
    void window.api.books.setReadingPref(reading.id, { fontFamily: value }).then(() => {
      setReading((r) => (r && r.id === reading.id ? { ...r, font_family: value } : r))
    })
  }

  /** 「跟随全局（X）」动态名：反查个人档全局字体；未设置=系统 */
  const globalFontName = (): string => {
    const hit = FONT_FAMILIES.find((f) => f.value === settings[SettingsKeys.FontFamily])
    return hit ? hit.label.split('（')[0] : '系统'
  }

  /** 笔记总览：按需生成内容快照开弹窗（书架 v2.0 §三） */
  const openOverview = async (): Promise<void> => {
    if (!reading) return
    try {
      setOverview(await window.api.books.notesOverviewMd(reading.id))
    } catch {
      toast('生成失败')
    }
  }

  /** 导出读书笔记（主进程对话框 + 写盘；取消静默） */
  const doExportNotes = async (): Promise<void> => {
    if (!reading) return
    try {
      const saved = await window.api.books.exportNotes(reading.id)
      if (saved) toast(`已导出到 ${saved}`)
    } catch {
      toast('导出失败')
    }
  }

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
    // 阅读区容器背景（260911 阅读背景设计 §七）：color=纯色 / image=底图（cover 居中）；
    // theme=undefined 走 CSS 默认（--color-surface-strong）。epub/pdf 共用（pdf 页面白底 canvas 不受影响）
    const readerBodyStyle =
      readingBg.kind === 'color' && readingBg.color
        ? { background: readingBg.color }
        : readingBg.kind === 'image' && readerBgImage
          ? {
              backgroundImage: `url(bzres://bg/${readerBgImage})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat'
            }
          : undefined
    return (
      <div ref={readerPageRef} className={`module-page bk-reader-page${reading.format === 'epub' ? ' bk-reader-wide' : ''}`}>
        <div className="bk-reader-bar">
          <button
            className="btn"
            onClick={() => {
              setReading(null)
              void load() // 回书架刷新进度角标
              void refreshStats() // 与统计（书架 v2.0 §五）
            }}
          >
            <span className="material-symbols-outlined">arrow_back</span>藏书架
          </button>
          <div className="bk-reader-title" title={reading.title}>
            {reading.title}
          </div>
          <div className="bk-reader-progress">{readerLabel}</div>
          {reading.format === 'epub' && (
            <>
              <button
                className="btn bk-bar-btn bk-font-btn"
                onClick={() => stepFont(-0.05)}
                title="减小字号（每书独立记忆）"
              >
                A-
              </button>
              <span className="bk-font-scale">{Math.round((reading.font_scale ?? 1) * 100)}%</span>
              <button
                className="btn bk-bar-btn bk-font-btn"
                onClick={() => stepFont(0.05)}
                title="增大字号（每书独立记忆）"
              >
                A+
              </button>
              {reading.font_scale != null && (
                <button
                  className="btn bk-bar-btn"
                  onClick={resetFont}
                  title="清除书级字号，回落个人档全局字体"
                >
                  默认
                </button>
              )}
              <button
                className="btn bk-bar-btn"
                onClick={(e) => setFontAnchor(e.currentTarget)}
                title="字体（每书独立记忆）"
              >
                <span className="material-symbols-outlined">font_download</span>
              </button>
            </>
          )}
          <button
            className="btn bk-bar-btn"
            onClick={(e) => setBgAnchor(e.currentTarget)}
            title="阅读背景（全局，所有书共用）"
          >
            <span className="material-symbols-outlined">palette</span>
          </button>
          <button className="btn bk-bar-btn" onClick={addBookmark} title="收藏当前位置为书签">
            <span className="material-symbols-outlined">bookmark_add</span>
          </button>
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
        {fontAnchor && (
          <ActionMenu
            anchorEl={fontAnchor}
            onClose={() => setFontAnchor(null)}
            items={[
              {
                key: 'follow',
                icon: reading.font_family == null ? 'check' : undefined,
                label: `跟随全局（${globalFontName()}）`,
                onClick: () => setBookFont(null)
              },
              ...READER_FONTS.map((f) => ({
                key: f.family,
                icon: reading.font_family === f.value ? 'check' : undefined,
                label: f.label,
                style: { fontFamily: f.value },
                separatorAbove: f.family === 'Liyu Shoushu',
                onClick: () => setBookFont(f.value)
              }))
            ]}
          />
        )}
        {bgAnchor && (
          <ActionMenu
            anchorEl={bgAnchor}
            onClose={() => setBgAnchor(null)}
            items={[
              {
                key: 'theme',
                icon: readingBg.kind === 'theme' ? 'check' : undefined,
                label: '跟随主题',
                onClick: () => applyReadingBg({ kind: 'theme' })
              },
              ...READER_BG_PRESETS.map((p) => ({
                key: p.id,
                icon: readingBg.kind === 'color' && readingBg.color === p.color ? 'check_circle' : 'circle',
                iconStyle: { color: p.color },
                label: p.label,
                onClick: () => applyReadingBg({ kind: 'color', color: p.color, textColor: p.textColor })
              })),
              {
                key: 'upload',
                icon: 'upload',
                label: '上传自定义图片…',
                separatorAbove: true,
                onClick: () => void uploadReaderBg()
              },
              ...(readerBgImage
                ? [
                    {
                      key: 'use-image',
                      icon: readingBg.kind === 'image' ? 'check_circle' : 'circle',
                      label: '自定义图片',
                      onClick: () => applyReadingBg({ kind: 'image', textColor: readingBg.textColor ?? 'dark' })
                    },
                    {
                      key: 'clear-image',
                      icon: 'delete',
                      label: '清除自定义图片',
                      onClick: clearReaderBgImage
                    }
                  ]
                : [])
            ]}
          />
        )}
        <div className={`bk-reader-flex${side.open ? ' with-side' : ''}`}>
          {side.open && (
            <ReaderSidebar
              tab={side.tab}
              onTabChange={(t) => setSide((s) => ({ ...s, tab: t }))}
              toc={toc}
              locate={locate}
              notes={reading.format === 'epub' ? notes : null}
              marks={marks}
              onJumpToc={jumpToc}
              onJumpNote={jumpNote}
              onDeleteNote={(n) => setConfirmNote(n)}
              onJumpMark={jumpMark}
              onDeleteMark={(m) => setConfirmMark(m)}
              onUpdateMark={updateMark}
              onOverview={reading.format === 'epub' ? () => void openOverview() : undefined}
              onCollapse={() => setSide((s) => ({ ...s, open: false }))}
            />
          )}
          <div className="bk-reader-body" style={readerBodyStyle}>
            {reading.format === 'epub' ? (
              <EpubReader
                key={`${reading.id}-${mode}`}
                ref={epubRef}
                book={reading}
                theme={theme}
                mode={mode}
                notes={notes ?? []}
                fontScale={reading.font_scale}
                fontFamily={reading.font_family}
                bg={readingBg}
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

        {/* 删除书签：二次确认（彻底删除不入回收站；书架 v2.0 §二） */}
        <ConfirmDialog
          open={!!confirmMark}
          title="删除书签"
          danger
          confirmText="彻底删除"
          onCancel={() => setConfirmMark(null)}
          onConfirm={() => void doDeleteMark()}
        >
          将删除书签「{confirmMark?.label}」，不可恢复。
        </ConfirmDialog>

        {/* 笔记总览：按需生成内容直传（readOnly），导出走主进程保存对话框（书架 v2.0 §三） */}
        {overview != null && (
          <MdDialog
            open
            title={`《${reading.title}》读书笔记`}
            subtitle={`${reading.author || '佚名'} · ${notes?.length ?? 0} 条 · 生成于 ${fmtNow()}`}
            content={overview}
            readOnly
            headerAction={{ label: '导出', icon: 'download', onClick: () => void doExportNotes() }}
            onClose={() => setOverview(null)}
          />
        )}
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

      {/* 阅读统计条 + 展开面板（三项全零整行隐藏；书架 v2.0 §五） */}
      {stats != null && (stats.todaySeconds > 0 || stats.streakDays > 0 || stats.readingCount > 0) && (
        <div className="bk-stats-bar" onClick={() => setStatsOpen((v) => !v)} title="点击展开 / 收起阅读统计">
          <span className="material-symbols-outlined">schedule</span>
          今日 {fmtMinutes(stats.todaySeconds)} · 连续 {stats.streakDays} 天 · 在读 {stats.readingCount} 本
          <span className="material-symbols-outlined bk-stats-caret">
            {statsOpen ? 'expand_less' : 'expand_more'}
          </span>
        </div>
      )}
      {statsOpen && stats != null && (
        <div className="bk-stats-panel">
          {stats.rows.length === 0 ? (
            <div className="bk-stats-row">
              <span className="bk-stats-title">还没有阅读记录</span>
            </div>
          ) : (
            stats.rows.map((r) => (
              <div key={r.id} className="bk-stats-row">
                <span className="bk-stats-title" title={r.title}>
                  {r.title}
                </span>
                <span className="bk-stats-nums">
                  {fmtMinutes(r.totalSeconds)} · {Math.round(r.percent)}%
                  {r.last_read_at ? ` · ${relTime(r.last_read_at)}` : ''}
                </span>
              </div>
            ))
          )}
          <div className="bk-stats-total">
            合计 {fmtMinutes(stats.rows.reduce((s, r) => s + r.totalSeconds, 0))}
          </div>
        </div>
      )}

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
