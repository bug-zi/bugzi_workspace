// 阅读侧栏（书架优化第1轮 §8.4/§8.5 + v2.0 §二/§三 + 书签优化轮 §四）：目录 | 笔记 | 书签 三页签展示组件
// （引擎无关，跳转/删除经回调上行；笔记总览入口仅 epub）
import { useState } from 'react'
import type { BookMark, BooksNote } from '../../shared/types'

/** 目录树节点（epub href 跳转 / pdf 页码跳转，二选一有值） */
export interface ReaderTocItem {
  label: string
  /** epub：章节 href（rendition.display 直达） */
  href?: string
  /** epub：spine 序号（书签优化轮 §一，「当前章」区间判定用；解析失败缺省） */
  spineIndex?: number
  /** pdf：目标页码（1 基） */
  page?: number
  children?: ReaderTocItem[]
}

/** 当前位置（epub 传 href，pdf 传当前页码） */
export interface ReaderLocate {
  href?: string
  /** epub：当前 spine 序号（书签优化轮 §一） */
  spineIndex?: number
  page?: number
}

export type SidebarTab = 'toc' | 'notes' | 'marks'

export interface ReaderSidebarProps {
  tab: SidebarTab
  onTabChange: (t: SidebarTab) => void
  toc: ReaderTocItem[]
  locate: ReaderLocate | null
  /** pdf 传 null → 笔记页签占位 */
  notes: BooksNote[] | null
  /** 手动书签（epub/pdf 都支持；书架 v2.0 §二） */
  marks: BookMark[]
  onJumpToc: (item: ReaderTocItem) => void
  onJumpNote: (note: BooksNote) => void
  onDeleteNote: (note: BooksNote) => void
  onJumpMark: (m: BookMark) => void
  onDeleteMark: (m: BookMark) => void
  /** 书签改名/备注保存（模块层走 IPC；书签优化轮 §四） */
  onUpdateMark: (id: number, m: { label: string; note: string }) => void
  /** 笔记总览入口（仅 epub 传；不传不显示按钮——书架 v2.0 §三） */
  onOverview?: () => void
  onCollapse: () => void
}

/** 相对时间（口径同草稿本/AI 边栏；BookshelfModule 统计面板复用） */
export function relTime(iso: string): string {
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

/** 当前 spine 序号落在的目录章节（DFS 序最后一个 spineIndex ≤ 当前的节点；书签优化轮 §一，与 tocAnchorAt 同构） */
export function epubChapterAt(items: ReaderTocItem[], spineIndex: number): ReaderTocItem | null {
  let hit: ReaderTocItem | null = null
  for (const it of flattenToc(items)) {
    if (it.spineIndex != null && it.spineIndex <= spineIndex) hit = it
    else if (it.spineIndex != null && hit) break
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

/** 单条书签行：常态（label + 备注小字 + hover 编辑/删除）与行内编辑态（书签优化轮 §四） */
function MarkItem(props: {
  mark: BookMark
  onJump: (m: BookMark) => void
  onDelete: (m: BookMark) => void
  onUpdate: (id: number, m: { label: string; note: string }) => void
}) {
  const { mark, onJump, onDelete, onUpdate } = props
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const startEdit = (): void => {
    setLabel(mark.label)
    setNote(mark.note)
    setEditing(true)
  }
  const save = (): void => {
    const t = label.trim()
    if (!t) return // 空名兜底（保存按钮已禁用）
    onUpdate(mark.id, { label: t, note: note.trim() })
    setEditing(false)
  }
  if (editing) {
    return (
      <div className="bk-note-item bk-mark-editing" onClick={(e) => e.stopPropagation()}>
        <input
          className="bk-mark-label-input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            else if (e.key === 'Escape') setEditing(false)
          }}
          placeholder="书签名"
          autoFocus
        />
        <textarea
          className="bk-mark-note-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="写点备注…可留空"
          rows={2}
        />
        <div className="bk-mark-edit-row">
          <button className="btn" disabled={!label.trim()} onClick={save}>
            保存
          </button>
          <button className="btn btn-ghost" onClick={() => setEditing(false)}>
            取消
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="bk-note-item" onClick={() => onJump(mark)} title="点击跳回书签位置">
      <div className="bk-note-quote">{mark.label}</div>
      {mark.note && <div className="bk-note-text">{mark.note}</div>}
      <div className="bk-note-foot">
        <span>书签 · {relTime(mark.created_at)}</span>
        <span className="bk-mark-actions">
          <button
            className="bk-mark-edit-btn"
            title="编辑书签（改名 / 备注）"
            onClick={(e) => {
              e.stopPropagation()
              startEdit()
            }}
          >
            <span className="material-symbols-outlined">edit</span>
          </button>
          <button
            className="bk-note-del"
            title="删除书签"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(mark)
            }}
          >
            <span className="material-symbols-outlined">delete</span>
          </button>
        </span>
      </div>
    </div>
  )
}

export default function ReaderSidebar(props: ReaderSidebarProps) {
  const { tab, onTabChange, toc, locate, notes, marks, onJumpToc, onJumpNote, onDeleteNote, onJumpMark, onDeleteMark, onUpdateMark, onOverview, onCollapse } = props
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
          <button className={`bk-sidebar-tab${tab === 'marks' ? ' active' : ''}`} onClick={() => onTabChange('marks')}>
            书签{marks.length > 0 ? `(${marks.length})` : ''}
          </button>
        </div>
        {tab === 'notes' && onOverview && (
          <button
            className="btn btn-ghost bk-side-overview"
            onClick={onOverview}
            disabled={!notes || notes.length === 0}
            title="打开整书笔记总览（md）"
          >
            <span className="material-symbols-outlined">article</span>
          </button>
        )}
        <button className="btn btn-ghost bk-sidebar-close" onClick={onCollapse} title="收起侧栏">
          <span className="material-symbols-outlined">chevron_left</span>
        </button>
      </div>
      <div className="bk-sidebar-body">
        {tab === 'marks' ? (
          marks.length === 0 ? (
            <div className="bk-sidebar-empty">点阅读条的书签按钮，收藏当前位置</div>
          ) : (
            marks.map((m) => (
              <MarkItem key={m.id} mark={m} onJump={onJumpMark} onDelete={onDeleteMark} onUpdate={onUpdateMark} />
            ))
          )
        ) : tab === 'toc' ? (
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
