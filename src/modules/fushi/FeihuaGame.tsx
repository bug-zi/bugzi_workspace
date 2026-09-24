// 飞花令对局视图（designs-specs §2.2）：消息流 + 输入行 + 认负入口 + 终局结果卡。
// 判字与查重由面板做（渲染层即时校验），本组件只呈现与转发；认负二次确认由面板持有。
import { useEffect, useRef } from 'react'
import type { FeihuaLine, FushiResult } from '../../shared/types'

export interface FeihuaFinished {
  result: Extract<FushiResult, 'win' | 'lose'>
  gameId: number
}

interface Props {
  keyword: string
  daily: boolean
  lines: FeihuaLine[]
  busy: boolean
  error: string
  finished: FeihuaFinished | null
  onSubmit: (line: string) => void
  onGiveUp: () => void
  onReviewArchive: (gameId: number) => void
  onExit: () => void
}

function MsgList({ lines, busy, keyword }: { lines: FeihuaLine[]; busy: boolean; keyword: string }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' })
  }, [lines.length, busy])
  return (
    <div className="fushi-msgs">
      {lines.length === 0 && (
        <div className="module-sub" style={{ padding: '8px 0' }}>
          你先来——说一句含「{keyword}」的诗句
        </div>
      )}
      {lines.map((l, i) => (
        <div key={i} className={`fushi-msg ${l.side}`}>
          <span className="fushi-msg-side">{l.side === 'me' ? '我' : 'AI'}</span>
          <span className="fushi-msg-line">{l.line}</span>
          {l.note && <span className="fushi-msg-note">{l.note}</span>}
        </div>
      ))}
      {busy && (
        <div className="fushi-msg ai">
          <span className="module-sub">AI 思索中…</span>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}

export default function FeihuaGame(props: Props) {
  const { keyword, daily, lines, busy, error, finished } = props
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = (): void => {
    const v = inputRef.current?.value.trim()
    if (v && !busy) {
      props.onSubmit(v)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  if (finished) {
    return (
      <div className="card fushi-game-card">
        <div className="fushi-result-head">
          <span className={`fushi-verdict ${finished.result === 'win' ? 'win' : 'lose'}`}>
            {finished.result === 'win' ? '胜 · AI 接不上了' : '负 · 我接不上了'}
          </span>
          <span className="module-sub">
            「{keyword}」 · 双方共 {lines.length} 句 · {daily ? '每日一令已打卡' : '自由练不计打卡'}
          </span>
        </div>
        <MsgList lines={lines} busy={false} keyword={keyword} />
        <div className="fushi-game-actions">
          <button className="btn" onClick={() => props.onReviewArchive(finished.gameId)}>
            <span className="material-symbols-outlined">history_edu</span>
            查看留档
          </button>
          <button className="btn btn-primary" onClick={props.onExit}>
            返回
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="card fushi-game-card">
      <div className="fushi-result-head">
        <span className="fushi-kw-pill">飞花令 ·「{keyword}」</span>
        <span className="module-sub">
          {daily ? '每日一令' : '自由练'} · 已 {lines.length} 句
        </span>
      </div>
      <MsgList lines={lines} busy={busy} keyword={keyword} />
      {error && <div className="fushi-error">{error}</div>}
      <div className="fushi-input-row">
        <input
          ref={inputRef}
          className="field"
          style={{ flex: 1 }}
          placeholder={`接一句含「${keyword}」的诗句`}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <button className="btn btn-primary" disabled={busy} onClick={submit}>
          出句
        </button>
        <button className="btn" disabled={busy} onClick={props.onGiveUp}>
          我接不上了
        </button>
      </div>
    </div>
  )
}
