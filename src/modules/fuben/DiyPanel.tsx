// DIY 定制页签（specs §2 DiyPanel）：方向 → AI 出 4 道问答 → 全答后生成专属副本（两步式）。
// 生成中可取消（AbortSignal 贯穿，取消不落库）；主进程单飞，重复触发抛 COPY_DIY_BUSY。
import { useEffect, useRef, useState } from 'react'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'
import type { CopyDiyProgress } from '../../shared/types'

type Step = 'direction' | 'questions' | 'generating'

export default function DiyPanel(props: { onRead: (id: number) => void }) {
  const { onRead } = props
  const { toast } = useToast()
  const [step, setStep] = useState<Step>('direction')
  const [direction, setDirection] = useState('')
  const [questions, setQuestions] = useState<string[]>([])
  const [answers, setAnswers] = useState<string[]>(['', '', '', ''])
  const [progress, setProgress] = useState<CopyDiyProgress | null>(null)
  const [asking, setAsking] = useState(false)
  const [goConfig, setGoConfig] = useState(false)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  // 取消通道与 jobId 记录（重进页签恢复进度态用——keep-alive 下 state 常驻，实际不丢）
  const jobIdRef = useRef<string | null>(null)

  useEffect(() => {
    const off = window.api.copy.onDiyProgress((p) => setProgress(p))
    return off
  }, [])

  const handleErr = (e: unknown): void => {
    const msg = String((e as Error).message)
    if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
    else if (msg.includes('已取消')) toast('已取消')
    else if (msg.includes('COPY_DIY_BUSY')) toast('已有定制任务进行中')
    else {
      setFailMsg(msg)
      toast('生成失败：' + msg)
    }
  }

  const genQuestions = async (): Promise<void> => {
    if (direction.trim() === '') {
      toast('先写下你想体验的人生方向')
      return
    }
    if (asking) return
    setAsking(true)
    const jobId = crypto.randomUUID()
    jobIdRef.current = jobId
    try {
      const r = await window.api.copy.diyQuestions(jobId, direction.trim())
      setQuestions(r.questions)
      setAnswers(['', '', '', ''])
      setStep('questions')
    } catch (e) {
      handleErr(e)
    } finally {
      setAsking(false)
    }
  }

  const generate = async (): Promise<void> => {
    const jobId = crypto.randomUUID()
    jobIdRef.current = jobId
    setProgress({ step: 'outline', current: 0, total: 0 })
    setStep('generating')
    try {
      const detail = await window.api.copy.diyGenerate(jobId, direction.trim(), answers.map((a) => a.trim()))
      toast('专属副本已生成')
      onRead(detail.id)
    } catch (e) {
      handleErr(e)
      setStep('questions')
    } finally {
      setProgress(null)
    }
  }

  const cancel = async (): Promise<void> => {
    if (jobIdRef.current) void window.api.ai.cancel(jobIdRef.current)
  }

  const allAnswered = answers.every((a) => a.trim() !== '')

  return (
    <div className="fuben-diy">
      {step === 'direction' && (
        <>
          <div className="fuben-diy-label">你想体验一段什么样的人生？</div>
          <textarea
            className="fuben-textarea"
            rows={3}
            placeholder="例如：我想体验 90 年代县城开音像店的人生"
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
          />
          <button className="fuben-btn" disabled={asking} onClick={() => void genQuestions()}>
            {asking ? '生成定制问题中…' : '生成定制问题'}
          </button>
          {asking && <div className="fuben-diy-hint">AI 正在根据你的方向构思问题，约需十几秒；请稍候</div>}
        </>
      )}

      {step === 'questions' && (
        <>
          <div className="fuben-diy-label">回答这四道问题，让这段人生长成你的形状（每题都答才能生成）</div>
          {questions.map((q, i) => (
            <div key={i} className="fuben-q-item">
              <div className="fuben-q-text">
                {i + 1}. {q}
              </div>
              <textarea
                className="fuben-textarea"
                rows={2}
                value={answers[i]}
                onChange={(e) => setAnswers((a) => a.map((v, k) => (k === i ? e.target.value : v)))}
              />
            </div>
          ))}
          <div className="fuben-diy-actions">
            <button className="fuben-btn" disabled={!allAnswered} onClick={() => void generate()}>
              生成我的副本
            </button>
            <button
              className="fuben-btn-ghost"
              onClick={() => {
                setStep('direction')
                setQuestions([])
              }}
            >
              重新生成问题
            </button>
          </div>
          {!allAnswered && <div className="fuben-diy-hint">还有 {answers.filter((a) => a.trim() === '').length} 题未作答</div>}
        </>
      )}

      {step === 'generating' && (
        <div className="fuben-diy-generating">
          <span className="material-symbols-outlined fuben-spin">progress_activity</span>
          <div className="fuben-diy-progress-text">
            {progress?.step === 'section'
              ? `撰写第 ${progress.current}/${progress.total || '?'} 段…`
              : '构思大纲…'}
          </div>
          <div className="fuben-diy-hint">一段人生正在展开，通常需要一两分钟；切到别的模块不会中断</div>
          <button className="fuben-btn-ghost" onClick={() => void cancel()}>
            取消
          </button>
        </div>
      )}

      {failMsg && <div className="fuben-fail">生成失败：{failMsg}</div>}
      <GoConfigDialog open={goConfig} kind="llm" onGoConfig={() => setGoConfig(false)} onCancel={() => setGoConfig(false)} />
    </div>
  )
}
