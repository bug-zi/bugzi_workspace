// 格言「AI 打磨」弹窗（2026-10-01-格言AI打磨-design.md）：输入建议 → AI 改写 → 审核三选
import { useEffect, useRef, useState } from 'react'
import type { MottoRecord } from '../../renderer/api'
import ConfirmDialog from '../../components/ConfirmDialog'

type Phase = 'input' | 'running' | 'result'

export interface MottoPolishDialogProps {
  motto: MottoRecord
  /** LLM 未配置：关本弹窗并打开 GoConfigDialog（父级接线） */
  onGoConfig: () => void
  /** 落库成功（替换或另存）：父级 toast + 刷新 + 关弹窗 */
  onDone: (mode: 'replace' | 'save') => void
  onClose: () => void
}

export default function MottoPolishDialog(props: MottoPolishDialogProps) {
  const { motto, onGoConfig, onDone, onClose } = props
  const [suggestion, setSuggestion] = useState('')
  const [phase, setPhase] = useState<Phase>('input')
  const [result, setResult] = useState<{ content: string; note: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notConfigured, setNotConfigured] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [adopting, setAdopting] = useState(false)
  const jobIdRef = useRef<string | null>(null)
  const phaseRef = useRef<Phase>('input')
  phaseRef.current = phase

  // 卸载兜底：弹窗关闭/换行重开时取消进行中的生成
  useEffect(
    () => () => {
      if (jobIdRef.current) void window.api.ai.cancel(jobIdRef.current)
    },
    []
  )

  const run = async (): Promise<void> => {
    const sug = suggestion.trim()
    if (!sug || phaseRef.current === 'running' || jobIdRef.current) return
    const jobId = crypto.randomUUID()
    jobIdRef.current = jobId
    setPhase('running')
    setError(null)
    setNotConfigured(false)
    try {
      const r = await window.api.mottos.polish(jobId, motto.id, sug)
      setResult(r)
      setPhase('result')
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) {
        // 取消回到先前状态（有旧结果回结果态，否则回输入态），建议保留
        setPhase(result ? 'result' : 'input')
      } else if (msg.includes('LLM_NOT_CONFIGURED')) {
        setNotConfigured(true)
        setPhase('input')
      } else {
        setError(
          msg.includes('POLISH_GATE_REJECTED')
            ? '两次改写均未通过质量检查（句式/口语化/限长/查重），请调整建议后重试'
            : msg
        )
        setPhase('input')
      }
    } finally {
      jobIdRef.current = null
    }
  }

  const cancel = (): void => {
    if (jobIdRef.current) void window.api.ai.cancel(jobIdRef.current)
  }

  const adopt = async (mode: 'replace' | 'save'): Promise<void> => {
    if (!result || adopting) return
    setAdopting(true)
    try {
      await window.api.mottos.polishAdopt(motto.id, result.content, mode)
      onDone(mode)
    } catch (e) {
      const msg = String((e as Error).message)
      setError(msg.includes('DUPLICATE') ? '库内已有相同或相近句子，无法另存' : msg)
      setAdopting(false)
    }
  }

  const running = phase === 'running'
  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 520 }}>
        <div className="dialog-header">AI 打磨</div>
        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="polish-origin">
            <div className="polish-origin-text">{motto.content}</div>
            <div className="polish-origin-source">—— {motto.source || 'debugzi'}</div>
          </div>
          <textarea
            className="field"
            rows={2}
            value={suggestion}
            disabled={running}
            onChange={(e) => setSuggestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void run()
              }
            }}
            placeholder="例：意象太散，聚焦一个画面；语气再冷些"
          />
          {running && (
            <div className="polish-running">
              <span className="module-sub">打磨中…</span>
              <button className="btn" onClick={cancel}>
                取消
              </button>
            </div>
          )}
          {error && <div className="polish-error">{error}</div>}
          {notConfigured && (
            <div className="polish-error">
              <span>LLM 未配置，无法打磨</span>
              <button
                className="btn"
                onClick={() => {
                  onClose()
                  onGoConfig()
                }}
              >
                去配置
              </button>
            </div>
          )}
          {phase === 'result' && result && (
            <div className="polish-result">
              <div className="polish-result-text">{result.content}</div>
              {result.note && <div className="polish-result-note">{result.note}</div>}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          {phase === 'result' && result ? (
            <>
              <button className="btn" onClick={() => void run()}>
                重新生成
              </button>
              <button className="btn" onClick={onClose}>
                放弃
              </button>
              <button className="btn" disabled={adopting} onClick={() => void adopt('save')}>
                另存为新条
              </button>
              <button className="btn btn-primary" disabled={adopting} onClick={() => setConfirmReplace(true)}>
                采纳替换
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                关闭
              </button>
              <button className="btn btn-primary" disabled={running || !suggestion.trim()} onClick={() => void run()}>
                生成
              </button>
            </>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmReplace}
        title="替换原句"
        confirmText="替换"
        onConfirm={() => {
          setConfirmReplace(false)
          void adopt('replace')
        }}
        onCancel={() => setConfirmReplace(false)}
      >
        替换后原句不可恢复（已记入淘汰记录，不会再被 AI 生成）。
      </ConfirmDialog>
    </div>
  )
}
