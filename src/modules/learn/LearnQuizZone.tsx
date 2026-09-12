// 今日小测（学习库 v2.0 升级设计 §二）：一天一卷，逐题作答实时存库；交卷时选择/填空本地判、
// 简答 AI 批改。答错节点经 onWrongChange 上抛 LearnModule 做行内标记；本组件不回写复习状态机（检验不惩罚）。
import { useEffect, useState } from 'react'
import type { LearnQuizView } from '../../renderer/api'
import MdView from '../../components/MdView'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'

export interface LearnQuizZoneProps {
  /** 今日新学中已学会张数（<2 不可出卷） */
  learnedCount: number
  /** 卷状态变化时上抛答错节点 id 集合（LearnModule 行内标记用） */
  onWrongChange: (ids: Set<number>) => void
}

export default function LearnQuizZone(props: LearnQuizZoneProps) {
  const { toast } = useToast()
  const [quiz, setQuiz] = useState<LearnQuizView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [retryOpen, setRetryOpen] = useState(false)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const [goConfig, setGoConfig] = useState(false)

  const handleAiError = (e: unknown): void => {
    const msg = String((e as Error).message)
    if (msg.includes('已取消')) toast('已取消')
    else if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
    else setFailMsg(msg)
  }

  const pushWrong = (q: LearnQuizView | null): void => {
    const ids = new Set<number>()
    if (q && q.status === 'graded') {
      for (const a of q.answers) {
        if (a.correct === false) {
          const node = q.questions[a.qIndex]?.nodeId
          if (node != null) ids.add(node)
        }
      }
    }
    props.onWrongChange(ids)
  }

  useEffect(() => {
    void window.api.learn
      .quizGet()
      .then((q) => {
        setQuiz(q)
        if (q && q.status === 'answering') {
          const d: Record<number, string> = {}
          for (const a of q.answers) d[a.qIndex] = a.answer
          setDrafts(d)
        }
        pushWrong(q)
      })
      .finally(() => setLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const create = async (force = false): Promise<void> => {
    if (creating) return
    setCreating(true)
    try {
      const q = await window.api.learn.quizCreate(crypto.randomUUID(), force)
      setQuiz(q)
    } catch (e) {
      handleAiError(e)
    } finally {
      setCreating(false)
    }
  }

  const answer = async (qIndex: number, value: string): Promise<void> => {
    setDrafts((d) => ({ ...d, [qIndex]: value }))
    try {
      const correct = await window.api.learn.quizAnswer(qIndex, value)
      setQuiz((q) => {
        if (!q) return q
        const answers = q.answers.filter((a) => a.qIndex !== qIndex)
        answers.push({ qIndex, answer: value, correct })
        return { ...q, answers }
      })
    } catch {
      toast('作答保存失败')
    }
  }

  const submit = async (): Promise<void> => {
    if (!quiz || submitting) return
    setSubmitting(true)
    try {
      const r = await window.api.learn.quizSubmit(crypto.randomUUID())
      const fresh = await window.api.learn.quizGet()
      setQuiz(fresh)
      pushWrong(fresh)
      toast(`小测完成：答对 ${r.correct}/${r.total}`)
    } catch (e) {
      handleAiError(e)
    } finally {
      setSubmitting(false)
    }
  }

  const retry = async (): Promise<void> => {
    try {
      const q = await window.api.learn.quizRetry()
      setQuiz(q)
      setDrafts({})
      pushWrong(q)
    } catch (e) {
      handleAiError(e)
    }
  }

  const answeredCount = quiz?.answers.length ?? 0
  const totalCount = quiz?.questions.length ?? 0

  return (
    <div className="zone">
      <div className="zone-header" style={{ cursor: 'default' }}>
        <span className="material-symbols-outlined">quiz</span>
        <span>今日小测</span>
        <span className="zone-count">
          {quiz
            ? quiz.status === 'graded'
              ? `答对 ${quiz.answers.filter((a) => a.correct === true).length}/${totalCount}`
              : `${answeredCount}/${totalCount} 已答`
            : '未出卷'}
        </span>
        <div className="row-actions" style={{ marginLeft: 'auto' }}>
          {quiz == null && (
            <button
              className="btn btn-primary"
              disabled={creating || props.learnedCount < 2}
              title={props.learnedCount < 2 ? '今日新学需先学会至少 2 张才能小测' : '基于今日已学的卡出卷'}
              onClick={() => void create()}
            >
              <span className={`material-symbols-outlined${creating ? ' spin' : ''}`}>
                {creating ? 'progress_activity' : 'quiz'}
              </span>
              {creating ? '出卷中…' : '小测一下'}
            </button>
          )}
          {quiz?.status === 'answering' && (
            <button
              className="btn btn-primary"
              disabled={submitting || answeredCount < totalCount}
              title={answeredCount < totalCount ? `还有 ${totalCount - answeredCount} 题未作答` : '交卷判分'}
              onClick={() => void submit()}
            >
              <span className={`material-symbols-outlined${submitting ? ' spin' : ''}`}>
                {submitting ? 'progress_activity' : 'fact_check'}
              </span>
              {submitting ? '批改中…' : '交卷'}
            </button>
          )}
          {quiz?.status === 'graded' && (
            <>
              <button className="btn" onClick={() => setRetryOpen(true)} title="清空作答重答同一卷">
                <span className="material-symbols-outlined">replay</span>
                重做
              </button>
              <button
                className="btn"
                disabled={creating}
                title="基于今日已学卡重新出一张卷（覆盖今日卷）"
                onClick={() => void create(true)}
              >
                <span className={`material-symbols-outlined${creating ? ' spin' : ''}`}>refresh</span>
                换一张
              </button>
            </>
          )}
        </div>
      </div>
      <div className="zone-body">
        {!loaded && <div className="empty-state">加载中…</div>}
        {loaded && quiz == null && (
          <div className="empty-state">
            <span className="material-symbols-outlined">quiz</span>
            {props.learnedCount < 2
              ? '今日新学学会至少 2 张后，可在这里小测检验'
              : '今日已学卡就绪，点「小测一下」检验掌握程度'}
          </div>
        )}
        {quiz?.questions.map((q, i) => {
          const a = quiz.answers.find((x) => x.qIndex === i)
          const graded = quiz.status === 'graded'
          return (
            <div className="card" key={i} style={{ padding: 12, marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {graded && (
                  <span
                    className={`material-symbols-outlined ${a?.correct === false ? 'quiz-wrong-icon' : 'quiz-right-icon'}`}
                    title={a?.correct === false ? '答错' : '答对'}
                  >
                    {a?.correct === false ? 'cancel' : 'task_alt'}
                  </span>
                )}
                <strong>
                  第 {i + 1} 题 · {q.type === 'choice' ? '单选' : q.type === 'blank' ? '填空' : '简答'}
                  {q.nodeTitle ? ` · ${q.nodeTitle}` : ''}
                </strong>
                {!graded && a && <span className="module-sub">已作答</span>}
              </div>
              <MdView md={q.question} className="quiz-question" />
              {q.type === 'choice' && (
                <div>
                  {(q.options ?? []).map((opt, oi) => (
                    <button
                      key={oi}
                      className={`quiz-option${drafts[i] === String(oi) ? ' selected' : ''}`}
                      disabled={graded}
                      onClick={() => void answer(i, String(oi))}
                    >
                      {String.fromCharCode(65 + oi)}. {opt}
                    </button>
                  ))}
                </div>
              )}
              {q.type === 'blank' && (
                <input
                  className="field"
                  style={{ marginTop: 8 }}
                  placeholder="填写答案（回车确认）"
                  disabled={graded}
                  value={drafts[i] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [i]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void answer(i, (e.target as HTMLInputElement).value)
                  }}
                  onBlur={(e) => {
                    if (e.target.value) void answer(i, e.target.value)
                  }}
                />
              )}
              {q.type === 'short' && (
                <textarea
                  className="field"
                  style={{ marginTop: 8, minHeight: 72, resize: 'vertical' }}
                  placeholder="用自己的话作答（失焦自动保存，交卷后 AI 批改）"
                  disabled={graded}
                  value={drafts[i] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [i]: e.target.value }))}
                  onBlur={(e) => {
                    if (e.target.value.trim()) void answer(i, e.target.value)
                  }}
                />
              )}
              {graded && (
                <div className="module-sub" style={{ marginTop: 8, lineHeight: 1.7 }}>
                  <div>你的答案：{a?.answer || '（未作答）'}</div>
                  {q.type === 'choice' && q.options && q.answerIndex != null && (
                    <div>
                      正确答案：{String.fromCharCode(65 + q.answerIndex)}. {q.options[q.answerIndex]}
                    </div>
                  )}
                  {q.type !== 'choice' && <div>参考答案：{q.answer}</div>}
                  {a?.correct === false && q.type === 'short' && a.aiComment && <div>AI 点评：{a.aiComment}</div>}
                  {q.analysis && <div>解析：{q.analysis}</div>}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <ConfirmDialog
        open={retryOpen}
        title="重做小测"
        confirmText="清空重做"
        danger
        onConfirm={() => {
          setRetryOpen(false)
          void retry()
        }}
        onCancel={() => setRetryOpen(false)}
      >
        将清空本卷全部作答回到未答状态（题目不变），确定重做？
      </ConfirmDialog>
      <GoConfigDialog open={goConfig} kind="llm" onGoConfig={() => setGoConfig(false)} onCancel={() => setGoConfig(false)} />
      {failMsg && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setFailMsg(null)}>
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-header">出卷失败</div>
            <div className="dialog-body" style={{ lineHeight: 1.7, wordBreak: 'break-all' }}>
              {failMsg}
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setFailMsg(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
