// LLM 未配置引导弹窗（总需求文档第 8 条：提示 +「去配置」直达个人中心）
import type { ReactNode } from 'react'

export interface GoConfigDialogProps {
  open: boolean
  /** 缺 LLM 还是缺 MCP */
  kind: 'llm' | 'mcp'
  onGoConfig: () => void
  onCancel: () => void
}

export function openGoConfigDialog(
  kind: 'llm' | 'mcp',
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
  const text =
    kind === 'llm'
      ? '请先在个人中心配置 LLM，以启用 AI 功能。'
      : '请先在个人中心配置并启用 MCP，以启用联网搜索。'
  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" style={{ width: 400 }}>
        <div className="dialog-header">
          <span className="material-symbols-outlined">error</span>
          {kind === 'llm' ? 'LLM 未配置' : 'MCP 未启用'}
        </div>
        <div className="dialog-body" style={{ lineHeight: 1.7 }}>
          {text}
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
