// epub 阅读器（书架 specs §3.2 + 优化第1轮 §8.1-8.6）：
// 双模式（模式切换销毁重建 rendition——运行时 flow() 切换实测排版错乱，开发者反馈 260908）
// + WASD/方向键 + 目录上报 + 划词高光/批注 + 主题色标注 + 容器尺寸变化重排（侧栏开合/窗口缩放）
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import ePub from 'epubjs'
import type { Book, Contents, NavItem, Rendition } from 'epubjs'
import type { BooksNote, BooksRecord, Theme } from '../../shared/types'
import { parseReaderKey, dirOfKey, createHoldScroller, type ReadingMode } from './readerKeys'
import type { ReaderLocate, ReaderTocItem } from './ReaderSidebar'

export interface EpubReaderHandle {
  /** 跳到 CFI（笔记页签回跳） */
  jumpToCfi: (cfi: string) => void
  /** 跳到目录章节 */
  jumpToToc: (href: string) => void
  /** 当前位置（加书签用：CFI + 百分比；书架 v2.0 §二） */
  getCurrent: () => { cfi: string | null; percent: number }
}

interface Props {
  book: BooksRecord
  theme: Theme
  mode: ReadingMode
  /** 该书全部笔记（模块持有，增删改后引用变化触发标注 diff） */
  notes: BooksNote[]
  /** 进度文案上报（阅读条右侧显示，如「42%」） */
  onProgress: (label: string) => void
  /** 目录上报（book.loaded.navigation 就绪后一次） */
  onToc: (items: ReaderTocItem[]) => void
  /** 当前章节上报（目录 active 高亮用） */
  onLocate: (l: ReaderLocate) => void
  /** 新增笔记（模块走 IPC + setNotes） */
  onAddNote: (n: { cfiRange: string; quote: string; note: string }) => void
  /** 编辑批注 */
  onUpdateNote: (id: number, note: string) => void
  /** 删除笔记（模块二次确认后执行） */
  onRemoveNote: (id: number) => void
  /** 书级字号倍率（null=跟随全局字体；书架 v2.0 §四） */
  fontScale: number | null
}

/** NavItem → 侧栏目录树（subitems 递归，深于 4 层剪枝） */
function convertToc(items: NavItem[] | undefined, depth = 0): ReaderTocItem[] {
  if (!items || depth > 4) return []
  return items
    .map((it) => ({
      label: (it.label ?? '').trim(),
      href: it.href,
      children: convertToc(it.subitems, depth + 1)
    }))
    .filter((it) => it.label || it.children.length > 0)
}

/** 主题注入：iframe 内用不了外层 CSS 变量，取具体色值写入 rendition（主题切换时重注入）。
 *  优化第1轮 §8.1/§8.6：护栏防横向溢出 + ::selection 主题色。
 *  （分页模式的内部滚动由 epub.js 自管——contents.columns 设 overflow-y hidden，无需注入） */
function applyTheme(rendition: Rendition | null, fontScale: number | null): void {
  if (!rendition) return
  const cs = getComputedStyle(document.documentElement)
  const body = getComputedStyle(document.body)
  const basePx = parseFloat(body.fontSize) || 16
  rendition.themes.default({
    body: {
      color: cs.getPropertyValue('--color-text').trim() || '#1f1f1f',
      background: cs.getPropertyValue('--color-surface-strong').trim() || '#fff',
      'font-family': body.fontFamily,
      'font-size': fontScale != null ? `${Math.round(basePx * fontScale * 100) / 100}px` : body.fontSize,
      'font-weight': body.fontWeight,
      'line-height': '1.9'
    },
    p: { margin: '0.5em 0' },
    // 宽媒体元素收缩到版心（横向拖拽根因修复）
    'img, svg, video, table': { 'max-width': '100%', height: 'auto' },
    // 代码块横向溢出块内消化
    pre: { 'overflow-x': 'auto' },
    // 划词高光主题色（与全局 --color-selection 同源）
    '::selection': {
      background: cs.getPropertyValue('--color-selection').trim() || 'rgba(232, 160, 191, 0.45)'
    }
  })
}

/** 主题具体色值（标注 fill/stroke 用；浅色樱花粉系 / 深色宝蓝系） */
function themeMarkColors(): { fill: string; stroke: string } {
  const cs = getComputedStyle(document.documentElement)
  return {
    fill: cs.getPropertyValue('--color-selection').trim() || 'rgba(232, 160, 191, 0.45)',
    stroke: cs.getPropertyValue('--color-primary-deep').trim() || '#d17fa5'
  }
}

/** 选区矩形 → host 内绝对坐标（iframe 偏移 + 滚动量换算） */
function rectInHost(host: HTMLElement, contents: Contents, rangeRect: DOMRect): { left: number; top: number } {
  const hostRect = host.getBoundingClientRect()
  const frame = contents.document.defaultView?.frameElement
  const f = frame?.getBoundingClientRect()
  const offX = (f ? f.left - hostRect.left : 0) + host.scrollLeft
  const offY = (f ? f.top - hostRect.top : 0) + host.scrollTop
  return { left: offX + rangeRect.left, top: offY + rangeRect.top }
}

/** marks-pane 代理事件的 clientX/Y 为 iframe 内坐标系 → 换算 host 内绝对坐标 */
function proxiedPointInHost(host: HTMLElement, ev: MouseEvent): { left: number; top: number } {
  const hostRect = host.getBoundingClientRect()
  const frame = host.querySelector('iframe')
  const f = frame?.getBoundingClientRect()
  const offX = (f ? f.left - hostRect.left : 0) + host.scrollLeft
  const offY = (f ? f.top - hostRect.top : 0) + host.scrollTop
  return { left: offX + ev.clientX, top: offY + ev.clientY }
}

/** scrolled 流式的真实滚动容器（epub.js 给内层 .epub-container 设 overflow:auto） */
function scrollerOf(host: HTMLElement): HTMLElement {
  return (host.querySelector('.epub-container') as HTMLElement | null) ?? host
}

/** host 内容盒净尺寸（clientWidth/Height 含 padding，须扣除） */
function contentBoxSize(host: HTMLElement): { w: number; h: number } {
  const cs = getComputedStyle(host)
  const w = host.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
  const h = host.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0)
  return { w, h }
}

const EpubReader = forwardRef<EpubReaderHandle, Props>(function EpubReader(props, ref) {
  const { book, theme, mode, notes, fontScale } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const bookRef = useRef<Book | null>(null)
  /** 最新进度（卸载 flush 用） */
  const pendingRef = useRef<{ cfi: string | null; percent: number } | null>(null)
  const lastSaveRef = useRef(0)
  const spineIdxRef = useRef(0)
  const curCfiRef = useRef<string | null>(null)
  const notesRef = useRef<BooksNote[]>([])
  notesRef.current = notes
  /** 已渲染标注：cfi → 是否带下划线（diff 增删） */
  const renderedRef = useRef<Map<string, boolean>>(new Map())
  /** 标注配色主题代（变化 → 全量重涂） */
  const markColorKeyRef = useRef('')
  /** 活动气泡元素（新气泡顶掉旧气泡） */
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  /** 最近一次点标注的 host 坐标（气泡定位锚） */
  const lastMarkPointRef = useRef({ left: 40, top: 40 })

  const saveNow = (): void => {
    const p = pendingRef.current
    if (p) void window.api.books.saveProgress(book.id, {
      cfi: p.cfi,
      percent: Math.round(p.percent * 10000) / 100
    })
  }

  /** 气泡：清掉旧的，挂新的到 host 内（随滚动） */
  const openBubble = (left: number, top: number): HTMLDivElement | null => {
    bubbleRef.current?.remove()
    const host = hostRef.current
    if (!host) return null
    const b = document.createElement('div')
    b.className = 'bk-sel-bubble'
    b.style.left = `${Math.max(8, Math.min(left, host.clientWidth - 200))}px`
    b.style.top = `${Math.max(8, top)}px`
    host.appendChild(b)
    bubbleRef.current = b
    return b
  }
  const closeBubble = (): void => {
    bubbleRef.current?.remove()
    bubbleRef.current = null
  }

  /** 气泡内小按钮/动作按钮（stopPropagation 防宿主 mousedown 收气泡） */
  const mkBtn = (label: string, onClick: () => void): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.textContent = label
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      onClick()
    })
    return btn
  }

  /** 批注输入态（划词气泡与标注气泡共用）：textarea + 保存/取消 */
  const mountNoteEditor = (b: HTMLDivElement, initial: string, onSave: (text: string) => void): void => {
    b.textContent = ''
    const ta = document.createElement('textarea')
    ta.className = 'bk-sel-input'
    ta.value = initial
    ta.placeholder = '写下批注…'
    const row = document.createElement('div')
    row.className = 'bk-sel-row'
    row.append(
      mkBtn('保存', () => onSave(ta.value.trim())),
      mkBtn('取消', closeBubble)
    )
    b.append(ta, row)
    ta.focus()
  }

  /** 点击已渲染标注 → 批注气泡（原文下方：内容 + 编辑/删除） */
  const markClickBubble = (cfi: string): void => {
    const host = hostRef.current
    if (!host) return
    const note = notesRef.current.find((n) => n.cfi_range === cfi)
    if (!note) return
    const b = openBubble(lastMarkPointRef.current.left, lastMarkPointRef.current.top + 14)
    if (!b) return
    if (note.note) {
      const t = document.createElement('div')
      t.className = 'bk-mark-note'
      t.textContent = note.note
      b.appendChild(t)
    }
    const row = document.createElement('div')
    row.className = 'bk-sel-row'
    if (note.note) {
      row.append(
        mkBtn('编辑', () => mountNoteEditor(b, note.note, (text) => {
          props.onUpdateNote(note.id, text)
          closeBubble()
        }))
      )
    }
    row.append(mkBtn('删除', () => props.onRemoveNote(note.id)))
    b.appendChild(row)
  }

  /** 标注 diff 渲染（rendition 就绪/notes/theme 变化时调用）：
   *  色值变 → 全量重涂；否则 diff 增删。修复（260908 开发者反馈）：book 异步加载与
   *  notes 到达存在竞态，effect 单靠 [notes] 触发会整轮跳过 → 标注不渲染。 */
  const syncAnnotations = (): void => {
    const rendition = renditionRef.current
    if (!rendition) return
    const colors = themeMarkColors()
    const colorKey = JSON.stringify(colors)
    const repaint = markColorKeyRef.current !== colorKey
    markColorKeyRef.current = colorKey
    const notesNow = notesRef.current

    const removeOne = (cfi: string, ul: boolean): void => {
      try {
        rendition.annotations.remove(cfi, 'highlight')
        if (ul) rendition.annotations.remove(cfi, 'underline')
      } catch {
        /* 该章未挂载等，忽略 */
      }
    }
    if (repaint) {
      for (const [cfi, ul] of renderedRef.current) removeOne(cfi, ul)
      renderedRef.current.clear()
    } else {
      for (const [cfi, ul] of renderedRef.current) {
        if (!notesNow.some((n) => n.cfi_range === cfi)) {
          removeOne(cfi, ul)
          renderedRef.current.delete(cfi)
        }
      }
    }
    for (const n of notesNow) {
      if (renderedRef.current.has(n.cfi_range)) continue
      // cb 挂在标注元素上（marks-pane 代理派发；坐标为 iframe 系 → 换算 host 系）
      const click = (ev: MouseEvent): void => {
        const host2 = hostRef.current
        if (!host2) return
        lastMarkPointRef.current = proxiedPointInHost(host2, ev)
        markClickBubble(n.cfi_range)
      }
      try {
        rendition.annotations.highlight(n.cfi_range, { id: n.id }, click, 'bz-hl', {
          fill: colors.fill,
          'fill-opacity': '0.4',
          'mix-blend-mode': 'multiply'
        })
        if (n.note) {
          rendition.annotations.underline(n.cfi_range, { id: n.id }, click, 'bz-hl-ul', {
            stroke: colors.stroke,
            'stroke-opacity': '0.9',
            'mix-blend-mode': 'multiply'
          })
        }
        renderedRef.current.set(n.cfi_range, !!n.note)
      } catch {
        /* 该章未挂载等，忽略（下次 sync 重试） */
      }
    }
  }

  /** 创建 rendition（初次打开与模式切换共用；事件/主题/标注全量重挂） */
  const createRendition = (): void => {
    const bk = bookRef.current
    const host = hostRef.current
    if (!bk || !host) return
    const rendition = bk.renderTo(host, {
      width: '100%',
      height: '100%',
      flow: mode === 'page' ? 'paginated' : 'scrolled',
      spread: 'none',
      allowScriptedContent: false
    })
    renditionRef.current = rendition
    renderedRef.current.clear() // 新实例标注为空
    applyTheme(rendition, fontScale)
    void rendition.display(curCfiRef.current ?? book.progress_cfi ?? undefined).then(() => {
      // 首帧展示后再挂标注（render hook 依赖视图就绪）
      syncAnnotations()
      // 并按内容盒净尺寸重排一次——消除挂载竞态下的旧宽残留（切模式后首视图横向可拖，
      // 260909 开发者反馈；跳章后消失即首帧宽度未收敛）
      const host2 = hostRef.current
      if (host2) {
        const { w, h } = contentBoxSize(host2)
        if (w > 0 && h > 0) {
          try {
            rendition.resize(w, h)
          } catch {
            /* resize 失败不阻断 */
          }
        }
      }
    })
    rendition.on('relocated', (loc: unknown) => {
      const l = loc as { start?: { cfi?: string; index?: number; percentage?: number; href?: string } }
      const cfi = l.start?.cfi ?? null
      if (typeof l.start?.index === 'number') spineIdxRef.current = l.start.index
      if (cfi) curCfiRef.current = cfi
      if (l.start?.href) props.onLocate({ href: l.start.href })
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
    // 划词 → 浮窗（高光 / 批注）；点击已渲染标注走 annotations cb（见 syncAnnotations）
    rendition.on('selected', (cfiRange: string, contents: Contents) => {
      const selText = contents.window.getSelection()?.toString().trim() ?? ''
      if (!selText || !hostRef.current) return
      const range = contents.range(cfiRange)
      const r = range?.getBoundingClientRect()
      if (!r) return
      const pos = rectInHost(hostRef.current, contents, r)
      const b = openBubble(pos.left + r.width / 2 - 88, pos.top - 46)
      if (!b) return
      const clearSel = (): void => contents.window.getSelection()?.removeAllRanges()
      b.append(
        mkBtn('高光', () => {
          props.onAddNote({ cfiRange, quote: selText, note: '' })
          clearSel()
          closeBubble()
        }),
        mkBtn('批注', () => mountNoteEditor(b, '', (text) => {
          props.onAddNote({ cfiRange, quote: selText, note: text })
          clearSel()
          closeBubble()
        }))
      )
    })
  }

  /** 章节级跳转（book.spine 上下章；浮动按钮与键盘共用） */
  const goChapter = (delta: number): void => {
    const bk = bookRef.current
    if (!bk) return
    const target = bk.spine.get(spineIdxRef.current + delta)
    if (target?.href) void renditionRef.current?.display(target.href)
  }

  // 打开书籍（book.id 变化即换书；模式切换由父级换 key 全量重挂——同 Book 重建 rendition
  // 在 scroll→page 方向实测空白（260909 开发者反馈），彻底重开最稳）
  useEffect(() => {
    let destroyed = false
    const run = async (): Promise<void> => {
      const data = await window.api.books.readFile(book.id)
      if (destroyed || !hostRef.current) return
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      const bk = ePub(ab)
      bookRef.current = bk
      // 目录上报（navigation 就绪后一次）
      void bk.loaded.navigation
        .then((nav) => props.onToc(convertToc(nav.toc)))
        .catch(() => undefined)
      createRendition()
      // locations 异步生成（大书较慢）；就绪前 relocated 的 percentage 走 epub.js 内置近似
      void bk.locations.generate(800).catch(() => undefined)
    }
    void run()
    return () => {
      destroyed = true
      saveNow() // 退出阅读 flush（specs：节流 3 秒 + 退出落库）
      closeBubble()
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
      renderedRef.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id])

  // 主题切换重注入（不重载书）；标注重涂由 syncAnnotations 检测色值变化完成
  useEffect(() => {
    applyTheme(renditionRef.current, fontScale)
    syncAnnotations()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  // 字号变化即时重注入（不重挂不丢进度；epub.js 自动重排——书架 v2.0 §四）
  useEffect(() => {
    applyTheme(renditionRef.current, fontScale)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontScale])

  // notes 变化 → 标注 diff（book 未就绪时由 createRendition 完成后补挂）
  useEffect(() => {
    syncAnnotations()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes])

  // 容器尺寸变化重排（侧栏开合/窗口缩放；epub.js 只听 window resize，侧栏开合不触发 → 手动补）
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let timer: number | undefined
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        // 传内容盒净尺寸（clientWidth/Height 含 padding，直接传会令容器溢出数像素 → 宿主可拖动）
        const host2 = hostRef.current
        if (!host2) return
        const { w, h } = contentBoxSize(host2)
        if (w > 0 && h > 0) renditionRef.current?.resize(w, h)
      }, 80)
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      window.clearTimeout(timer)
    }
  }, [])

  // 键盘（§8.2 修订：W/S 按住流式滚动）：滚动 = 上下流式/左右换章；翻页 = 左右翻页/上下换节
  useEffect(() => {
    const hold = createHoldScroller()
    const onKey = (e: KeyboardEvent): void => {
      const dir = parseReaderKey(e)
      if (!dir || !hostRef.current) return
      e.preventDefault()
      const host = hostRef.current
      if (mode === 'scroll') {
        if (dir === 'up' || dir === 'down') {
          // 长按流式（忽略系统按键重发，rAF 循环持续滚动）
          if (!e.repeat) hold.press(dir === 'up' ? -1 : 1, scrollerOf(host))
        } else {
          goChapter(dir === 'left' ? -1 : 1)
        }
      } else {
        const rendition = renditionRef.current
        if (!rendition) return
        if (dir === 'left') void rendition.prev()
        else if (dir === 'right') void rendition.next()
        else goChapter(dir === 'up' ? -1 : 1)
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

  // 点 host 空白处收气泡
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onDown = (e: MouseEvent): void => {
      if (bubbleRef.current && e.target instanceof Node && bubbleRef.current.contains(e.target)) return
      closeBubble()
    }
    host.addEventListener('mousedown', onDown)
    return () => host.removeEventListener('mousedown', onDown)
  }, [])

  useImperativeHandle(ref, () => ({
    jumpToCfi: (cfi: string) => void renditionRef.current?.display(cfi),
    jumpToToc: (href: string) => void renditionRef.current?.display(href),
    getCurrent: () => ({
      cfi: curCfiRef.current,
      percent: pendingRef.current?.percent ?? (book.progress_percent || 0) / 100
    })
  }))

  return (
    <>
      <div ref={hostRef} className={mode === 'page' ? 'bk-epub-host bk-page-mode' : 'bk-epub-host'} />
      <button className="bk-nav-btn bk-nav-up" title="上一章" onClick={() => goChapter(-1)}>
        <span className="material-symbols-outlined">arrow_upward</span>
      </button>
      <button className="bk-nav-btn bk-nav-down" title="下一章" onClick={() => goChapter(1)}>
        <span className="material-symbols-outlined">arrow_downward</span>
      </button>
    </>
  )
})

export default EpubReader
