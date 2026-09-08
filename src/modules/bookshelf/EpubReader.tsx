// epub 阅读器（书架 specs §3.2）：scrolled 流式渲染 + 主题注入 + CFI 进度恢复/节流落库
import { useEffect, useRef } from 'react'
import ePub from 'epubjs'
import type { Book, Rendition } from 'epubjs'
import type { BooksRecord, Theme } from '../../shared/types'

interface Props {
  book: BooksRecord
  theme: Theme
  /** 进度文案上报（阅读条右侧显示，如「42%」） */
  onProgress: (label: string) => void
}

/** 主题注入：iframe 内用不了外层 CSS 变量，取具体色值写入 rendition（主题切换时重注入） */
function applyTheme(rendition: Rendition | null): void {
  if (!rendition) return
  const cs = getComputedStyle(document.documentElement)
  const body = getComputedStyle(document.body)
  rendition.themes.default({
    body: {
      color: cs.getPropertyValue('--color-text').trim() || '#1f1f1f',
      background: cs.getPropertyValue('--color-surface-strong').trim() || '#fff',
      'font-family': body.fontFamily,
      'font-size': body.fontSize,
      'font-weight': body.fontWeight,
      'line-height': '1.9'
    },
    p: { margin: '0.5em 0' }
  })
}

export default function EpubReader(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const bookRef = useRef<Book | null>(null)
  /** 最新进度（卸载 flush 用） */
  const pendingRef = useRef<{ cfi: string | null; percent: number } | null>(null)
  const lastSaveRef = useRef(0)
  const spineIdxRef = useRef(0)

  const saveNow = (): void => {
    const p = pendingRef.current
    if (p) void window.api.books.saveProgress(props.book.id, {
      cfi: p.cfi,
      percent: Math.round(p.percent * 10000) / 100
    })
  }

  // 打开书籍（book.id 变化即换书）
  useEffect(() => {
    let destroyed = false
    const run = async (): Promise<void> => {
      const data = await window.api.books.readFile(props.book.id)
      if (destroyed || !hostRef.current) return
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      const bk = ePub(ab)
      const rendition = bk.renderTo(hostRef.current, {
        width: '100%',
        height: '100%',
        flow: 'scrolled',
        allowScriptedContent: false
      })
      bookRef.current = bk
      renditionRef.current = rendition
      applyTheme(rendition)
      await rendition.display(props.book.progress_cfi ?? undefined)
      // locations 异步生成（大书较慢）；就绪前 relocated 的 percentage 走 epub.js 内置近似
      void bk.locations.generate(800).catch(() => undefined)
      rendition.on('relocated', (loc: unknown) => {
        const l = loc as { start?: { cfi?: string; index?: number; percentage?: number } }
        const cfi = l.start?.cfi ?? null
        if (typeof l.start?.index === 'number') spineIdxRef.current = l.start.index
        const bk2 = bookRef.current
        let percent = l.start?.percentage ?? 0
        if (bk2?.locations?.length() && cfi) percent = bk2.locations.percentageFromCfi(cfi) ?? percent
        pendingRef.current = { cfi, percent }
        props.onProgress(`${Math.round(percent * 100)}%`)
        const now = Date.now()
        if (now - lastSaveRef.current >= 3000) {
          lastSaveRef.current = now
          saveNow()
        }
      })
    }
    void run()
    return () => {
      destroyed = true
      saveNow() // 退出阅读 flush（specs：节流 3 秒 + 退出落库）
      try {
        renditionRef.current?.destroy()
      } catch {
        /* 已销毁 */
      }
      try {
        bookRef.current?.destroy()
      } catch {
        /* 已销毁 */
      }
      renditionRef.current = null
      bookRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.book.id])

  // 主题切换重注入（不重载书）
  useEffect(() => {
    applyTheme(renditionRef.current)
  }, [props.theme])

  /** 章节级跳转兜底（book.spine 上下章） */
  const goChapter = (delta: number): void => {
    const bk = bookRef.current
    if (!bk) return
    const target = bk.spine.get(spineIdxRef.current + delta)
    if (target?.href) void renditionRef.current?.display(target.href)
  }

  return (
    <>
      <div ref={hostRef} className="bk-epub-host" />
      <button className="bk-nav-btn bk-nav-up" title="上一章" onClick={() => goChapter(-1)}>
        <span className="material-symbols-outlined">arrow_upward</span>
      </button>
      <button className="bk-nav-btn bk-nav-down" title="下一章" onClick={() => goChapter(1)}>
        <span className="material-symbols-outlined">arrow_downward</span>
      </button>
    </>
  )
}
