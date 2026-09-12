// 十二问题面板（致知己·十二问题 tab，2026-09-12 设计 §四）：费曼式自定义 ≤12 题 +
// 每题多条带日期想法流（倒序）+ 可选问 AI（右栏追问频道，较真的朋友只帮想透不代笔）
import { useCallback, useEffect, useState } from 'react'
import type { AiChannel, TwelveQuestion, TwelveThought } from '../../renderer/api'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import MdView from '../../components/MdView'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

export interface TwelvePanelProps {
  onOpenAi: (prefill?: string, opts?: { auto?: boolean; channel?: AiChannel }) => void
  onNavigateToProfile: () => void
}

const MAX_QUESTIONS = 12

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function TwelvePanel(props: TwelvePanelProps) {
  const { toast } = useToast()
  const [questions, setQuestions] = useState<TwelveQuestion[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const [thoughts, setThoughts] = useState<TwelveThought[]>([])
  const [draft, setDraft] = useState('')
  // 新问题
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  // 删除（题目进回收站 / 单条想法彻底删）
  const [delQ, setDelQ] = useState<TwelveQuestion | null>(null)
  const [delT, setDelT] = useState<TwelveThought | null>(null)
  const [goConfig, setGoConfig] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setQuestions(await window.api.twelve.list())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useModuleActivated('zhijiji', () => void load())

  const openThoughts = async (id: number): Promise<void> => {
    if (id === openId) {
      setOpenId(null)
      setThoughts([])
      return
    }
    setOpenId(id)
    setDraft('')
    setThoughts(await window.api.twelve.thoughts(id))
  }

  const addThought = async (): Promise<void> => {
    const t = draft.trim()
    if (!t || openId == null) return
    const th = (await window.api.twelve.addThought(openId, t)) as TwelveThought
    setDraft('')
    setThoughts((arr) => [th, ...arr])
    await load()
  }

  const askAi = async (q: TwelveQuestion): Promise<void> => {
    if (!(await window.api.ai.configured())) {
      setGoConfig(true)
      return
    }
    const ts = await window.api.twelve.thoughts(q.id)
    const recent = ts
      .slice(0, 5)
      .map((t) => `- ${t.content}`)
      .join('\n')
    const prefill = `请就我的这个开放性问题发起追问（帮我把想法想透，只提问不代笔）：\n\n【问题】${q.title}\n【我的最近想法】\n${recent || '（还没写过想法）'}`
    props.onOpenAi(prefill, { channel: 'zhijiji', auto: true })
  }

  const doCreate = async (): Promise<void> => {
    const t = title.trim()
    if (!t) {
      toast('请填写问题')
      return
    }
    try {
      await window.api.twelve.createQuestion(t)
      setAdding(false)
      setTitle('')
      await load()
    } catch (e) {
      const msg = String((e as Error).message)
      toast(msg.includes('TWELVE_FULL') ? '十二问题已满（12 题），先删一题再添加' : `创建失败：${msg.slice(0, 80)}`)
    }
  }

  const doDiscardQ = async (): Promise<void> => {
    if (!delQ) return
    await window.api.twelve.discardQuestion(delQ.id)
    toast('已放入回收站')
    if (openId === delQ.id) {
      setOpenId(null)
      setThoughts([])
    }
    setDelQ(null)
    await load()
  }

  const doDeleteT = async (): Promise<void> => {
    if (!delT) return
    await window.api.twelve.deleteThought(delT.id)
    toast('已删除该想法')
    setDelT(null)
    if (openId != null) setThoughts(await window.api.twelve.thoughts(openId))
    await load()
  }

  const full = questions.length >= MAX_QUESTIONS

  return (
    <>
      <section className="zone">
        <div className="zone-header">
          <span>我的十二问题</span>
          <span className="zone-count">{questions.length}/12</span>
          <button
            className="btn"
            style={{ marginLeft: 'auto' }}
            disabled={full}
            title={full ? '十二问题已满，先删一题再添加' : '新增一个开放性问题'}
            onClick={() => setAdding(true)}
          >
            <span className="material-symbols-outlined">add</span>
            新问题
          </button>
        </div>
        <div className="zone-body">
          {questions.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">tag</span>
              还没有问题。写下 12 个你最关心的开放性问题，平时有想法就记下来
            </div>
          )}
          {questions.map((q) => (
            <div key={q.id}>
              <div className="row-item" onClick={() => void openThoughts(q.id)} title="点击展开/收起想法流">
                <div className="row-main">
                  <div className="row-title">{q.title}</div>
                  <div className="row-sub">
                    {q.thought_count} 条想法{q.last_thought_at ? ` ｜ 最近 ${fmtTime(q.last_thought_at)}` : ''}
                  </div>
                </div>
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="icon-btn"
                    title="问 AI（右栏追问频道，AI 只帮想透不代笔）"
                    onClick={() => void askAi(q)}
                  >
                    <span className="material-symbols-outlined">contact_support</span>
                  </button>
                  <button
                    className="icon-btn danger"
                    title="删除（进回收站，想法一并封存）"
                    onClick={() => setDelQ(q)}
                  >
                    <span className="material-symbols-outlined">delete</span>
                  </button>
                </div>
              </div>
              {openId === q.id && (
                <div className="zj-twelve-thoughts">
                  {thoughts.length === 0 && <div className="module-sub">还没有想法，在下方写下第一条</div>}
                  {thoughts.map((t) => (
                    <div className="zj-twelve-thought" key={t.id}>
                      <div className="zj-twelve-thought-head">
                        <span className="zj-twelve-thought-time">{fmtTime(t.created_at)}</span>
                        <button className="icon-btn danger" title="删除该想法" onClick={() => setDelT(t)}>
                          <span className="material-symbols-outlined">delete</span>
                        </button>
                      </div>
                      <MdView md={t.content} />
                    </div>
                  ))}
                  <textarea
                    className="field"
                    rows={2}
                    placeholder="记下此刻的想法…（Enter 保存，Shift+Enter 换行）"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void addThought()
                      }
                    }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 新问题弹窗 */}
      {adding && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAdding(false)}>
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-header">新问题</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                className="field"
                placeholder="开放性问题（如：我该怎样学习最高效？）"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void doCreate()}
                autoFocus
              />
              <div className="module-sub">最多 12 题；平时有想法就点开题目记一条，日积月累看见自己的认知变化</div>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAdding(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void doCreate()} disabled={!title.trim()}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删题二次确认（全局规则；进回收站可恢复） */}
      <ConfirmDialog
        open={delQ != null}
        title="删除问题"
        confirmText="删除"
        danger
        onConfirm={() => void doDiscardQ()}
        onCancel={() => setDelQ(null)}
      >
        将删除问题「{delQ?.title}」并放入回收站（全部想法一并封存，3 天后彻底删除）。
      </ConfirmDialog>

      {/* 删想法二次确认（全局规则；碎片数据彻底删不入回收站，同信息源惯例） */}
      <ConfirmDialog
        open={delT != null}
        title="删除想法"
        confirmText="删除"
        danger
        onConfirm={() => void doDeleteT()}
        onCancel={() => setDelT(null)}
      >
        将彻底删除这条想法，删除后不可恢复（不入回收站）。
      </ConfirmDialog>

      {/* LLM 未配置引导（全局规则） */}
      <GoConfigDialog
        open={goConfig}
        kind="llm"
        onGoConfig={() => {
          setGoConfig(false)
          props.onNavigateToProfile()
        }}
        onCancel={() => setGoConfig(false)}
      />
    </>
  )
}
