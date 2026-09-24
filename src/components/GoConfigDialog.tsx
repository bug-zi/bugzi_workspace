// LLM 未配置引导弹窗（总需求文档第 8 条：提示 +「去配置」直达个人中心）
import type { ReactNode } from 'react'

export interface GoConfigDialogProps {
  open: boolean
  /** 缺 LLM / MCP / ASR */
  kind: 'llm' | 'mcp' | 'asr'
  onGoConfig: () => void
  onCancel: () => void
}

const GO_CONFIG_TEXT: Record<GoConfigDialogProps['kind'], { title: string; body: string }> = {
  llm: { title: 'LLM 未配置', body: '请先在个人档配置 LLM，以启用 AI 功能。' },
  mcp: { title: 'MCP 未启用', body: '请先在个人档配置并启用 MCP，以启用联网搜索。' },
  asr: { title: 'ASR 未配置', body: '请先在个人档配置 ASR（语音转写），以启用文字稿转写。' }
}

export function openGoConfigDialog(
  kind: 'llm' | 'mcp' | 'asr',
  onGoConfig: () => void,
  onClose: () => void
): ReactNode {
  return (
    <GoConfigDialog open kind={kind} onGoConfig={onGoConfig} onCancel={onClose} />
  )
}

export default function GoConfigDialog(props: GoConfigDialogProps) {
  const { open, kind, onGoConfig, onCancel } = props
  if (!open) return null
  const text = GO_CONFIG_TEXT[kind]
  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" style={{ width: 400 }}>
        <div className="dialog-header">
          <span className="material-symbols-outlined">error</span>
          {text.title}
        </div>
        <div className="dialog-body" style={{ lineHeight: 1.7 }}>
          {text.body}
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={onCancel}>
            暂不
          </button>
          <button className="btn btn-primary" onClick={onGoConfig}>
            去配置
          </button>
        </div>
      </div>
    </div>
  )
}
