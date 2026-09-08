// pdf 阅读器（书架 specs §3.3 + 优化第1轮 §8.2-8.4）：
// 滚动 = 连续滚动懒渲染（原状）；翻页 = 单页居中（离屏渲染 + ±1 缓存防闪白）；目录 getOutline；WASD/方向键
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { BooksRecord } from '../../shared/types'
import { parseReaderKey, dirOfKey, createHoldScroller, type ReadingMode } from './readerKeys'
import type { ReaderLocate, ReaderTocItem } from './ReaderSidebar'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfReaderHandle {
  jumpToPage: (n: number) => void
}

interface Props {
  book: BooksRecord
  mode: ReadingMode
  /** 进度文案上报（阅读条右侧显示，如「12 / 240」） */
  onProgress: (label: string) => void
  /** 目录上报（outline → 页码树；解析失败/无目录上报空数组） */
  onToc: (items: ReaderTocItem[]) => void
  /** 当前页上报（目录区间判定用） */
  onLocate: (l: ReaderLocate) => void
}

/** pdfjs outline 项（getOutline 返回结构） */
interface PdfOutlineItem {
  title?: string
  dest?: unknown
  items?: PdfOutlineItem[]
}

/** 书签 dest → 页码（1 基；string 走 getDestination 再取 ref） */
async function destToPage(pdf: PDFDocumentProxy, dest: unknown): Promise<number | undefined> {
  try {
    let explicit = dest
    if (typeof dest === 'string') explicit = await pdf.getDestination(dest)
    if (!Array.isArray(explicit) || explicit.length === 0) return undefined
    const idx = await pdf.getPageIndex(explicit[0] as never)
    return idx + 1
  } catch {
    return undefined
  }
}

/** outline 递归 → 侧栏目录树 */
async function outlineToToc(pdf: PDFDocumentProxy, items: PdfOutlineItem[] | undefined, depth = 0): Promise<ReaderTocItem[]> {
  if (!items || depth > 4) return []
  const out: ReaderTocItem[] = []
  for (const it of items) {
    const page = it.dest != null ? await destToPage(pdf, it.dest) : undefined
    const children = await outlineToToc(pdf, it.items, depth + 1)
    out.push({ label: (it.title ?? '').trim(), page, children })
  }
  return out.filter((o) => o.label || (o.children?.length ?? 0) > 0)
}

/** 渲染单页到指定宽度（懒渲染/单页模式共用；dpr 缩放保清晰） */
async function renderPage(pdf: PDFDocumentProxy, n: number, canvas: HTMLCanvasElement, widthPx: number): Promise<void> {
  const page = await pdf.getPage(n)
  const base = page.getViewport({ scale: 1 })
  const dpr = window.devicePixelRatio || 1
  const vp = page.getViewport({ scale: (widthPx / base.width) * dpr })
  canvas.width = vp.width
  canvas.height = vp.height
  canvas.style.width = '100%'
  // pdfjs v6 起 render 直接收 canvas（canvasContext 为兼容保留）
  await page.render({ canvas, viewport: vp }).promise
}

const PdfReader = forwardRef<PdfReaderHandle, Props>(function PdfReader(props, ref) {
  const { book, mode } = props
  const hostRef = useRef<HTMLDivElement>(null)
  /** 文档代理（book.id 变化重载；两种模式共用） */
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  /** 最新页码（卸载 flush 用；两模式共享，切模式不丢位置；初始 = 上次进度页） */
  const pendingRef = useRef<{ page: number; total: number } | null>(null)
  const lastSaveRef = useRef(0)
  /** 当前页（模式切换衔接；key 挂载时取 progress_page） */
  const curPageRef = useRef(Math.min(Math.max(book.progress_page ?? 1, 1), Number.MAX_SAFE_INTEGER))
  /** outline 顶层序列（W/S 换节；无目录为空数组） */
  const sectionsRef = useRef<ReaderTocItem[]>([])
  /** 单页模式：离屏渲染缓存（page → canvas，仅保留当前 ±1） */
  const pageCacheRef = useRef<Map<number, HTMLCanvasElement>>(new Map())
  /** 视图重建信号（文档就绪后触发视图 effect；模式切换由 mode dep 覆盖） */
  const [viewTick, setViewTick] = useState(0)

  const saveNow = (): void => {
    const p = pendingRef.current
    if (p) void window.api.books.saveProgress(book.id, {
      page: p.page,
      percent: Math.round((p.page / p.total) * 10000) / 100
    })
  }

  const reportPage = (page: number, total: number): void => {
    curPageRef.current = page
    pendingRef.current = { page, total }
    props.onProgress(`${page} / ${total}`)
    props.onLocate({ page })
    const now = Date.now()
    if (now - lastSaveRef.current >= 3000) {
      lastSaveRef.current = now
      saveNow()
    }
  }

  /** W/S 换节：outline 顶层序列中前后跳（无目录不响应；滚动模式 A/D 同用） */
  const jumpSection = (delta: number): void => {
    const sections = sectionsRef.current
    if (sections.length === 0) return
    const cur = curPageRef.current
    if (delta < 0) {
      // 上一节：最后一个 page < 当前的顶层项；已在首节内则回第 1 页
      let target = sections[0]
      for (const s of sections) {
        if (s.page != null && s.page < cur) target = s
        else break
      }
      goToPage(target.page ?? 1)
    } else {
      const next = sections.find((s) => s.page != null && s.page > cur)
      if (next?.page != null) goToPage(next.page)
    }
  }

  /** 页码跳转（侧栏目录/键盘/模式内翻页统一入口；页码 clamp） */
  const goToPage = (n: number): void => {
    const pdf = pdfRef.current
    const host = hostRef.current
    if (!pdf || !host) return
    const total = pdf.numPages
    const page = Math.min(Math.max(1, Math.round(n)), total)
    if (mode === 'page') {
      void showPage(pdf, host, page, total)
    } else {
      const el = host.querySelector(`.pdf-page-wrap[data-page="${page}"]`) as HTMLElement | null
      if (el) {
        el.scrollIntoView({ block: 'start' })
        reportPage(page, total)
      }
    }
  }

  /** 单页模式渲染：缓存命中直接 blit，未命中离屏渲染后挂载；顺带预取相邻页 */
  const showPage = async (pdf: PDFDocumentProxy, host: HTMLElement, page: number, total: number): Promise<void> => {
    const holder = host.querySelector('.bk-pdf-single') as HTMLElement | null
    if (!holder) return
    reportPage(page, total)
    const width = holder.clientWidth || 800
    let canvas = pageCacheRef.current.get(page)
    if (!canvas) {
      canvas = document.createElement('canvas')
      await renderPage(pdf, page, canvas, width)
      // 单页视图按视口自适应（长页缩到可见高度内，不被裁剪）
      canvas.style.width = 'auto'
      canvas.style.height = 'auto'
      canvas.style.maxWidth = '100%'
      canvas.style.maxHeight = '100%'
      pageCacheRef.current.set(page, canvas)
    }
    if (curPageRef.current !== page) return // 等待渲染期间已翻走
    holder.replaceChildren(canvas)
    // 预取相邻页（防翻页闪白）；淘汰窗口外缓存
    for (const p of [page - 1, page + 1]) {
      if (p >= 1 && p <= total && !pageCacheRef.current.has(p)) {
        const pre = document.createElement('canvas')
        void renderPage(pdf, p, pre, width)
          .then(() => pageCacheRef.current.set(p, pre))
          .catch(() => undefined)
      }
    }
    for (const key of pageCacheRef.current.keys()) {
      if (Math.abs(key - page) > 1) pageCacheRef.current.delete(key)
    }
  }

  // 文档加载 + 目录上报（book.id 变化重载）
  useEffect(() => {
    let destroyed = false
    pdfRef.current = null
    sectionsRef.current = []
    pageCacheRef.current.clear()
    const run = async (): Promise<void> => {
      const data = await window.api.books.readFile(book.id)
      if (destroyed || !hostRef.current) return
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      const pdf = await pdfjsLib.getDocument({ data: ab }).promise
      if (destroyed) return
      pdfRef.current = pdf
      // 目录（加密/无 outline 报空，不阻断阅读）
      try {
        const toc = await outlineToToc(pdf, (await pdf.getOutline()) ?? undefined)
        if (!destroyed) {
          sectionsRef.current = toc
          props.onToc(toc)
        }
      } catch {
        if (!destroyed) props.onToc([])
      }
      // 视图构建交给 [book.id, mode, viewTick] effect
      if (!destroyed) setViewTick((t) => t + 1)
    }
    void run()
    return () => {
      destroyed = true
      saveNow() // 退出阅读 flush
      pdfRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id])

  // 视图构建：滚动 = 连续占位懒渲染；翻页 = 单页居中（mode 切换重建，curPage 衔接）
  useEffect(() => {
    const pdf = pdfRef.current
    const container = hostRef.current
    if (!pdf || !container) return
    let destroyed = false
    let onScroll: (() => void) | null = null
    let io: IntersectionObserver | null = null
    const total = pdf.numPages
    container.textContent = ''

    if (mode === 'page') {
      const holder = document.createElement('div')
      holder.className = 'bk-pdf-single'
      container.appendChild(holder)
      void showPage(pdf, container, Math.min(Math.max(curPageRef.current, 1), total), total).catch(() => undefined)
    } else {
      // 连续滚动视图：全页占位（按第 1 页比例定高），可见时懒渲染
      void (async (): Promise<void> => {
        const firstVp = (await pdf.getPage(1)).getViewport({ scale: 1 })
        if (destroyed) return
        for (let n = 1; n <= total; n++) {
          const wrap = document.createElement('div')
          wrap.className = 'pdf-page-wrap'
          wrap.dataset.page = String(n)
          wrap.style.aspectRatio = `${firstVp.width} / ${firstVp.height}`
          wrap.appendChild(document.createElement('canvas'))
          container.appendChild(wrap)
        }
        const io2 = new IntersectionObserver(
          (entries) => {
            for (const en of entries) {
              if (!en.isIntersecting) continue
              io2.unobserve(en.target)
              const wrap = en.target as HTMLDivElement
              const width = wrap.clientWidth || 800
              void renderPage(pdf, Number(wrap.dataset.page), wrap.querySelector('canvas')!, width).catch(() => undefined)
            }
          },
          { root: container, rootMargin: '150% 0px' }
        )
        io = io2
        container.querySelectorAll('.pdf-page-wrap').forEach((el) => io2.observe(el))

        // 恢复到当前页（1 基）
        const target = Math.min(Math.max(curPageRef.current, 1), total)
        const targetEl = container.children[target - 1] as HTMLElement | undefined
        if (targetEl) targetEl.scrollIntoView({ block: 'start' })
        reportPage(target, total)

        // 滚动跟踪当前页（offsetTop 判定 + 节流落库）
        onScroll = (): void => {
          const line = container.scrollTop + container.clientHeight * 0.35
          let cur = 1
          for (let i = 0; i < container.children.length; i++) {
            const el = container.children[i] as HTMLElement
            if (el.dataset.page == null) continue
            if (el.offsetTop <= line) cur = Number(el.dataset.page)
            else break
          }
          if (cur !== curPageRef.current) reportPage(cur, total)
        }
        container.addEventListener('scroll', onScroll)
      })()
    }
    return () => {
      destroyed = true
      io?.disconnect()
      if (onScroll) container.removeEventListener('scroll', onScroll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, mode, viewTick])

  // 键盘（§8.2 修订：W/S 按住流式滚动）：滚动 = 上下流式/左右换节；翻页 = 左右翻页/上下换节
  useEffect(() => {
    const hold = createHoldScroller()
    const onKey = (e: KeyboardEvent): void => {
      const dir = parseReaderKey(e)
      if (!dir || !hostRef.current || !pdfRef.current) return
      e.preventDefault()
      const host = hostRef.current
      if (mode === 'scroll') {
        if (dir === 'up' || dir === 'down') {
          if (!e.repeat) hold.press(dir === 'up' ? -1 : 1, host)
        } else {
          jumpSection(dir === 'left' ? -1 : 1)
        }
      } else {
        if (dir === 'left') goToPage(curPageRef.current - 1)
        else if (dir === 'right') goToPage(curPageRef.current + 1)
        else jumpSection(dir === 'up' ? -1 : 1)
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      // 不走输入保护：焦点移入输入框后松键也必须停掉按住的滚动
      const dir = dirOfKey(e)
      if (dir === 'up') hold.release(-1)
      else if (dir === 'down') hold.release(1)
    }
    const onBlur = (): void => hold.stop()
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      hold.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  useImperativeHandle(ref, () => ({
    jumpToPage: (n: number) => goToPage(n)
  }))

  return <div ref={hostRef} className={mode === 'page' ? 'bk-pdf-host bk-pdf-page-mode' : 'bk-pdf-host'} />
})

export default PdfReader
