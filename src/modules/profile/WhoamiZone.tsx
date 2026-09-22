// 我是谁 zone（260921 新功能开发区）：个人档·我的画像之下——每日 3-4 问 + 回答提炼候选 + 逐条确认入档；
// 260923 第51轮：候选条目支持行内就地编辑（类别 select + 内容输入框，保存写回候选记录）
import { useCallback, useEffect, useState } from 'react'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { PROFILE_CATEGORIES } from '../../shared/types'
import type { WhoamiGetResult, WhoamiQuestionView } from '../../shared/types'
import './WhoamiZone.css'

export interface WhoamiZoneProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function WhoamiZone({ open, onOpenChange }: WhoamiZoneProps) {
  const { toast } = useToast()
  const [data, setData] = useState<WhoamiGetResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [extracting, setExtracting] = useState<Record<number, boolean>>({})
  const [extractErr, setExtractErr] = useState<Record<number, string>>({})
  // 来一问（260923 开发者指令）：实时生成一问的进行中标志
  const [askingOne, setAskingOne] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await window.api.whoami.get())
    } catch {
      setData({ today: [], pending: [] })
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useModuleActivated('profile', load)

  /** 行级回写（today/pending 两列表都试） */
  const patch = useCallback((row: WhoamiQuestionView): void => {
    setData((d) => {
      if (!d) return d
      const swap = (arr: WhoamiQuestionView[]): WhoamiQuestionView[] =>
        arr.map((q) => (q.id === row.id ? row : q))
      return { today: swap(d.today), pending: swap(d.pending) }
    })
  }, [])

  const today = data?.today ?? []
  const pending = data?.pending ?? []
  const unanswered = today.filter((q) => q.answer == null && !q.skipped).length

  /** 提炼（回答提交后自动跑一次；失败留 err 可重试，回答不丢） */
  const runExtract = useCallback(
    async (q: WhoamiQuestionView): Promise<void> => {
      setExtracting((m) => ({ ...m, [q.id]: true }))
      try {
        patch(await window.api.whoami.extract(q.id))
        setExtractErr((m) => ({ ...m, [q.id]: '' }))
      } catch (e) {
        const msg = (e as Error).message
        setExtractErr((m) => ({
          ...m,
          [q.id]: msg === 'LLM_NOT_CONFIGURED' ? 'LLM_NOT_CONFIGURED' : msg || '提炼失败'
        }))
      } finally {
        setExtracting((m) => ({ ...m, [q.id]: false }))
      }
    },
    [patch]
  )

  const doGenerate = async (): Promise<void> => {
    setGenerating(true)
    try {
      setData(await window.api.whoami.generate())
    } catch (e) {
      const msg = (e as Error).message
      toast(msg === 'LLM_NOT_CONFIGURED' ? '请先在本页上方配置 LLM' : msg || '生成失败，请稍后再试')
    } finally {
      setGenerating(false)
    }
  }

  const doAnswer = async (q: WhoamiQuestionView): Promise<void> => {
    const text = (drafts[q.id] ?? '').trim()
    if (!text) return
    try {
      patch(await window.api.whoami.answer(q.id, text))
      setDrafts((d) => ({ ...d, [q.id]: '' }))
      void runExtract(q)
    } catch (e) {
      toast((e as Error).message || '提交失败')
    }
  }

  const doSkip = async (q: WhoamiQuestionView): Promise<void> => {
    try {
      patch(await window.api.whoami.answer(q.id, null))
    } catch {
      toast('操作失败')
    }
  }

  const doResolve = async (q: WhoamiQuestionView, index: number, accept: boolean): Promise<void> => {
    try {
      patch(await window.api.whoami.resolve(q.id, index, accept))
      if (accept) toast('已加入画像')
    } catch {
      toast('操作失败')
    }
  }

  /** 就地编辑候选条目（优化建议区第51轮）：成功 patch 回写返回 true；失败 toast 并保持编辑态 */
  const doUpdateSuggestion = async (
    q: WhoamiQuestionView,
    index: number,
    category: string,
    content: string
  ): Promise<boolean> => {
    try {
      patch(await window.api.whoami.suggestionUpdate(q.id, index, category, content))
      return true
    } catch (e) {
      toast((e as Error).message || '保存失败')
      return false
    }
  }

  /** 来一问（260923 开发者指令）：AI 实时生成一问追加今日列表；新行不走 patch，需 append */
  const doAskOne = async (): Promise<void> => {
    if (askingOne) return
    setAskingOne(true)
    try {
      const row = await window.api.whoami.askOne()
      setData((d) => (d ? { ...d, today: [...d.today, row] } : d))
    } catch (e) {
      const msg = (e as Error).message
      if (msg !== 'BUSY') toast(msg === 'LLM_NOT_CONFIGURED' ? '请先在本页上方配置 LLM' : msg || '生成失败，请稍后再试')
    } finally {
      setAskingOne(false)
    }
  }

  return (
    <section className="zone">
      <div className="zone-header" onClick={() => onOpenChange(!open)}>
        <span className="material-symbols-outlined">{open ? 'expand_less' : 'expand_more'}</span>
        <span>我是谁</span>
        <span className="zone-count">{unanswered}</span>
      </div>
      {open && (
        <div className="zone-body">
          <div className="whoami-toolbar">
            <button className="btn" disabled={askingOne} onClick={() => void doAskOne()}>
              <span className="material-symbols-outlined">{askingOne ? 'hourglass_top' : 'bolt'}</span>
              {askingOne ? '思考中…' : '来一问'}
            </button>
          </div>
          {today.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">psychology</span>
              {generating ? '正在生成今日问题…' : '今日还没有问题'}
              {!generating && (
                <button className="btn" onClick={() => void doGenerate()}>
                  <span className="material-symbols-outlined">refresh</span>
                  生成今日问题
                </button>
              )}
            </div>
          )}
          {today.map((q) => (
            <WhoamiItem
              key={q.id}
              q={q}
              draft={drafts[q.id] ?? ''}
              onDraft={(v) => setDrafts((d) => ({ ...d, [q.id]: v }))}
              onAnswer={() => void doAnswer(q)}
              onSkip={() => void doSkip(q)}
              extracting={extracting[q.id] === true}
              extractErr={extractErr[q.id] ?? ''}
              onRetryExtract={() => void runExtract(q)}
              onResolve={(i, accept) => void doResolve(q, i, accept)}
              onUpdateSuggestion={(i, c, t) => doUpdateSuggestion(q, i, c, t)}
            />
          ))}
          {pending.length > 0 && (
            <div className="whoami-pending-title">待确认（往日回答提炼的候选条目）</div>
          )}
          {pending.map((q) => (
            <WhoamiItem
              key={`p-${q.id}`}
              q={q}
              draft=""
              onDraft={() => {}}
              onAnswer={() => {}}
              onSkip={() => {}}
              extracting={extracting[q.id] === true}
              extractErr={extractErr[q.id] ?? ''}
              onRetryExtract={() => void runExtract(q)}
              onResolve={(i, accept) => void doResolve(q, i, accept)}
              onUpdateSuggestion={(i, c, t) => doUpdateSuggestion(q, i, c, t)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/** 题目行三态：待答 / 已答·提炼中 / 已答·候选待确认；跳过与已处理完收起为摘要行；
 *  候选条目支持行内就地编辑（第51轮：铅笔 → 类别 select + 内容输入框，保存写回候选记录） */
function WhoamiItem(props: {
  q: WhoamiQuestionView
  draft: string
  onDraft: (v: string) => void
  onAnswer: () => void
  onSkip: () => void
  extracting: boolean
  extractErr: string
  onRetryExtract: () => void
  onResolve: (index: number, accept: boolean) => void
  onUpdateSuggestion: (index: number, category: string, content: string) => Promise<boolean>
}) {
  const { q } = props
  // 候选就地编辑态（行内局部）：编辑中的候选下标 + 类别/内容草稿
  const [editIdx, setEditIdx] = useState<number | null>(null)
  const [editCat, setEditCat] = useState('')
  const [editText, setEditText] = useState('')
  const saveEdit = async (i: number): Promise<void> => {
    const text = editText.trim()
    if (!text || !editCat) return
    if (await props.onUpdateSuggestion(i, editCat, text)) setEditIdx(null)
  }
  if (q.skipped) {
    return (
      <div className="whoami-item whoami-done">
        <span className="material-symbols-outlined">skip_next</span>
        <span className="whoami-question">已跳过：{q.question}</span>
      </div>
    )
  }
  if (q.answer != null && q.resolved) {
    return (
      <div className="whoami-item whoami-done">
        <span className="material-symbols-outlined">check_circle</span>
        <span className="whoami-question">
          {q.question}　答：{q.answer}
        </span>
      </div>
    )
  }
  return (
    <div className="whoami-item">
      <div className="whoami-question">{q.question}</div>
      {q.answer == null ? (
        <div className="whoami-answer-row">
          <input
            className="whoami-input"
            value={props.draft}
            placeholder="一句话回答…（Enter 提交）"
            onChange={(e) => props.onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') props.onAnswer()
            }}
          />
          <button className="btn btn-primary" disabled={!props.draft.trim()} onClick={props.onAnswer}>
            回答
          </button>
          <button className="btn" onClick={props.onSkip}>
            跳过
          </button>
        </div>
      ) : (
        <>
          <div className="whoami-answer-text">{q.answer}</div>
          {props.extracting && <div className="whoami-extracting">正在提炼画像候选…</div>}
          {!props.extracting && props.extractErr && (
            <div className="whoami-extract-err">
              <span>
                {props.extractErr === 'LLM_NOT_CONFIGURED'
                  ? 'LLM 未配置，无法提炼'
                  : `提炼失败：${props.extractErr}`}
              </span>
              <button className="btn" onClick={props.onRetryExtract}>
                重试
              </button>
            </div>
          )}
          {q.suggestions.map((s, i) =>
            editIdx === i ? (
              <div key={i} className="whoami-suggestion whoami-suggestion-editing">
                <select className="whoami-select" value={editCat} onChange={(e) => setEditCat(e.target.value)}>
                  {PROFILE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <input
                  className="whoami-input"
                  value={editText}
                  placeholder="一句话概括…"
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveEdit(i)
                    else if (e.key === 'Escape') setEditIdx(null)
                  }}
                />
                <span className="whoami-suggestion-actions">
                  <button className="btn btn-primary" disabled={!editText.trim()} onClick={() => void saveEdit(i)}>
                    保存
                  </button>
                  <button className="btn" onClick={() => setEditIdx(null)}>
                    取消
                  </button>
                </span>
              </div>
            ) : (
              <div key={i} className="whoami-suggestion">
                <span className="whoami-cat">{s.category}</span>
                <span className="whoami-suggestion-content">{s.content}</span>
                <span className="whoami-suggestion-actions">
                  <button
                    className="icon-btn"
                    title="编辑此条"
                    onClick={() => {
                      setEditIdx(i)
                      setEditCat(s.category)
                      setEditText(s.content)
                    }}
                  >
                    <span className="material-symbols-outlined">edit</span>
                  </button>
                  <button className="btn btn-primary" onClick={() => props.onResolve(i, true)}>
                    加入画像
                  </button>
                  <button className="btn" onClick={() => props.onResolve(i, false)}>
                    忽略
                  </button>
                </span>
              </div>
            )
          )}
        </>
      )}
    </div>
  )
}
