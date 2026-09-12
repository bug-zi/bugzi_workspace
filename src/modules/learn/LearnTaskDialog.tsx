// 主题实战任务弹窗（学习库 v2.0 升级设计 §三）：任务列表切换 + AI 出新任务 + 写作业提交点评。
// 任务不入回收站（工具性产物，删除级联 md）；作业为表单输入（textarea），不走全局 md 双击惯例。
import { useEffect, useState } from 'react'
import type { LearnTaskRow } from '../../renderer/api'
import MdView from '../../components/MdView'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'

export interface LearnTaskDialogProps {
  topic: { id: number; title: string }
  onClose: () => void
}

const STATUS_LABEL: Record<string, string> = { todo: '待完成', submitted: '点评中', reviewed: '已点评' }

export default function LearnTaskDialog(props: LearnTaskDialogProps) {
  const { toast } = useToast()
  const [tasks, setTasks] = useState<LearnTaskRow[]>([])
  const [current, setCurrent] = useState<LearnTaskRow | null>(null)
  const [taskMd, setTaskMd] = useState('')
  const [homework, setHomework] = useState('')
  const [reviewMd, setReviewMd] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [genConfirmOpen, setGenConfirmOpen] = useState(false)
  const [delTarget, setDelTarget] = useState<LearnTaskRow | null>(null)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const [goConfig, setGoConfig] = useState(false)

  const handleAiError = (e: unknown): void => {
    const msg = String((e as Error).message)
    if (msg.includes('已取消')) toast('已取消')
    else if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
    else setFailMsg(msg)
  }

  /** 选中任务：读任务 md + 既有作业 + 点评 */
  const loadDetail = async (t: LearnTaskRow): Promise<void> => {
    setCurrent(t)
    setTaskMd('')
    setReviewMd('')
    try {
      setTaskMd(await window.api.md.read(t.task_md))
    } catch {
      setTaskMd('（任务内容读取失败）')
    }
    if (t.homework_md) {
      try {
        setHomework(await window.api.md.read(t.homework_md))
      } catch {
        setHomework('')
      }
    } else {
      setHomework('')
    }
    if (t.review_md) {
      try {
        setReviewMd(await window.api.md.read(t.review_md))
      } catch {
        setReviewMd('')
      }
    }
  }

  useEffect(() => {
    void window.api.learn
      .taskList(props.topic.id)
      .then((list) => {
        setTasks(list)
        if (list[0]) void loadDetail(list[0])
      })
      .finally(() => setLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.topic.id])

  const generate = async (): Promise<void> => {
    if (generating) return
    setGenerating(true)
    try {
      const t = await window.api.learn.taskGenerate(crypto.randomUUID(), props.topic.id)
      setTasks((arr) => [t, ...arr])
      await loadDetail(t)
      toast('实战任务已生成')
    } catch (e) {
      handleAiError(e)
    } finally {
      setGenerating(false)
    }
  }

  const requestGenerate = (): void => {
    // 有未点评完的任务先确认（旧任务保留不删，仅提醒）
    if (tasks.some((t) => t.status !== 'reviewed')) setGenConfirmOpen(true)
    else void generate()
  }

  const submit = async (): Promise<void> => {
    if (!current || submitting) return
    setSubmitting(true)
    try {
      const t = await window.api.learn.taskSubmit(crypto.randomUUID(), current.id, homework)
      setTasks((arr) => arr.map((x) => (x.id === t.id ? t : x)))
      setCurrent(t)
      if (t.review_md) {
        try {
          setReviewMd(await window.api.md.read(t.review_md))
        } catch {
          setReviewMd('')
        }
      }
      toast(`批改完成：${t.score ?? '?'} 分`)
    } catch (e) {
      handleAiError(e)
    } finally {
      setSubmitting(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!delTarget) return
    await window.api.learn.taskDelete(delTarget.id)
    const rest = tasks.filter((t) => t.id !== delTarget.id)
    setTasks(rest)
    setDelTarget(null)
    if (current?.id === delTarget.id) {
      setCurrent(null)
      setTaskMd('')
      setHomework('')
      setReviewMd('')
      if (rest[0]) void loadDetail(rest[0])
    }
    toast('任务已删除')
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !generating && !submitting && props.onClose()}
    >
      <div className="dialog" style={{ width: 680, maxHeight: '86vh', display: 'flex', flexDirection: 'column' }}>
        <div className="dialog-header">实战任务 · {props.topic.title}</div>
        <div className="dialog-body" style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              className="field"
              style={{ flex: 1, width: 'auto' }}
              value={current?.id ?? ''}
              onChange={(e) => {
                const t = tasks.find((x) => x.id === Number(e.target.value))
                if (t) void loadDetail(t)
              }}
            >
              {tasks.length === 0 && <option value="">暂无任务</option>}
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  任务 #{t.id} · {STATUS_LABEL[t.status] ?? t.status}
                  {t.score != null ? ` · ${t.score} 分` : ''}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" disabled={generating} onClick={requestGenerate}>
              <span className={`material-symbols-outlined${generating ? ' spin' : ''}`}>
                {generating ? 'progress_activity' : 'auto_awesome'}
              </span>
              {generating ? '出题中…' : 'AI 出新任务'}
            </button>
            {current && (
              <button
                className="icon-btn danger"
                title="删除此任务（彻底删除，不入回收站）"
                onClick={() => setDelTarget(current)}
              >
                <span className="material-symbols-outlined">delete</span>
              </button>
            )}
          </div>

          {!loaded && <div className="module-sub">加载中…</div>}
          {loaded && current == null && (
            <div className="empty-state">
              <span className="material-symbols-outlined">construction</span>
              还没有实战任务：点「AI 出新任务」，结合本主题知识点出 30 分钟小任务
            </div>
          )}

          {current && (
            <>
              <div className="card" style={{ padding: 12 }}>
                <MdView md={taskMd} />
              </div>
              {current.status === 'reviewed' ? (
                <div className="card" style={{ padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="material-symbols-outlined quiz-right-icon">verified</span>
                    <strong>点评 · {current.score ?? '?'} 分</strong>
                  </div>
                  <MdView md={reviewMd} className="quiz-question" />
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <textarea
                    className="field"
                    style={{ minHeight: 140, resize: 'vertical' }}
                    placeholder="在这里完成作业（命令输出 / 代码 / 操作记录 / 心得均可），写完点「提交点评」"
                    value={homework}
                    disabled={submitting}
                    onChange={(e) => setHomework(e.target.value)}
                  />
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      className="btn btn-primary"
                      disabled={submitting || !homework.trim()}
                      onClick={() => void submit()}
                    >
                      <span className={`material-symbols-outlined${submitting ? ' spin' : ''}`}>
                        {submitting ? 'progress_activity' : 'send'}
                      </span>
                      {submitting ? '批改中…' : '提交点评'}
                    </button>
                    {current.status === 'submitted' && (
                      <span className="module-sub">上次提交未完成批改（如中途退出），可重新提交</span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={genConfirmOpen}
        title="出新任务"
        confirmText="仍然生成"
        onConfirm={() => {
          setGenConfirmOpen(false)
          void generate()
        }}
        onCancel={() => setGenConfirmOpen(false)}
      >
        本主题还有未完成点评的任务（旧任务会保留在列表里，不会丢失）。确定要再生成一个新任务吗？
      </ConfirmDialog>
      <ConfirmDialog
        open={delTarget != null}
        title="删除任务"
        confirmText="删除"
        danger
        onConfirm={() => void remove()}
        onCancel={() => setDelTarget(null)}
      >
        任务描述、作业与点评将一并彻底删除（不入回收站），确定删除？
      </ConfirmDialog>
      <GoConfigDialog open={goConfig} kind="llm" onGoConfig={() => setGoConfig(false)} onCancel={() => setGoConfig(false)} />
      {failMsg && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setFailMsg(null)}>
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-header">操作失败</div>
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
