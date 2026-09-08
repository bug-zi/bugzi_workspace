// pdf 阅读器（书架 specs §3.3）：连续滚动 + IntersectionObserver 懒渲染 + 页码进度恢复/节流落库
import { useEffect, useRef } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { BooksRecord } from '../../shared/types'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

interface Props {
  book: BooksRecord
  /** 进度文案上报（阅读条右侧显示，如「12 / 240」） */
  onProgress: (label: string) => void
}

/** 渲染单页（可见时才执行；dpr 缩放保清晰） */
async function renderPage(pdf: PDFDocumentProxy, n: number, canvas: HTMLCanvasElement): Promise<void> {
  const page = await pdf.getPage(n)
  const base = page.getViewport({ scale: 1 })
  const width = canvas.parentElement?.clientWidth ?? base.width
  const dpr = window.devicePixelRatio || 1
  const vp = page.getViewport({ scale: (width / base.width) * dpr })
  canvas.width = vp.width
  canvas.height = vp.height
  canvas.style.width = '100%'
  // pdfjs v6 起 render 直接收 canvas（canvasContext 为兼容保留）
  await page.render({ canvas, viewport: vp }).promise
}

export default function PdfReader(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  /** 最新页码（卸载 flush 用） */
  const pendingRef = useRef<{ page: number; total: number } | null>(null)
  const lastSaveRef = useRef(0)

  const saveNow = (): void => {
    const p = pendingRef.current
    if (p) void window.api.books.saveProgress(props.book.id, {
      page: p.page,
      percent: Math.round((p.page / p.total) * 10000) / 100
    })
  }

  useEffect(() => {
    let destroyed = false
    const run = async (): Promise<void> => {
      const data = await window.api.books.readFile(props.book.id)
      if (destroyed || !hostRef.current) return
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      const pdf = await pdfjsLib.getDocument({ data: ab }).promise
      if (destroyed || !hostRef.current) return
      const container = hostRef.current
      const total = pdf.numPages

      // 全页占位（按第 1 页比例定高），可见时懒渲染
      const firstVp = (await pdf.getPage(1)).getViewport({ scale: 1 })
      for (let n = 1; n <= total; n++) {
        const wrap = document.createElement('div')
        wrap.className = 'pdf-page-wrap'
        wrap.dataset.page = String(n)
        wrap.style.aspectRatio = `${firstVp.width} / ${firstVp.height}`
        wrap.appendChild(document.createElement('canvas'))
        container.appendChild(wrap)
      }
      const io = new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue
            io.unobserve(en.target)
            const wrap = en.target as HTMLDivElement
            void renderPage(pdf, Number(wrap.dataset.page), wrap.querySelector('canvas')!).catch(() => undefined)
          }
        },
        { root: container, rootMargin: '150% 0px' }
      )
      container.querySelectorAll('.pdf-page-wrap').forEach((el) => io.observe(el))

      // 恢复到上次页码（1 基）
      const target = Math.min(Math.max(props.book.progress_page ?? 1, 1), total)
      const targetEl = container.children[target - 1] as HTMLElement | undefined
      if (targetEl) targetEl.scrollIntoView({ block: 'start' })
      pendingRef.current = { page: target, total }
      props.onProgress(`${target} / ${total}`)

      // 滚动跟踪当前页（offsetTop 判定 + 节流落库）
      container.addEventListener('scroll', () => {
        const line = container.scrollTop + container.clientHeight * 0.35
        let cur = 1
        for (let i = 0; i < container.children.length; i++) {
          const el = container.children[i] as HTMLElement
          if (el.offsetTop <= line) cur = i + 1
          else break
        }
        pendingRef.current = { page: cur, total }
        props.onProgress(`${cur} / ${total}`)
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
      saveNow() // 退出阅读 flush
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.book.id])

  return <div ref={hostRef} className="bk-pdf-scroll" />
}
