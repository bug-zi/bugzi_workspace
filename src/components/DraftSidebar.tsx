// 草稿本边栏（优化建议区第21轮）：右缘常驻面板，与 debugzi 互斥展开。
// 频道（通用/海龟汤）+ 草稿切换器（镜像 AI 会话交互：浮层列表、hover 重命名/删除）
// + 正文 MdView 渲染态/双击编辑 + MdDialog 大窗逃生口；删除走回收站。
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { DraftChannel, DraftRow } from '../renderer/api'
import { SettingsKeys } from '../shared/types'
import ConfirmDialog from './ConfirmDialog'
import MdDialog from './MdDialog'
import MdView from './MdView'
import { useToast } from './Toast'
import './DraftSidebar.css'

export interface DraftSidebarProps {
  onCollapse: () => void
  /** 当前海龟汤对局上下文（App 监听 TURTLE_GAME_EVENT 传入；null = 不在对局中） */
  turtleGame: { title: string } | null
}

/** 频道清单（DB v14 起步：通用 + 海龟汤；频道为普通字段，将来加零迁移） */
const CHANNELS: { id: DraftChannel; label: string; icon: string }[] = [
  { id: 'general', label: '通用', icon: 'edit_note' },
  { id: 'turtle', label: '海龟汤', icon: 'psychology' }
]

/** 各频道激活草稿的 settings key（镜像 AI 边栏 per-channel active session 模式） */
const ACTIVE_DRAFT_KEYS: Record<DraftChannel, string> = {
  general: SettingsKeys.DraftActiveGeneral,
  turtle: SettingsKeys.DraftActiveTurtle
}

/** 面板宽度拖拽范围（px；默认值同 global.css --draft-width） */
const DRAFT_WIDTH_MIN = 280
const DRAFT_WIDTH_MAX = 560
const DRAFT_WIDTH_DEFAULT = 320

const clampDraftWidth = (w: number): number =>
  Math.min(DRAFT_WIDTH_MAX, Math.max(DRAFT_WIDTH_MIN, Math.round(w)))

/** 宽度写 :root 的 --draft-width（样式即生效） */
function applyDraftWidth(w: number): void {
  document.documentElement.style.setProperty('--draft-width', `${w}px`)
}

/** 某频道的激活草稿落库 */
async function persistActive(id: number | null, channel: DraftChannel): Promise<void> {
  await window.api.settings.set(ACTIVE_DRAFT_KEYS[channel], id == null ? '' : String(id))
}

/** 相对时间（草稿列表用，口径同 AiSidebar） */
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

export default function DraftSidebar(props: DraftSidebarProps) {
  const { onCollapse, turtleGame } = props
  const { toast } = useToast()
  const [activeChannel, setActiveChannel] = useState<DraftChannel>('general')
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameText, setRenameText] = useState('')
  const [confirmDel, setConfirmDel] = useState<DraftRow | null>(null)
  const [bigWindow, setBigWindow] = useState(false)
  const [draftWidth, setDraftWidth] = useState(DRAFT_WIDTH_DEFAULT)
  const bodyRef = useRef<HTMLDivElement>(null)
  const activeChannelRef = useRef<DraftChannel>('general')
  activeChannelRef.current = activeChannel
  const activeIdRef = useRef<number | null>(null)
  activeIdRef.current = activeId
  // 卸载落袋用（面板收起/切回 debugzi 时编辑中的文字不能丢）
  const editStateRef = useRef({ editing, editText, content, activeId })
  editStateRef.current = { editing, editText, content, activeId }

  // 卸载落袋：面板收起时编辑态有改动先保存（纯 IPC 落库，不依赖组件存活）
  useEffect(() => {
    return () => {
      const { editing: ed, editText: et, content: c, activeId: id } = editStateRef.current
      if (!ed || id == null || et === c) return
      void window.api.draft.save(id, et).catch(() => {})
    }
  }, [])

  /** 读一篇草稿正文（失败显示占位，不阻断） */
  const loadContent = async (mdPath: string): Promise<void> => {
    try {
      setContent(await window.api.md.read(mdPath))
    } catch {
      setContent('（读取失败）')
    }
  }

  /** 刷新某频道草稿列表并恢复该频道激活草稿（失效兜底最近一篇），返回激活草稿（无则 null） */
  const loadForChannel = async (channel: DraftChannel): Promise<DraftRow | null> => {
    const list = await window.api.draft.list(channel)
    setDrafts(list)
    const saved = await window.api.settings.get(ACTIVE_DRAFT_KEYS[channel])
    const sid = saved ? Number(saved) : NaN
    let aid = Number.isInteger(sid) && sid > 0 && list.some((d) => d.id === sid) ? sid : null
    if (aid == null && list.length > 0) {
      aid = list[0].id
      await persistActive(aid, channel)
    }
    activeIdRef.current = aid
    setActiveId(aid)
    const row = aid != null ? (list.find((d) => d.id === aid) ?? null) : null
    if (row) await loadContent(row.md_path)
    else setContent('')
    return row
  }

  // 初始化：恢复上次所在频道 + 该频道草稿 + 恢复保存的面板宽度
  useEffect(() => {
    void (async () => {
      let ch: DraftChannel = 'general'
      try {
        const saved = await window.api.settings.get(SettingsKeys.DraftActiveChannel)
        if (saved === 'turtle' || saved === 'general') ch = saved
      } catch {
        /* 读失败用默认 */
      }
      activeChannelRef.current = ch
      setActiveChannel(ch)
      await loadForChannel(ch)
      const savedW = await window.api.settings.get(SettingsKeys.DraftWidth)
      const w = savedW ? Number(savedW) : NaN
      if (Number.isFinite(w) && w >= DRAFT_WIDTH_MIN && w <= DRAFT_WIDTH_MAX) {
        setDraftWidth(w)
        applyDraftWidth(w)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 海龟汤联动（设计 B）：进入对局 → 自动切到海龟汤频道；退出不动（用户停在哪由用户掌握）
  useEffect(() => {
    if (turtleGame && activeChannelRef.current !== 'turtle') void switchChannel('turtle')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turtleGame])

  // 回收站恢复草稿 → 刷新当前频道列表（恢复的草稿回到原频道）
  useEffect(() => {
    return window.api.item.onRecycleChanged(() => {
      void loadForChannel(activeChannelRef.current)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 切换草稿/频道前落袋：编辑态有改动先保存（速记场景不丢字；保存失败不阻断切换） */
  const flushEdit = async (): Promise<void> => {
    const id = activeIdRef.current
    if (!editing || id == null || editText === content) return
    try {
      await window.api.draft.save(id, editText)
      setContent(editText)
    } catch {
      /* 保存失败不阻断切换 */
    }
  }

  // 编辑态自动保存（开发者反馈修订）：停止输入 800ms 后静默落库，无需点保存；
  // 落库后同步 content（与 editText 对齐 → 脏检查视为已保存，卸载/切换落袋不重复写）
  useEffect(() => {
    if (!editing) return
    const id = activeIdRef.current
    if (id == null) return
    const text = editText
    const timer = setTimeout(() => {
      if (text === content) return
      void window.api.draft
        .save(id, text)
        .then(() => setContent(text))
        .catch(() => toast('自动保存失败，稍后重试'))
    }, 800)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editText, editing])

  /** 退出编辑态：先落袋兜住 800ms 防抖窗口内的最后输入，再回渲染态 */
  const finishEdit = async (): Promise<void> => {
    await flushEdit()
    setEditing(false)
  }

  /** 切换频道：持久化 + 载入该频道草稿 */
  const switchChannel = async (id: DraftChannel): Promise<void> => {
    if (id === activeChannelRef.current) return
    await flushEdit()
    activeChannelRef.current = id
    setActiveChannel(id)
    setPanelOpen(false)
    setRenamingId(null)
    setEditing(false)
    await window.api.settings.set(SettingsKeys.DraftActiveChannel, id)
    await loadForChannel(id)
  }

  /** 切换草稿（当前频道内） */
  const switchDraft = async (id: number): Promise<void> => {
    if (id === activeIdRef.current) {
      setPanelOpen(false)
      return
    }
    await flushEdit()
    activeIdRef.current = id
    setActiveId(id)
    setPanelOpen(false)
    setRenamingId(null)
    setEditing(false)
    await persistActive(id, activeChannelRef.current)
    const row = drafts.find((d) => d.id === id)
    if (row) await loadContent(row.md_path)
  }

  /** 新建草稿：海龟汤频道且在对局中 → 标题为汤名（正文空白不预填，开发者 260907 定） */
  const newDraft = async (): Promise<void> => {
    const channel = activeChannelRef.current
    const title =
      channel === 'turtle' && turtleGame ? `《${turtleGame.title}》` : null
    const id = await window.api.draft.create(channel, title, null)
    await persistActive(id, channel)
    await loadForChannel(channel) // 新草稿 updated_at 最新，自然排列表首并被激活
    setPanelOpen(false)
    setEditText('')
    setEditing(true) // 新草稿直接进编辑态开写
  }

  /** 双击改名提交（Enter） */
  const commitRename = async (id: number): Promise<void> => {
    const title = renameText.trim()
    setRenamingId(null)
    if (!title) return
    await window.api.draft.rename(id, title)
    setDrafts((arr) => arr.map((d) => (d.id === id ? { ...d, title } : d)))
  }

  /** 删除当前/列表草稿 → 回收站（二次确认后） */
  const doDelete = async (): Promise<void> => {
    const target = confirmDel
    if (!target) return
    setConfirmDel(null)
    await window.api.draft.discard(target.id)
    toast('已移入回收站（3 天后彻底删除）')
    await loadForChannel(activeChannelRef.current)
  }

  /** 大窗编辑（MdDialog 自行 md.write 保存）：onChanged 回来触碰排序并重读正文 */
  const onBigWindowChanged = async (): Promise<void> => {
    const id = activeIdRef.current
    if (id == null) return
    await window.api.draft.touch(id)
    await loadForChannel(activeChannelRef.current)
  }

  /** 拖拽左缘调宽：移动中实时生效，松手持久化到 settings */
  const startResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = draftWidth
    const onMove = (ev: MouseEvent): void => {
      const w = clampDraftWidth(startWidth - (ev.clientX - startX))
      setDraftWidth(w)
      applyDraftWidth(w)
    }
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      void window.api.settings.set(SettingsKeys.DraftWidth, String(clampDraftWidth(startWidth - (ev.clientX - startX))))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
  }

  const activeDraft = drafts.find((d) => d.id === activeId) ?? null
  const channelLabel = CHANNELS.find((c) => c.id === activeChannel)?.label ?? '通用'

  return (
    <aside className="draft-sidebar">
      <div className="draft-resizer" onMouseDown={startResize} title="拖拽调整宽度" />
      <div className="draft-header">
        <span className="material-symbols-outlined">edit_note</span>
        <span className="draft-title">草稿本</span>
        <button className="btn btn-ghost" onClick={onCollapse} title="收起">
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      </div>
      {/* 频道切换条（通用 / 海龟汤） */}
      <div className="draft-channels">
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            className={`draft-channel${activeChannel === c.id ? ' active' : ''}`}
            onClick={() => void switchChannel(c.id)}
            title={`${c.label}频道（独立草稿）`}
          >
            <span className="material-symbols-outlined">{c.icon}</span>
            <span className="draft-channel-label">{c.label}</span>
          </button>
        ))}
      </div>
      {/* 草稿切换条：当前草稿标题（点开浮层列表）+ 新建 */}
      {activeId != null && (
        <div className="draft-switchbar">
          <button className="draft-switch-trigger" onClick={() => setPanelOpen((v) => !v)} title="草稿列表">
            <span className="draft-switch-title">{activeDraft?.title ?? '新建草稿'}</span>
            <span className="material-symbols-outlined">{panelOpen ? 'expand_less' : 'expand_more'}</span>
          </button>
          <button className="btn btn-ghost" onClick={() => void newDraft()} title="新建草稿">
            <span className="material-symbols-outlined">add</span>
          </button>
        </div>
      )}
      <div className="draft-body">
        {activeId != null && panelOpen && (
          <>
            <div className="draft-panel-backdrop" onClick={() => setPanelOpen(false)} />
            <div className="draft-panel">
              <div className="draft-panel-head">
                <span>草稿（{channelLabel}）</span>
                <button className="btn btn-ghost" onClick={() => void newDraft()} title="新建草稿">
                  <span className="material-symbols-outlined">add</span>
                </button>
              </div>
              <div className="draft-list">
                {drafts.length === 0 && <div className="draft-panel-empty">暂无草稿，点右上角「+」新建</div>}
                {drafts.map((d) => (
                  <div
                    key={d.id}
                    className={`draft-item${d.id === activeId ? ' active' : ''}`}
                    onClick={() => void switchDraft(d.id)}
                    title="单击切换草稿"
                  >
                    {renamingId === d.id ? (
                      <input
                        className="draft-item-rename"
                        value={renameText}
                        autoFocus
                        maxLength={50}
                        onChange={(e) => setRenameText(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void commitRename(d.id)
                          }
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        onBlur={() => setRenamingId(null)}
                      />
                    ) : (
                      <>
                        <div className="draft-item-title">{d.title}</div>
                        <div className="draft-item-time">{relTime(d.updated_at)}</div>
                        <button
                          className="draft-item-act"
                          title="重命名草稿"
                          onClick={(e) => {
                            e.stopPropagation()
                            setRenamingId(d.id)
                            setRenameText(d.title)
                          }}
                        >
                          <span className="material-symbols-outlined">edit</span>
                        </button>
                      </>
                    )}
                    <button
                      className="draft-item-act draft-item-del"
                      title="移入回收站"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmDel(d)
                      }}
                    >
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        {/* 正文区：渲染态（双击进编辑）/ 编辑态 textarea */}
        {activeId == null ? (
          <div className="draft-empty">
            「{channelLabel}」频道还没有草稿
            <button className="btn btn-primary draft-empty-new" onClick={() => void newDraft()}>
              <span className="material-symbols-outlined">add</span>
              新建草稿
            </button>
          </div>
        ) : editing ? (
          <textarea
            className="draft-editor"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') void finishEdit()
            }}
            placeholder="支持 Markdown 格式，自动保存"
            autoFocus
          />
        ) : (
          <div
            className="draft-content"
            ref={bodyRef}
            onDoubleClick={() => {
              setEditText(content)
              setEditing(true)
            }}
            title="双击进入编辑"
          >
            <MdView md={content} />
          </div>
        )}
      </div>
      {/* 底部动作条：编辑态 = 自动保存提示 + 完成（Esc 同效）；渲染态 = 大窗编辑入口 */}
      {activeId != null &&
        (editing ? (
          <div className="draft-actions draft-actions-view">
            <span className="draft-actions-hint">输入自动保存</span>
            <button className="btn btn-primary" onClick={() => void finishEdit()}>
              <span className="material-symbols-outlined">check</span>
              完成
            </button>
          </div>
        ) : (
          <div className="draft-actions draft-actions-view">
            <span className="draft-actions-hint">双击正文可编辑</span>
            <button
              className="btn btn-ghost"
              onClick={() => setBigWindow(true)}
              title="用大弹窗编辑（支持完整 Markdown 工具链）"
            >
              <span className="material-symbols-outlined">open_in_full</span>
              大窗编辑
            </button>
          </div>
        ))}
      {/* 大窗逃生口：全局统一 md 弹窗（渲染态 + 双击编辑，保存路径同源） */}
      {activeDraft && (
        <MdDialog
          open={bigWindow}
          title={activeDraft.title}
          filePath={activeDraft.md_path}
          onClose={() => setBigWindow(false)}
          onChanged={() => void onBigWindowChanged()}
        />
      )}
      <ConfirmDialog
        open={confirmDel != null}
        title="删除草稿"
        confirmText="移入回收站"
        danger
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDel(null)}
      >
        {confirmDel ? `草稿「${confirmDel.title}」将移入回收站，3 天后自动彻底删除。` : ''}
      </ConfirmDialog>
    </aside>
  )
}
