// 预言家面板（致知己·预言家 tab，2026-09-12 设计 §三）：观点 → MCP 联网检索 → AI 充分说明
// 推「致知己·预言家」频道（assistant 消息，多轮对话起点）→ 频道质疑 → MdDialog footerBar 用户判断
import { useCallback, useEffect, useState } from 'react'
import type { AiChannel, ProphetJudgment, ProphetRecord } from '../../renderer/api'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

export interface ProphetPanelProps {
  onOpenAi: (prefill?: string, opts?: { auto?: boolean; channel?: AiChannel }) => void
  bumpAi: () => void
  onNavigateToProfile: () => void
}

const JUDGMENT_LABEL: Record<ProphetJudgment, string> = {
  reasonable: '已判断·合理',
  unreasonable: '已判断·不合理',
  uncertain: '已判断·存疑'
}

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 判断区（MdDialog footerBar）：理由输入 + 三选一即点即判；重新分析 / 回到频道在右侧 */
function JudgeBar(props: {
  view: ProphetRecord
  busy: boolean
  onSubmit: (j: ProphetJudgment, note: string) => void
  onReanalyze: () => void
  onOpenChannel: () => void
}) {
  const [note, setNote] = useState(props.view.judgment_note)
  return (
    <div className="zj-judge">
      <input
        className="field"
        placeholder="判断理由（可选）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button className="btn btn-primary" disabled={props.busy} onClick={() => props.onSubmit('reasonable', note)}>
        合理
      </button>
      <button className="btn btn-primary" disabled={props.busy} onClick={() => props.onSubmit('unreasonable', note)}>
        不合理
      </button>
      <button className="btn btn-primary" disabled={props.busy} onClick={() => props.onSubmit('uncertain', note)}>
        存疑
      </button>
      <button
        className="btn"
        disabled={props.busy}
        onClick={props.onReanalyze}
        title="重新联网分析并覆盖 md 快照（过程见右栏频道）"
      >
        <span className="material-symbols-outlined">refresh</span>
        重新分析
      </button>
      <button className="btn" onClick={props.onOpenChannel} title="到右栏「致知己·预言家」频道继续质疑讨论">
        <span className="material-symbols-outlined">forum</span>
        回到频道
      </button>
    </div>
  )
}

export default function ProphetPanel(props: ProphetPanelProps) {
  const { toast } = useToast()
  const [records, setRecords] = useState<ProphetRecord[]>([])
  // 新预言
  const [adding, setAdding] = useState(false)
  const [claim, setClaim] = useState('')
  const [note, setNote] = useState('')
  const [runJob, setRunJob] = useState<string | null>(null)
  const running = runJob != null
  // 详情/判断/删除/引导
  const [view, setView] = useState<ProphetRecord | null>(null)
  const [judgeBusy, setJudgeBusy] = useState(false)
  const [discardTarget, setDiscardTarget] = useState<ProphetRecord | null>(null)
  const [goConfig, setGoConfig] = useState<'llm' | 'mcp' | null>(null)
  const [failMsg, setFailMsg] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const rows = await window.api.prophet.list()
    setRecords(rows)
    // 详情打开中同步状态（判断/重析后徽标即时更新）
    setView((v) => (v ? rows.find((r) => r.id === v.id) ?? v : v))
  }, [])

  useEffect(() => {
    void load()
    // 分析过程系统消息实时到达 → 通知边栏重载（同 VerifyPanel）
    const off = window.api.ai.onMessage(() => props.bumpAi())
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useModuleActivated('zhijiji', () => void load())

  const analyze = async (id: number): Promise<void> => {
    const jobId = crypto.randomUUID()
    setRunJob(jobId)
    try {
      await window.api.prophet.analyze(jobId, id)
      toast('分析完成，可到「致知己·预言家」频道继续质疑')
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig('llm')
      else if (msg.includes('MCP_NOT_ENABLED')) setGoConfig('mcp')
      else setFailMsg(msg)
    } finally {
      setRunJob(null)
      await load()
      props.bumpAi()
    }
  }

  const doCreate = async (): Promise<void> => {
    const c = claim.trim()
    if (!c || running) return
    if (!(await window.api.ai.configured())) {
      setGoConfig('llm')
      return
    }
    try {
      const r = await window.api.prophet.create(c, note.trim())
      setAdding(false)
      setClaim('')
      setNote('')
      await load()
      props.onOpenAi(undefined, { channel: 'prophet' })
      await analyze(r.id)
    } catch (e) {
      toast(`创建失败：${String((e as Error).message).slice(0, 80)}`)
    }
  }

  const redoAnalyze = async (): Promise<void> => {
    if (!view || running) return
    props.onOpenAi(undefined, { channel: 'prophet' })
    await analyze(view.id)
  }

  const doJudge = async (j: ProphetJudgment, judgmentNote: string): Promise<void> => {
    if (!view || judgeBusy) return
    setJudgeBusy(true)
    try {
      await window.api.prophet.judge(view.id, j, judgmentNote)
      toast('已记录判断（可随时改判覆盖）')
      await load()
    } finally {
      setJudgeBusy(false)
    }
  }

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    await window.api.prophet.discard(discardTarget.id)
    toast('已放入回收站')
    setDiscardTarget(null)
    if (view?.id === discardTarget.id) setView(null)
    await load()
  }

  return (
    <>
      {/* 列表 */}
      <section className="zone">
        <div className="zone-header">
          <span>预言列表</span>
          <span className="zone-count">{records.length}</span>
        </div>
        <div className="zone-body">
          {records.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">auto_awesome</span>
              还没有预言。点「新预言」，让 AI 联网帮你检验一个推断
            </div>
          )}
          {records.map((r) => (
            <div className="row-item" key={r.id} onClick={() => setView(r)} title="点击打开详情与判断">
              <div className="row-main">
                <div className="row-title" title={r.claim}>
                  {r.claim}
                </div>
                <div className="row-sub">更新 {fmtTime(r.updated_at)}</div>
              </div>
              <span className={`zj-status${r.status === 'judged' && r.judgment ? ' judged' : ' open'}`}>
                {r.status === 'judged' && r.judgment ? JUDGMENT_LABEL[r.judgment] : '讨论中'}
              </span>
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn danger" title="删除（进回收站）" onClick={() => setDiscardTarget(r)}>
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 新预言入口 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -6, marginBottom: 8 }}>
        <button className="btn btn-primary" disabled={running} onClick={() => setAdding(true)}>
          <span className="material-symbols-outlined">add</span>
          新预言
        </button>
      </div>

      {/* 详情：md 快照（无快照给占位文案）+ footerBar 判断区 */}
      <MdDialog
        open={view != null}
        title={view?.claim ?? ''}
        filePath={view?.analysis_md_path ?? undefined}
        content={view?.analysis_md_path ? undefined : '（尚未生成 AI 分析。点击下方「重新分析」开始联网检索。）'}
        onClose={() => setView(null)}
        onChanged={() => void load()}
        footerBar={
          view ? (
            <JudgeBar
              key={view.id}
              view={view}
              busy={judgeBusy || running}
              onSubmit={(j, n) => void doJudge(j, n)}
              onReanalyze={() => void redoAnalyze()}
              onOpenChannel={() => props.onOpenAi(undefined, { channel: 'prophet' })}
            />
          ) : undefined
        }
      />

      {/* 新预言弹窗 */}
      {adding && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && !running && setAdding(false)}>
          <div className="dialog" style={{ width: 440 }}>
            <div className="dialog-header">新预言</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <textarea
                className="field"
                rows={2}
                placeholder="预言观点（必填，如：未来 Token 会越来越便宜）"
                value={claim}
                onChange={(e) => setClaim(e.target.value)}
                autoFocus
              />
              <textarea
                className="field"
                rows={3}
                placeholder="补充说明（可选：预测背景、你的初步理由…）"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="module-sub">
                创建后自动开始 AI 联网分析（需 LLM + MCP），过程与说明见右栏「致知己·预言家」频道
              </div>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAdding(false)} disabled={running}>
                取消
              </button>
              {runJob && (
                <button className="btn" onClick={() => void window.api.ai.cancel(runJob)} title="取消本次分析">
                  <span className="material-symbols-outlined">stop_circle</span>
                  取消
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={() => void doCreate()}
                disabled={running || !claim.trim()}
              >
                {running ? 'AI 分析中…' : '创建并分析'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除二次确认（全局规则） */}
      <ConfirmDialog
        open={discardTarget != null}
        title="删除预言"
        confirmText="删除"
        danger
        onConfirm={() => void doDiscard()}
        onCancel={() => setDiscardTarget(null)}
      >
        将删除预言「{discardTarget?.claim}」并放入回收站（3 天后彻底删除；频道对话历史保留）。
      </ConfirmDialog>

      {/* LLM/MCP 未配置引导（全局规则：不置灰，点击提示 + 去配置） */}
      <GoConfigDialog
        open={goConfig != null}
        kind={goConfig ?? 'llm'}
        onGoConfig={() => {
          setGoConfig(null)
          props.onNavigateToProfile()
        }}
        onCancel={() => setGoConfig(null)}
      />

      {/* 失败详情 */}
      {failMsg && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setFailMsg(null)}>
          <div className="dialog" style={{ width: 440 }}>
            <div className="dialog-header">分析失败</div>
            <div className="dialog-body" style={{ lineHeight: 1.7, wordBreak: 'break-all' }}>
              {failMsg}
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setFailMsg(null)}>
                关闭
              </button>
              <button className="btn btn-primary" onClick={() => setFailMsg(null)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
