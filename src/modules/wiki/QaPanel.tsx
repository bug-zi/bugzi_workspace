// 万象库·问答面板（2026-09-12-知识问答标签页-design.md §二）：单轮知识问答存档
// 安静模式：搜索/生成过程不推右栏频道，仅面板内显示进行中；强制 MCP 联网（同辩真）
// 允许重复提问（知识会更新，不做辩真式查重）；删除入回收站万象库块（source 'qa'）
import { useCallback, useEffect, useState } from 'react'
import type { QaRecord } from '../../renderer/api'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

export interface QaPanelProps {
  /** 划词问 AI：走本模块默认频道「万象·问答」（App 层 module→channel 映射，无需显式 channel） */
  onOpenAi: (prefill?: string) => void
}

export default function QaPanel(props: QaPanelProps) {
  const { toast } = useToast()
  const [records, setRecords] = useState<QaRecord[]>([])
  const [question, setQuestion] = useState('')
  const [runJob, setRunJob] = useState<string | null>(null)
  const running = runJob != null
  const [goConfig, setGoConfig] = useState<'llm' | 'mcp' | null>(null)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const [viewRec, setViewRec] = useState<QaRecord | null>(null)
  const [discardTarget, setDiscardTarget] = useState<QaRecord | null>(null)

  const load = useCallback(async () => {
    setRecords(await window.api.qa.list())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // keep-alive：切回万象库时刷新记录列表（照 VerifyPanel）
  useModuleActivated('wiki', () => void load())

  const runQa = async (): Promise<void> => {
    const text = question.trim()
    if (!text || running) return
    const jobId = crypto.randomUUID()
    setRunJob(jobId)
    setQuestion('')
    try {
      await window.api.qa.run(jobId, text)
      toast('回答完成')
      await load()
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig('llm')
      else if (msg.includes('MCP_NOT_ENABLED')) setGoConfig('mcp')
      else setFailMsg(msg)
    } finally {
      setRunJob(null)
    }
  }

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    await window.api.qa.discard(discardTarget.id)
    toast('已放入回收站')
    setDiscardTarget(null)
    setViewRec(null)
    await load()
  }

  return (
    <div className="module-subpage">
      {/* 输入区 */}
      <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <textarea
          className="field"
          rows={3}
          value={question}
          disabled={running}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void runQa()
            }
          }}
          placeholder={'输入一个偏科普的知识问题，AI 联网搜索后回答（需 LLM + MCP）…\n（Ctrl+Enter 提问）'}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn btn-primary" onClick={() => void runQa()} disabled={running || !question.trim()}>
            {running ? (
              <>
                <span className="material-symbols-outlined rotating">progress_activity</span>
                提问中…
              </>
            ) : (
              <>
                <span className="material-symbols-outlined">help</span>
                提问
              </>
            )}
          </button>
          {running && (
            <>
              <button className="btn" onClick={() => void window.api.ai.cancel(runJob!)} title="取消本次提问">
                <span className="material-symbols-outlined">stop_circle</span>
                取消
              </button>
              <span className="module-sub">正在通过 MCP 检索并组织回答</span>
            </>
          )}
        </div>
      </div>

      {/* 历史记录 */}
      <section className="zone">
        <div className="zone-header">
          <span>问答历史</span>
          <span className="zone-count">{records.length}</span>
        </div>
        <div className="zone-body">
          {records.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">help</span>
              暂无问答记录
            </div>
          )}
          {records.map((r) => (
            <div className="row-item" key={r.id} onClick={() => setViewRec(r)}>
              <div className="row-main">
                <div className="row-title" title={r.question}>{r.question}</div>
                <div className="row-sub">{fmtTime(r.created_at)}</div>
              </div>
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" title="查看" onClick={() => setViewRec(r)}>
                  <span className="material-symbols-outlined">visibility</span>
                </button>
                <button className="icon-btn danger" title="删除" onClick={() => setDiscardTarget(r)}>
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 详情 MdDialog：默认渲染态双击编辑；划词问 AI 进「万象·问答」频道 */}
      <MdDialog
        key={viewRec?.id ?? 'none'}
        open={viewRec != null}
        title={viewRec?.question ?? ''}
        filePath={viewRec?.md_path ?? ''}
        onClose={() => setViewRec(null)}
        selectionActions={{
          onAskAi: (t) => props.onOpenAi(`关于问答「${viewRec?.question ?? ''}」：「${t}」\n\n请帮我解释。`)
        }}
      />

      {/* 丢弃二次确认 */}
      <ConfirmDialog
        open={discardTarget != null}
        title="放入回收站"
        confirmText="丢弃"
        danger
        onConfirm={() => void doDiscard()}
        onCancel={() => setDiscardTarget(null)}
      >
        放入回收站，3 天后自动彻底删除。
      </ConfirmDialog>

      {/* 未配置引导 */}
      <GoConfigDialog
        open={goConfig != null}
        kind={goConfig ?? 'llm'}
        onGoConfig={() => setGoConfig(null)}
        onCancel={() => setGoConfig(null)}
      />

      {/* 失败 */}
      {failMsg && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setFailMsg(null)}>
          <div className="dialog" style={{ width: 440 }}>
            <div className="dialog-header">提问失败</div>
            <div className="dialog-body" style={{ lineHeight: 1.7, wordBreak: 'break-all' }}>{failMsg}</div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setFailMsg(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
