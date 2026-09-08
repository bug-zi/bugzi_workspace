// 阅读侧栏（书架优化第1轮 §8.4/§8.5）：目录 | 笔记 双页签展示组件（引擎无关，跳转/删除经回调上行）
import type { BooksNote } from '../../shared/types'

/** 目录树节点（epub href 跳转 / pdf 页码跳转，二选一有值） */
export interface ReaderTocItem {
  label: string
  /** epub：章节 href（rendition.display 直达） */
  href?: string
  /** pdf：目标页码（1 基） */
  page?: number
  children?: ReaderTocItem[]
}

/** 当前位置（epub 传 href，pdf 传当前页码） */
export interface ReaderLocate {
  href?: string
  page?: number
}

export type SidebarTab = 'toc' | 'notes'

export interface ReaderSidebarProps {
  tab: SidebarTab
  onTabChange: (t: SidebarTab) => void
  toc: ReaderTocItem[]
  locate: ReaderLocate | null
  /** pdf 传 null → 笔记页签占位 */
  notes: BooksNote[] | null
  onJumpToc: (item: ReaderTocItem) => void
  onJumpNote: (note: BooksNote) => void
  onDeleteNote: (note: BooksNote) => void
  onCollapse: () => void
}

/** 相对时间（口径同草稿本/AI 边栏） */
function relTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(t).toLocaleDateString('zh-CN')
}

/** 目录树 DFS 拍平（pdf W/S 换节与区间判定用） */
export function flattenToc(items: ReaderTocItem[]): ReaderTocItem[] {
  return items.flatMap((it) => [it, ...(it.children ? flattenToc(it.children) : [])])
}

/** 当前页落在的目录锚点（DFS 序最后一个 page <= 当前的节点）；无目录返回 null */
export function tocAnchorAt(items: ReaderTocItem[], page: number): ReaderTocItem | null {
  let hit: ReaderTocItem | null = null
  for (const it of flattenToc(items)) {
    if (it.page != null && it.page <= page) hit = it
    else if (it.page != null && hit) break
  }
  return hit
}

/** 目录树渲染（递归缩进，不折叠子树） */
function TocTree(props: {
  items: ReaderTocItem[]
  depth: number
  activeLabel: string | null
  onJump: (it: ReaderTocItem) => void
}) {
  const { items, depth, activeLabel, onJump } = props
  return (
    <>
      {items.map((it, i) => (
        <div key={`${depth}-${i}-${it.label}`}>
          <div
            className={`bk-toc-item${activeLabel != null && it.label === activeLabel ? ' active' : ''}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => onJump(it)}
            title={it.label}
          >
            <span className="bk-toc-label">{it.label || '(无标题)'}</span>
            {it.page != null && <span className="bk-toc-page">{it.page}</span>}
          </div>
          {it.children && it.children.length > 0 && (
            <TocTree items={it.children} depth={depth + 1} activeLabel={activeLabel} onJump={onJump} />
          )}
        </div>
      ))}
    </>
  )
}

export default function ReaderSidebar(props: ReaderSidebarProps) {
  const { tab, onTabChange, toc, locate, notes, onJumpToc, onJumpNote, onDeleteNote, onCollapse } = props
  // pdf 区间判定：当前页落在的目录节点（按 label 匹配标 active）；epub 用 href 精确匹配
  const anchor = locate?.page != null ? tocAnchorAt(toc, locate.page) : null
  const activeLabel = locate?.href ? (toc.find((t) => t.href === locate.href)?.label ?? null) : anchor?.label ?? null
  return (
    <aside className="bk-sidebar">
      <div className="bk-sidebar-head">
        <div className="bk-sidebar-tabs">
          <button className={`bk-sidebar-tab${tab === 'toc' ? ' active' : ''}`} onClick={() => onTabChange('toc')}>
            目录
          </button>
          <button className={`bk-sidebar-tab${tab === 'notes' ? ' active' : ''}`} onClick={() => onTabChange('notes')}>
            笔记{notes && notes.length > 0 ? `(${notes.length})` : ''}
          </button>
        </div>
        <button className="btn btn-ghost bk-sidebar-close" onClick={onCollapse} title="收起侧栏">
          <span className="material-symbols-outlined">chevron_left</span>
        </button>
      </div>
      <div className="bk-sidebar-body">
        {tab === 'toc' ? (
          toc.length === 0 ? (
            <div className="bk-sidebar-empty">本书无目录</div>
          ) : (
            <TocTree items={toc} depth={0} activeLabel={activeLabel} onJump={onJumpToc} />
          )
        ) : notes == null ? (
          <div className="bk-sidebar-empty">PDF 暂不支持划词笔记</div>
        ) : notes.length === 0 ? (
          <div className="bk-sidebar-empty">阅读 epub 时划选文字，即可高光或写批注</div>
        ) : (
          notes.map((n) => (
            <div key={n.id} className="bk-note-item" onClick={() => onJumpNote(n)} title="点击跳回划词位置">
              <div className="bk-note-quote">{n.quote}</div>
              {n.note && <div className="bk-note-text">{n.note}</div>}
              <div className="bk-note-foot">
                <span>{n.note ? '批注' : '高光'} · {relTime(n.created_at)}</span>
                <button
                  className="bk-note-del"
                  title="删除笔记"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteNote(n)
                  }}
                >
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
