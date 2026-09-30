// 文档视图（specs §8）：docx/md 渲染态 MdView ⇄ 编辑态 textarea（默认渲染态）；txt 恒编辑。
// 编辑 800ms 防抖落盘；卸载/失焦 flush 挂起草稿；选区经 onSelectionReady 透出给指令条「改写选区」。
import { useEffect, useRef, useState } from 'react'
import MdView from '../../components/MdView'
import type { OfficeKind } from '../../shared/types'

interface Props {
  docId: number
  kind: OfficeKind
  md: string
  onChange: (content: string) => void
  onSelectionReady?: (fn: () => string | null) => void
}

export default function DocTextView({ docId, kind, md, onChange, onSelectionReady }: Props) {
  const [renderMode, setRenderMode] = useState(kind !== 'txt')
  const [draft, setDraft] = useState(md)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = useRef(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // 防抖回声防护：父层保存后 md prop 回传，须与「自己刚发出的值」「当前草稿」都不同才视为外部变更
  const draftRef = useRef(draft)
  draftRef.current = draft
  const emittedRef = useRef(md)

  // 切文档：清挂起定时器 + 强制重置（防旧草稿串写新文档）
  useEffect(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    setDraft(md)
    emittedRef.current = md
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  // 外部内容变更（AI 应用/版本恢复）：非自己回声才重置
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
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      dirty.current = false
      emit(v)
    }, 800)
  }

  const flush = (): void => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    dirty.current = false
    emit(draft)
  }

  // 卸载前 flush（经 ref 读最新草稿，防闭包过期）
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

  useEffect(() => {
    onSelectionReady?.(() => {
      const ta = taRef.current
      return ta && ta.selectionStart !== ta.selectionEnd ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : null
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="office-textview">
      {kind !== 'txt' && (
        <div className="office-viewtoggle">
          <button
            className={`btn${renderMode ? ' btn-primary' : ''}`}
            onClick={() => {
              flush()
              setRenderMode(true)
            }}
          >
            渲染
          </button>
          <button
            className={`btn${!renderMode ? ' btn-primary' : ''}`}
            onClick={() => {
              flush()
              setRenderMode(false)
            }}
          >
            编辑
          </button>
        </div>
      )}
      {renderMode && kind !== 'txt' ? (
        <MdView md={draft} className="office-md" />
      ) : (
        <textarea
          ref={taRef}
          className="field office-editor"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            commit(e.target.value)
          }}
          onBlur={flush}
          spellCheck={false}
        />
      )}
    </div>
  )
}
