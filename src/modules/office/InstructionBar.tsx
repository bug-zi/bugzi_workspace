// AI 指令条（specs §6/§8）：输入需求 → office:aiWrite（无副作用生成）→ 渲染层手术 → 父层落盘。
// 文档类动作下拉【改写整篇|续写在末尾】，编辑态有选区锁定「改写选区」；表格类固定重写当前工作表。
// 取消 = 忽略标志：生成完成后丢弃结果不应用（快照已写，属无害多余版本）。
import { useRef, useState } from 'react'
import { useToast } from '../../components/Toast'
import type { OfficeAiWriteInput, OfficeKind, OfficeSheet } from '../../shared/types'

type Action = OfficeAiWriteInput['action']

interface Props {
  kind: OfficeKind
  rowId: number
  getContent: () => string
  getSheetBook: () => OfficeSheet[] | undefined
  getSelection: () => string | null
  onApplied: (patch: { content?: string; aiJson?: string }) => void
  onNeedConfig: () => void
}

export default function InstructionBar({
  kind,
  rowId,
  getContent,
  getSheetBook,
  getSelection,
  onApplied,
  onNeedConfig
}: Props) {
  const { toast } = useToast()
  const [text, setText] = useState('')
  const [action, setAction] = useState<Action>('rewrite')
  const [busy, setBusy] = useState(false)
  const cancelled = useRef(false)
  const isSheet = kind === 'xlsx' || kind === 'csv'

  const run = async (): Promise<void> => {
    const instruction = text.trim()
    if (!instruction || busy) return
    if (!(await window.api.ai.configured())) {
      toast('LLM 未配置——请先到个人档配置')
      onNeedConfig()
      return
    }
    const sel = !isSheet ? getSelection() : null
    const act: Action = sel ? 'selection' : action
    cancelled.current = false
    setBusy(true)
    try {
      const input: OfficeAiWriteInput = isSheet
        ? {
            instruction,
            action: 'rewrite',
            current: '',
            sheetName: getSheetBook()?.[0]?.name,
            sheetBook: getSheetBook()
          }
        : { instruction, action: act, current: getContent(), selection: sel ?? undefined }
      const { text: out } = await window.api.office.aiWrite(rowId, input)
      if (cancelled.current) {
        toast('已取消，文档未改动')
        return
      }
      if (isSheet) {
        onApplied({ aiJson: out })
      } else if (act === 'append') {
        onApplied({ content: getContent() + '\n\n' + out })
      } else if (act === 'selection' && sel) {
        onApplied({ content: getContent().replace(sel, out) })
      } else {
        onApplied({ content: out })
      }
      toast('AI 已写入（可从历史版本回退）')
      setText('')
    } catch (e) {
      toast(`AI 写入失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="office-instr">
      {isSheet && (
        <div className="office-instr-warn">AI 将重写当前工作表（写前自动快照，可从历史版本回退）</div>
      )}
      <div className="office-instr-row">
        {!isSheet && (
          <select
            className="field office-instr-action"
            value={action}
            disabled={busy}
            onChange={(e) => setAction(e.target.value as Action)}
          >
            <option value="rewrite">改写整篇</option>
            <option value="append">续写在末尾</option>
          </select>
        )}
        <input
          className="field"
          style={{ flex: 1 }}
          placeholder={isSheet ? '描述表格需求，AI 重写当前工作表…' : '输入需求，AI 直接改这篇文档…'}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run()
          }}
        />
        {busy ? (
          <button
            className="btn"
            onClick={() => {
              cancelled.current = true
            }}
          >
            取消
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => void run()}>
            生成
          </button>
        )}
      </div>
      {busy && <div className="module-sub office-instr-busy">AI 正在写入文档…</div>}
    </div>
  )
}
