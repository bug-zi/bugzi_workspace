// 冷启动引导（超级工作台 2.0 批次C spec §4）：升级 2.0 后首次启动的三步向导——
// 定位与隐私说明 → 领域配置（预置勾选/自建，可跳过）→ 可选立即首跑。
// 走完置 agent_cold_start_done（不再弹）；跳过不动引擎开关，「完成」则开引擎。
import { useState } from 'react'
import { useToast } from '../../components/Toast'
import type { AgentTrack } from '../../renderer/api'

interface Preset {
  track: AgentTrack
  name: string
  keywords: string
}

const PRESETS: Preset[] = [
  { track: 'deep', name: 'AI 与大模型', keywords: 'LLM, transformer, large language model' },
  { track: 'deep', name: '程序员工程实践', keywords: 'software engineering, system design' },
  { track: 'science', name: '经济学', keywords: 'economics' },
  { track: 'science', name: '法学', keywords: 'law, legal' },
  { track: 'science', name: '心理学', keywords: 'psychology' }
]

const TRACK_LABEL: Record<AgentTrack, string> = { deep: '深读领域（论文）', science: '科普领域（文章，二期开通）' }

export default function AgentColdStartGuide({ onDone }: { onDone: () => void }) {
  const { toast } = useToast()
  const [step, setStep] = useState(0)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [custom, setCustom] = useState<{ deep: string; science: string }>({ deep: '', science: '' })
  const [runFirst, setRunFirst] = useState(true)
  const [saving, setSaving] = useState(false)

  const togglePreset = (p: Preset): void => {
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(p.name)) n.delete(p.name)
      else n.add(p.name)
      return n
    })
  }

  const saveDomains = async (): Promise<void> => {
    setSaving(true)
    try {
      for (const p of PRESETS.filter((x) => picked.has(x.name))) {
        await window.api.agent.domainSave(null, {
          name: p.name,
          track: p.track,
          keywords: p.keywords.split(/[,，、]\s*/).filter(Boolean),
          enabled: true
        })
      }
      for (const track of ['deep', 'science'] as const) {
        const raw = custom[track].trim()
        if (!raw) continue
        const [name, ...rest] = raw.split(/[：:|]/)
        if (!name.trim()) continue
        await window.api.agent.domainSave(null, {
          name: name.trim(),
          track,
          keywords: rest.join(',').split(/[,，、]\s*/).filter(Boolean),
          enabled: true
        })
      }
    } catch (e) {
      toast(`领域保存失败：${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const finish = async (run: boolean): Promise<void> => {
    if (step === 1) {
      await saveDomains()
      setStep(2)
      return
    }
    try {
      const { queued } = await window.api.agent.coldStartFinish(run)
      toast(run && queued > 0 ? `引擎已开启，首跑 ${queued} 个领域海选已入队` : '设置完成')
    } catch (e) {
      toast(`完成失败：${(e as Error).message}`)
    }
    onDone()
  }

  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <div className="dialog" style={{ width: 520 }}>
        <div className="dialog-header">超级工作台 2.0 · 启动向导（{step + 1}/3）</div>
        <div className="dialog-body" style={{ lineHeight: 1.8 }}>
          {step === 0 && (
            <>
              <p>
                升级 2.0 后，工作台从「被动等人用」升级为「主动持续干活」：应用开着时，后台借助你的
                LLM 额度持续<b>搜集、整理、汇报</b>知识资源。
              </p>
              <p>
                <b>信任契约</b>：AI 只负责「找齐、读完、整理好、给出处」——成果先进<b>发现箱</b>，
                是否入库由你终选；解读产物可随时重生成。
              </p>
              <p className="module-sub">
                隐私：后台任务默认不注入任何个人信息（画像/学习记录白名单默认全关，个人档可改）。
                带电脑负载检测，高负荷自动暂停让路。
              </p>
            </>
          )}
          {step === 1 && (
            <>
              <p>选择你感兴趣的领域（可多选、可自建、也可全部跳过稍后在个人档配置）：</p>
              {(['deep', 'science'] as const).map((track) => (
                <div key={track} style={{ marginBottom: 10 }}>
                  <div className="setting-label" style={{ marginBottom: 4 }}>{TRACK_LABEL[track]}</div>
                  {PRESETS.filter((p) => p.track === track).map((p) => (
                    <label key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
                      <input
                        type="checkbox"
                        checked={picked.has(p.name)}
                        onChange={() => togglePreset(p)}
                        style={{ accentColor: 'var(--color-primary)' }}
                      />
                      {p.name}
                      <span className="module-sub">{p.keywords}</span>
                    </label>
                  ))}
                  <input
                    className="field"
                    style={{ marginTop: 4 }}
                    placeholder={`自建${TRACK_LABEL[track]}：名称：关键词1, 关键词2（可留空）`}
                    value={custom[track]}
                    onChange={(e) => setCustom((c) => ({ ...c, [track]: e.target.value }))}
                  />
                </div>
              ))}
            </>
          )}
          {step === 2 && (
            <>
              <p>配置完成！</p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={runFirst}
                  onChange={(e) => setRunFirst(e.target.checked)}
                  style={{ accentColor: 'var(--color-primary)' }}
                />
                立即跑一轮海选（发现箱第一天就不空）
              </label>
              <p className="module-sub">
                引擎每日为每个启用领域自动海选一次（应用启动后错峰执行）；进展随时在左栏「工作台」
                呼吸灯与任务中心查看。
              </p>
            </>
          )}
        </div>
        <div className="dialog-footer">
          {step > 0 && (
            <button className="btn" onClick={() => setStep((s) => s - 1)}>
              上一步
            </button>
          )}
          {step === 0 && <button className="btn btn-primary" onClick={() => setStep(1)}>开始配置</button>}
          {step === 1 && (
            <>
              <button className="btn" onClick={() => setStep(2)}>
                跳过，稍后配置
              </button>
              <button className="btn btn-primary" disabled={saving} onClick={() => void finish(true)}>
                {saving ? '保存中…' : '保存并下一步'}
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <button className="btn" onClick={() => void finish(false)}>
                完成但不首跑
              </button>
              <button className="btn btn-primary" onClick={() => void finish(runFirst)}>
                完成
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
