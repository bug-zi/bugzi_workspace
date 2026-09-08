// 思维墙·题库（v1.2 双层题源第二层；260909 由「精选题库」改名并收入练习场生成题）：
// 人工策展存量难题 + 练习场 AI 生成题同表（source 区分），AI 只判答不出题。
// 策展题面随 DB v13 种子入库；作答 / 看解答均为终态（todo → solved / failed，不可重做）；
// 局终写详情 md（题面/作答/判定/标准答案/讲解/标准论证），点行回看。
import { useCallback, useEffect, useState } from 'react'
import type { WallBankInfo, WallBankRow } from '../../renderer/api'
import MdDialog from '../../components/MdDialog'
import MdView from '../../components/MdView'
import GoConfigDialog from '../../components/GoConfigDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

const STATUS_ZH: Record<string, string> = {
  todo: '未做',
  solved: '已破',
  failed: '未破'
}

export default function BankPanel() {
  const { toast } = useToast()
  const [rows, setRows] = useState<WallBankRow[]>([])
  const [current, setCurrent] = useState<WallBankInfo | null>(null)
  const [answering, setAnswering] = useState('')
  const [submitJob, setSubmitJob] = useState<string | null>(null)
  const submitting = submitJob != null
  /** 终局后的一次性结果呈现（判答讲解 / 看解答的标准论证） */
  const [reveal, setReveal] = useState<{ correct: boolean; standardAnswer: string; text: string } | null>(
    null
  )
  const [revealTarget, setRevealTarget] = useState<WallBankInfo | null>(null)
  const [recordDoc, setRecordDoc] = useState<{ title: string; subtitle: string; path: string } | null>(
    null
  )
  const [goConfig, setGoConfig] = useState(false)
  const [failMsg, setFailMsg] = useState<string | null>(null)

  const handleErr = (e: unknown): void => {
    const msg = String((e as Error).message)
    if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
    else setFailMsg(msg)
  }

  const loadList = useCallback(async () => {
    try {
      setRows(await window.api.wall.bankList())
    } catch {
      /* 列表失败不打断界面 */
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])
  // keep-alive：切回推理角刷新列表（他处作答后状态同步）
  useModuleActivated('reasoning', () => void loadList())

  const open = async (id: number): Promise<void> => {
    try {
      const info = await window.api.wall.bankOpen(id)
      setCurrent(info)
      setReveal(null)
      setAnswering('')
    } catch (e) {
      handleErr(e)
    }
  }

  const submit = async (): Promise<void> => {
    const a = answering.trim()
    if (!a || !current || submitting) return
    const jobId = crypto.randomUUID()
    setSubmitJob(jobId)
    try {
      const r = await window.api.wall.bankAnswer(jobId, current.id, a)
      toast(r.correct ? '已破！讲解在下方' : '未破，讲解与标准论证在下方')
      setReveal({ correct: r.correct, standardAnswer: r.standardAnswer, text: r.explanation })
      setCurrent((prev) =>
        prev && { ...prev, status: r.correct ? ('solved' as const) : ('failed' as const), myAnswer: a, mdPath: r.mdPath }
      )
      await loadList()
    } catch (e) {
      // 取消：判答未落库，todo 态保留可重交
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else handleErr(e)
    } finally {
      setSubmitJob(null)
    }
  }

  const doReveal = async (): Promise<void> => {
    const target = revealTarget
    if (!target) return
    setRevealTarget(null)
    try {
      const r = await window.api.wall.bankReveal(target.id)
      toast('已揭示标准解答')
      if (current?.id === target.id) {
        setReveal({ correct: false, standardAnswer: r.standardAnswer, text: r.solution })
        setCurrent((prev) => prev && { ...prev, status: 'failed' as const, mdPath: r.mdPath })
      }
      await loadList()
    } catch (e) {
      handleErr(e)
    }
  }

  const solved = rows.filter((r) => r.status === 'solved').length

  return (
    <>
      <div className="zone">
        <div className="zone-header" style={{ cursor: 'default' }}>
          <span className="material-symbols-outlined">workspace_premium</span>
          <span>题库</span>
          <span className="zone-count">
            已破 {solved} / {rows.length}
          </span>
          <span className="module-sub" style={{ marginLeft: 'auto' }}>
            策展难题 · 练习场生成题自动入库 · 一题一命
          </span>
        </div>
        <div className="zone-body">
          {/* 题目列表：状态 + 标题 + 标签 + 难度 + 出处 */}
          <div className="bank-list">
            {rows.map((r) => (
              <div
                key={r.id}
                className={`bank-row${r.status === 'solved' ? ' solved' : ''}${
                  r.status === 'failed' ? ' failed' : ''
                }${current?.id === r.id ? ' current' : ''}`}
                onClick={() => void open(r.id)}
                title={r.source}
              >
                <span className="material-symbols-outlined bank-status">
                  {r.status === 'solved' ? 'task_alt' : r.status === 'failed' ? 'close' : 'help'}
                </span>
                <span className="bank-title">{r.title}</span>
                <span className="badge">{r.tag}</span>
                <span className={`badge${r.difficulty === 'hard' ? ' primary' : ''}`}>{r.diffZh}</span>
                <span className="module-sub">{STATUS_ZH[r.status]}</span>
              </div>
            ))}
          </div>

          {/* 当前题：作答（todo）或结果回看（终态） */}
          {current && (
            <div className="card quiz-card">
              <div className="quiz-meta">
                {current.title} · {current.tag} · {current.diffZh}难度 · {current.status === 'todo' ? '作答中' : STATUS_ZH[current.status]}
              </div>
              <MdView md={current.puzzle} className="quiz-question" />
              {current.status === 'todo' && !reveal && (
                <>
                  <textarea
                    className="field"
                    rows={3}
                    placeholder="写下你的结论与论证（结论正确即算对，表述不同但等价也算；附带论证会获得点评）…"
                    value={answering}
                    onChange={(e) => setAnswering(e.target.value)}
                  />
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <button
                      className="btn btn-primary"
                      disabled={!answering.trim() || submitting}
                      onClick={() => void submit()}
                    >
                      {submitting ? '判定中…' : '提交作答'}
                    </button>
                    {submitJob && (
                      <button
                        className="btn"
                        onClick={() => void window.api.ai.cancel(submitJob)}
                        title="取消本次判答"
                      >
                        <span className="material-symbols-outlined">stop_circle</span>
                        取消
                      </button>
                    )}
                    <button className="btn" onClick={() => setRevealTarget(current)}>
                      <span className="material-symbols-outlined">visibility</span>
                      看解答
                    </button>
                    <span className="module-sub">一题一命：提交或看解答后不可重做</span>
                  </div>
                </>
              )}
              {current.status === 'todo' && reveal && (
                <>
                  <div className={`rs-result${reveal.correct ? '' : ' wrong'}`}>
                    {reveal.correct ? '已破' : '未破'}
                  </div>
                  <div className="module-sub">标准答案：{reveal.standardAnswer}</div>
                  <MdView md={reveal.text} className="rs-explain" />
                  {current.mdPath && (
                    <div>
                      <button
                        className="btn"
                        onClick={() => {
                          const p = current.mdPath
                          if (!p) return
                          setRecordDoc({
                            title: current.title,
                            subtitle: `${current.tag} · ${current.diffZh} · ${STATUS_ZH[current.status] ?? current.status}`,
                            path: p
                          })
                        }}
                      >
                        <span className="material-symbols-outlined">description</span>
                        查看完整档案
                      </button>
                    </div>
                  )}
                </>
              )}
              {current.status !== 'todo' && (
                <>
                  <div className={`rs-result${current.status === 'solved' ? '' : ' wrong'}`}>
                    {current.status === 'solved' ? '已破' : '未破'}
                  </div>
                  {current.myAnswer && (
                    <div className="module-sub" style={{ whiteSpace: 'pre-wrap' }}>
                      我的作答：{current.myAnswer}
                    </div>
                  )}
                  {current.mdPath && (
                    <div>
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          const p = current.mdPath
                          if (!p) return
                          setRecordDoc({
                            title: current.title,
                            subtitle: `${current.tag} · ${current.diffZh} · ${STATUS_ZH[current.status] ?? current.status}`,
                            path: p
                          })
                        }}
                      >
                        <span className="material-symbols-outlined">description</span>
                        查看完整档案
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 看解答二次确认（全局规则：终态操作必须确认） */}
      <ConfirmDialog
        open={revealTarget != null}
        title="看解答"
        confirmText="看解答"
        onConfirm={() => void doReveal()}
        onCancel={() => setRevealTarget(null)}
      >
        {`确定直接看《${revealTarget?.title ?? ''}》的标准解答？看后本题记为「未破」，不可再作答。`}
      </ConfirmDialog>

      {/* 完整档案（全局 md 弹窗） */}
      <MdDialog
        key={recordDoc?.path ?? 'none'}
        open={recordDoc != null}
        title={recordDoc?.title ?? ''}
        subtitle={recordDoc?.subtitle}
        filePath={recordDoc?.path ?? ''}
        onClose={() => setRecordDoc(null)}
      />

      {/* LLM 未配置（全局规则 8） */}
      <GoConfigDialog
        open={goConfig}
        kind="llm"
        onGoConfig={() => setGoConfig(false)}
        onCancel={() => setGoConfig(false)}
      />

      {/* 调用失败 */}
      {failMsg && (
        <div
          className="dialog-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && setFailMsg(null)}
        >
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-header">出错了</div>
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
    </>
  )
}
