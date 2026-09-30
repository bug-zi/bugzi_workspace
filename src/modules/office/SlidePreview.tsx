// PPT 视图（specs §8）：大纲 md 编辑 ⇄ 幻灯片卡片预览（每页一张 16:9 卡，纯 div）。
// 编辑 800ms 防抖落盘（同 DocTextView 口径）。
import { useEffect, useRef, useState } from 'react'

interface Props {
  md: string
  onChange: (content: string) => void
}

function toPages(md: string): { title: string; points: string[] }[] {
  return md
    .split(/\n(?=## )/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
      const lines = p.split('\n').map((l) => l.trim()).filter(Boolean)
      return {
        title: lines[0].replace(/^##\s*/, ''),
        points: lines.slice(1).map((l) => l.replace(/^-\s*/, ''))
      }
    })
}

export default function SlidePreview({ md, onChange }: Props) {
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [draft, setDraft] = useState(md)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  // 防抖回声防护（同 DocTextView）：非「自己刚发出的值」才视为外部变更（AI 应用/版本恢复）
  const emittedRef = useRef(md)

  useEffect(() => {
    if (md !== emittedRef.current && md !== draftRef.current) {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      setDraft(md)
    }
    emittedRef.current = md
  }, [md])

  const emit = (v: string): void => {
    emittedRef.current = v
    onChange(v)
  }

  const commit = (v: string): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      emit(v)
    }, 800)
  }

  const flush = (): void => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    emit(draftRef.current)
  }

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
        emit(draftRef.current)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  return (
    <div className="office-slides">
      <div className="office-viewtoggle">
        <button
          className={`btn${mode === 'preview' ? ' btn-primary' : ''}`}
          onClick={() => {
            flush()
            setMode('preview')
          }}
        >
          预览
        </button>
        <button
          className={`btn${mode === 'edit' ? ' btn-primary' : ''}`}
          onClick={() => {
            flush()
            setMode('edit')
          }}
        >
          大纲
        </button>
      </div>
      {mode === 'edit' ? (
        <textarea
          className="field office-editor"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            commit(e.target.value)
          }}
          onBlur={flush}
          spellCheck={false}
        />
      ) : (
        <div className="office-slide-flow">
          {toPages(draft).length === 0 && (
            <div className="module-sub">空大纲——切「大纲」编辑，或用下方指令条让 AI 起稿</div>
          )}
          {toPages(draft).map((p, i) => (
            <div key={i} className="office-slide-card">
              <div className="office-slide-title">{p.title}</div>
              {p.points.length > 0 && (
                <ul className="office-slide-points">
                  {p.points.map((pt, j) => (
                    <li key={j}>{pt}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
