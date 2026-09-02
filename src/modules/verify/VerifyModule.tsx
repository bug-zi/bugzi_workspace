// 辩真阁模块（辩真阁 specs 全量）：提交即验、重复检测、MCP 检索、过程推 AI 边栏
import { useCallback, useEffect, useState } from 'react'
import type { VerifyRecord } from '../../renderer/api'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

export interface VerifyModuleProps {
  onOpenAi: (prefill?: string) => void
  bumpAi: () => void
}

export default function VerifyModule(props: VerifyModuleProps) {
  const { toast } = useToast()
  const [records, setRecords] = useState<VerifyRecord[]>([])
  const [claim, setClaim] = useState('')
  const [running, setRunning] = useState(false)
  const [goConfig, setGoConfig] = useState<'llm' | 'mcp' | null>(null)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  // 重复检测
  const [dupInfo, setDupInfo] = useState<{ id: number; claim: string; created_at: string } | null>(null)
  const [dupEntry, setDupEntry] = useState<VerifyRecord | null>(null)
  // 详情/丢弃
  const [viewRec, setViewRec] = useState<VerifyRecord | null>(null)
  const [discardTarget, setDiscardTarget] = useState<VerifyRecord | null>(null)
  // AI 边栏消息版本（触发重载）
  const [aiVersion, setAiVersion] = useState(0)

  const load = useCallback(async () => {
    setRecords(await window.api.verify.list())
  }, [])

  useEffect(() => {
    void load()
    // 系统消息实时到达：边栏自动展开 + 消息刷新
    const off = window.api.ai.onMessage(() => {
      setAiVersion((v) => v + 1)
    })
    return off
  }, [load])

  // aiVersion 变化 → 通知 App 层 AiSidebar 重载（bumpAi 由 props 提供）
  useEffect(() => {
    if (aiVersion > 0) props.bumpAi()
  }, [aiVersion, props])

  // keep-alive：切回辩真阁时刷新记录列表
  useModuleActivated('verify', () => void load())

  const runVerify = async (): Promise<void> => {
    const text = claim.trim()
    if (!text || running) return
    // 重复检测（specs §3.1）
    const dup = await window.api.verify.findDuplicate(text)
    if (dup) {
      setDupInfo(dup)
      return
    }
    await doVerify(text)
  }

  const doVerify = async (text: string): Promise<void> => {
    setRunning(true)
    setClaim('')
    props.onOpenAi() // 展开边栏看过程
    try {
      const r = await window.api.verify.run(text)
      toast(`验证完成，可信度 ${r.credibility}%`)
      await load()
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig('llm')
      else if (msg.includes('MCP_NOT_ENABLED')) setGoConfig('mcp')
      else setFailMsg(msg)
    } finally {
      setRunning(false)
    }
  }

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    await window.api.verify.discard(discardTarget.id)
    toast('已放入回收站')
    setDiscardTarget(null)
    setViewRec(null)
    await load()
  }

  return (
    <div className="module-page">
      <div className="module-header">
        <span className="material-symbols-outlined">fact_check</span>
        <span className="module-title">辩真阁</span>
        <span className="module-sub">输入观点，AI 联网检索验证（需 LLM + MCP）</span>
      </div>

      {/* 输入区 */}
      <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <textarea
          className="field"
          rows={3}
          value={claim}
          disabled={running}
          onChange={(e) => setClaim(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void runVerify()
            }
          }}
          placeholder={'输入待验证的观点…\n（Ctrl+Enter 提交，自动开始验证）'}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn btn-primary" onClick={() => void runVerify()} disabled={running || !claim.trim()}>
            {running ? (
              <>
                <span className="material-symbols-outlined rotating">progress_activity</span>
                验证中…（过程见右侧 AI 边栏）
              </>
            ) : (
              <>
                <span className="material-symbols-outlined">play_arrow</span>
                开始验证
              </>
            )}
          </button>
          {running && <span className="module-sub">正在通过 MCP 检索并综合分析</span>}
        </div>
      </div>

      {/* 历史记录 */}
      <section className="zone">
        <div className="zone-header">
          <span>历史记录</span>
          <span className="zone-count">{records.length}</span>
        </div>
        <div className="zone-body">
          {records.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">fact_check</span>
              暂无验证记录
            </div>
          )}
          {records.map((r) => (
            <div className="row-item" key={r.id} onClick={() => setViewRec(r)}>
              <div className="row-main">
                <div className="row-title" title={r.claim}>{r.claim}</div>
                <div className="row-sub">{fmtTime(r.created_at)}</div>
              </div>
              <span className={`cred-badge ${r.credibility >= 70 ? 'high' : r.credibility >= 40 ? 'mid' : 'low'}`}>
                {r.credibility}%
              </span>
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn danger" title="删除" onClick={() => setDiscardTarget(r)}>
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 详情 MdDialog */}
      <MdDialog
        open={viewRec != null}
        title={viewRec?.claim ?? ''}
        filePath={viewRec?.md_path ?? ''}
        onClose={() => setViewRec(null)}
      />

      {/* 重复观点 */}
      {dupInfo && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setDupInfo(null)}>
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-header">已于 {fmtDate(dupInfo.created_at)} 验证过</div>
            <div className="dialog-body" style={{ lineHeight: 1.7 }}>
              「{dupInfo.claim}」已有验证记录。
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setDupInfo(null)}>关闭</button>
              <button
                className="btn"
                onClick={() => {
                  void window.api.verify.get(dupInfo.id).then((r) => {
                    setDupEntry(r)
                    setDupInfo(null)
                  })
                }}
              >
                查看旧记录
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const text = dupInfo.claim
                  setDupInfo(null)
                  void doVerify(text)
                }}
              >
                重新验证
              </button>
            </div>
          </div>
        </div>
      )}
      {dupEntry && (
        <MdDialog
          open
          title={dupEntry.claim}
          filePath={dupEntry.md_path}
          onClose={() => setDupEntry(null)}
          onChanged={() => void load()}
        />
      )}

      {/* 丢弃 */}
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
            <div className="dialog-header">验证失败</div>
            <div className="dialog-body" style={{ lineHeight: 1.7, wordBreak: 'break-all' }}>{failMsg}</div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setFailMsg(null)}>关闭</button>
              <button className="btn btn-primary" onClick={() => setFailMsg(null)}>知道了</button>
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
function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
