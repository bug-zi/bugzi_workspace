// 诗集页签（designs-specs §2.4）：轻诗集单列表 + 体裁筛选 + 新作 + MdDialog copilot 扩展位。
import { useCallback, useEffect, useRef, useState } from 'react'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { GENRE_ZH } from '../../shared/types'
import type { FushiGenre, FushiPoemRow } from '../../shared/types'

interface Props {
  onNeedConfig: () => void
}

const FILTERS: { key: FushiGenre | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'jueju', label: GENRE_ZH.jueju },
  { key: 'lvshi', label: GENRE_ZH.lvshi },
  { key: 'ci', label: GENRE_ZH.ci },
  { key: 'modern', label: GENRE_ZH.modern },
  { key: 'free', label: GENRE_ZH.free }
]

export default function PoemsPanel({ onNeedConfig }: Props) {
  const { toast } = useToast()
  const [list, setList] = useState<FushiPoemRow[]>([])
  const [filter, setFilter] = useState<FushiGenre | 'all'>('all')
  const [addOpen, setAddOpen] = useState(false)
  const [addTitle, setAddTitle] = useState('')
  const [addGenre, setAddGenre] = useState<FushiGenre>('jueju')
  const [openId, setOpenId] = useState<number | null>(null)
  const [justCreatedId, setJustCreatedId] = useState<number | null>(null)
  const [delQ, setDelQ] = useState<FushiPoemRow | null>(null)
  // copilot 状态机（调用方持 LLM 状态，MdDialog 持文本手术——specs §2.4）
  const [copilotBusy, setCopilotBusy] = useState(false)
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const jobRef = useRef('')

  const load = useCallback(async (): Promise<void> => {
    try {
      setList(await window.api.fushi.poems())
    } catch (e) {
      toast(`加载失败：${(e as Error).message}`)
    }
  }, [toast])
  useEffect(() => {
    void load()
  }, [load])

  const shown = filter === 'all' ? list : list.filter((p) => p.genre === filter)
  const openRow = list.find((p) => p.id === openId) ?? null

  const addSave = (): void => {
    const t = addTitle.trim()
    if (!t) return
    window.api.fushi
      .poemAdd(t, addGenre)
      .then((id) => {
        setAddOpen(false)
        setAddTitle('')
        setJustCreatedId(id)
        return load().then(() => setOpenId(id))
      })
      .catch((e: unknown) => toast(`创建失败：${(e as Error).message}`))
  }

  const runCopilot = (action: 'draft' | 'continue' | 'polish' | 'rewrite' | 'duiju' | 'gelo', selection: string): void => {
    if (copilotBusy || openId == null) return
    setCopilotBusy(true)
    setSuggestion(null)
    jobRef.current = crypto.randomUUID()
    window.api.fushi
      .copilot(jobRef.current, openId, action, selection)
      .then((md) => setSuggestion(md))
      .catch((e: unknown) => {
        const msg = String((e as Error).message)
        if (msg.includes('LLM_NOT_CONFIGURED')) onNeedConfig()
        else if (msg === '已取消') toast('已取消')
        else if (msg.includes('NO_SELECTION')) toast('请先选中要处理的诗句')
        else toast(`AI 失败：${msg}`)
      })
      .finally(() => setCopilotBusy(false))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="recycle-tabs">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`recycle-tab${filter === f.key ? ' active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setAddOpen(true)}>
          <span className="material-symbols-outlined">add</span>
          新作
        </button>
      </div>

      <div className="zone-body">
        {shown.length === 0 && (
          <div className="empty-state">
            <span className="material-symbols-outlined">ink_pen</span>
            {list.length === 0 ? '诗集还是空的——点「新作」落第一笔' : '该体裁暂无诗作'}
          </div>
        )}
        {shown.map((p) => (
          <div className="row-item" key={p.id} onClick={() => setOpenId(p.id)}>
            <span className="fushi-genre-chip">{GENRE_ZH[p.genre]}</span>
            <div className="row-main">
              <div className="row-title">{p.title}</div>
              <div className="row-sub">{p.updated_at.slice(0, 16).replace('T', ' ')}</div>
            </div>
            <div className="row-actions" onClick={(e) => e.stopPropagation()}>
              <button className="icon-btn" title="删除（入回收站）" onClick={() => setDelQ(p)}>
                <span className="material-symbols-outlined">delete</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 新作弹窗 */}
      {addOpen && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAddOpen(false)}>
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-header">新作</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                className="field"
                placeholder="标题（必填）"
                value={addTitle}
                onChange={(e) => setAddTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && addTitle.trim()) addSave()
                }}
                autoFocus
              />
              <select
                className="field"
                value={addGenre}
                onChange={(e) => setAddGenre(e.target.value as FushiGenre)}
              >
                {FILTERS.filter((f) => f.key !== 'all').map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="dialog-footer" style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setAddOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" disabled={!addTitle.trim()} onClick={addSave}>
                创建并开始写
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 诗作弹窗（copilot 扩展位唯一使用方） */}
      {openRow && (
        <MdDialog
          open
          title={openRow.title}
          titleTag={GENRE_ZH[openRow.genre]}
          filePath={openRow.md_path}
          autoEdit={openRow.id === justCreatedId}
          copilot={{
            busy: copilotBusy,
            suggestion,
            onRun: runCopilot,
            onAdopt: () => setSuggestion(null),
            onDismiss: () => setSuggestion(null)
          }}
          onClose={() => {
            setOpenId(null)
            setSuggestion(null)
            setJustCreatedId(null)
            void load()
          }}
        />
      )}

      <ConfirmDialog
        open={delQ != null}
        title="删除诗作"
        danger
        confirmText="删除"
        onConfirm={() => {
          if (delQ)
            void window.api.fushi.poemDelete(delQ.id).then(() => {
              void load()
              toast('已移入回收站')
            })
          setDelQ(null)
        }}
        onCancel={() => setDelQ(null)}
      >
        确定删除「{delQ?.title}」？将移入回收站。
      </ConfirmDialog>
    </div>
  )
}
