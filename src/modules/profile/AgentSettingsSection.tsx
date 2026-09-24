// 超级工作台 2.0 设置区（idea/超级工作台2.0/designs-specs-批次A §5）：
// part="embedding" = Embedding 配置块（LLM 配置区下方）；
// part="agent" = 超级工作台整区（MCP 配置区后：区头〔运行状态 + 任务中心直达〕/引擎开关/
// 领域管理/负载阈值/额度预算/隐私白名单）。260925 排版优化：原 ProfileModule 顶部悬浮条
// 与本区区头两段重叠，合并为单一 zone，机制名列表改徽章行，领域组改分组卡。
// 自包含：挂载拉 agent:configGet，变更即落库（引擎键走 agent:configSet 带副作用，
// embedding_config 走 settings:set 通用通道）。
import { useCallback, useEffect, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { SettingsKeys } from '../../shared/types'
import type { AgentConfigView, AgentDomainRow, AgentTrack, EmbeddingConfig } from '../../shared/types'

/** 引擎设置键白名单（与 ipc.ts agent:configSet 对齐） */
const KEYS = {
  enabled: SettingsKeys.AgentEnabled,
  cpuPause: SettingsKeys.AgentCpuPause,
  cpuResume: SettingsKeys.AgentCpuResume,
  budget: SettingsKeys.AgentDailyBudget,
  privacyProfile: SettingsKeys.AgentPrivacyProfile,
  privacyLearn: SettingsKeys.AgentPrivacyLearn
}

const TRACK_META: { track: AgentTrack; label: string; hint: string }[] = [
  { track: 'deep', label: '深读领域（论文）', hint: 'AI/程序员知识等，走深读线读学术论文' },
  { track: 'science', label: '科普领域（文章）', hint: '法学/经济学等兴趣拓展，只收科普文章（二期管道）' }
]

export default function AgentSettingsSection({
  part,
  onOpenWorkspace
}: {
  part: 'embedding' | 'agent'
  onOpenWorkspace?: () => void
}) {
  const { toast } = useToast()
  const [cfg, setCfg] = useState<AgentConfigView | null>(null)
  const [ec, setEc] = useState<EmbeddingConfig | null>(null)
  const [testing, setTesting] = useState(false)
  const [serving, setServing] = useState(false)

  // ---------- 领域管理 ----------
  const [domains, setDomains] = useState<AgentDomainRow[]>([])
  const [addingTrack, setAddingTrack] = useState<AgentTrack | null>(null)
  const [newName, setNewName] = useState('')
  const [newKw, setNewKw] = useState('')
  const [delDomain, setDelDomain] = useState<AgentDomainRow | null>(null)
  // ---------- 阈值/预算输入态（失焦提交） ----------
  const [pauseDraft, setPauseDraft] = useState('')
  const [resumeDraft, setResumeDraft] = useState('')
  const [budgetDraft, setBudgetDraft] = useState('')

  useEffect(() => {
    void window.api.agent.configGet().then((c) => {
      setCfg(c)
      setEc(c.embedding)
      setPauseDraft(String(c.cpuPause))
      setResumeDraft(String(c.cpuResume))
      setBudgetDraft(String(c.budget))
    })
  }, [])

  const loadDomains = useCallback((): void => {
    void window.api.agent.domains().then(setDomains)
  }, [])

  useEffect(() => {
    if (part === 'agent') loadDomains()
  }, [part, loadDomains])

  const patchCfg = (p: Partial<AgentConfigView>): void => {
    setCfg((c) => (c ? { ...c, ...p } : c))
  }

  // ---------- Embedding ----------
  const saveEmbedding = (next: EmbeddingConfig): void => {
    setEc(next)
    void window.api.settings.set(SettingsKeys.EmbeddingConfig, JSON.stringify(next))
  }

  const testEmbedding = async (): Promise<void> => {
    setTesting(true)
    try {
      const { dim } = await window.api.embedding.test()
      toast(`连接成功，向量维度 ${dim}`)
    } catch (e) {
      toast(`连接失败：${(e as Error).message}`)
    } finally {
      setTesting(false)
    }
  }

  const serveOllama = async (): Promise<void> => {
    setServing(true)
    try {
      const { ok } = await window.api.embedding.serve()
      toast(ok ? 'Ollama 已就绪' : '拉起失败，请手动启动 Ollama')
    } catch (e) {
      toast(`拉起失败：${(e as Error).message}`)
    } finally {
      setServing(false)
    }
  }

  // ---------- 引擎开关 / 隐私 ----------
  const toggleEngine = (on: boolean): void => {
    patchCfg({ enabled: on })
    void window.api.agent.configSet(KEYS.enabled, on ? '1' : '0')
    toast(on ? '超级工作台引擎已开启' : '引擎已关闭')
  }

  const togglePrivacy = (kind: 'Profile' | 'Learn', on: boolean): void => {
    if (kind === 'Profile') patchCfg({ privacyProfile: on })
    else patchCfg({ privacyLearn: on })
    void window.api.agent.configSet(kind === 'Profile' ? KEYS.privacyProfile : KEYS.privacyLearn, on ? '1' : '0')
  }

  // ---------- 阈值/预算 ----------
  const commitThresholds = (): void => {
    if (!cfg) return
    const pause = Number(pauseDraft)
    const resume = Number(resumeDraft)
    if (!Number.isFinite(pause) || !Number.isFinite(resume) || pause <= 0 || resume <= 0) {
      toast('阈值须为正数')
      return
    }
    if (resume >= pause) {
      toast('恢复阈值须小于暂停阈值')
      setPauseDraft(String(cfg.cpuPause))
      setResumeDraft(String(cfg.cpuResume))
      return
    }
    void window.api.agent.configSet(KEYS.cpuPause, String(pause))
    void window.api.agent.configSet(KEYS.cpuResume, String(resume))
    patchCfg({ cpuPause: pause, cpuResume: resume })
    toast('负载阈值已保存')
  }

  const commitBudget = (): void => {
    const v = Number(budgetDraft)
    const budget = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
    void window.api.agent.configSet(KEYS.budget, String(budget))
    patchCfg({ budget })
    setBudgetDraft(String(budget))
    toast(budget === 0 ? '额度预算不限' : `每日预算已设为 ${budget} token`)
  }

  // ---------- 领域 ----------
  const addDomain = (track: AgentTrack): void => {
    if (!newName.trim()) {
      toast('请填写领域名称')
      return
    }
    const keywords = newKw
      .split(/[,，、\s]+/)
      .map((k) => k.trim())
      .filter(Boolean)
    void window.api.agent
      .domainSave(null, { name: newName.trim(), track, keywords, enabled: true })
      .then(() => {
        setNewName('')
        setNewKw('')
        setAddingTrack(null)
        loadDomains()
        toast('领域已添加')
      })
      .catch((e: unknown) => toast((e as Error).message))
  }

  const toggleDomain = (d: AgentDomainRow, enabled: boolean): void => {
    void window.api.agent
      .domainSave(d.id, { name: d.name, track: d.track, keywords: d.keywords, enabled })
      .then(loadDomains)
  }

  const removeDomain = (): void => {
    const d = delDomain
    if (!d) return
    setDelDomain(null)
    void window.api.agent.domainDelete(d.id).then(() => {
      loadDomains()
      toast('领域已删除')
    })
  }

  // ================ Embedding 配置块 ================
  if (part === 'embedding') {
    return (
      <section className="zone">
        <div className="zone-header">
          <span>Embedding 配置</span>
        </div>
        <div className="zone-body">
          <div className="setting-row">
            <span className="setting-label">启用语义检索</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.85em' }}>
              <input
                type="checkbox"
                checked={ec?.enabled ?? false}
                onChange={(e) => ec && saveEmbedding({ ...ec, enabled: e.target.checked })}
                style={{ accentColor: 'var(--color-primary)' }}
              />
              {ec?.enabled ? '已启用' : '未启用'}
            </label>
          </div>
          <div className="setting-row">
            <span className="setting-label">服务地址</span>
            <input
              className="field"
              style={{ width: 260 }}
              placeholder="http://127.0.0.1:11434"
              value={ec?.baseUrl ?? ''}
              onChange={(e) => ec && setEc({ ...ec, baseUrl: e.target.value })}
              onBlur={() => ec && saveEmbedding(ec)}
            />
          </div>
          <div className="setting-row">
            <span className="setting-label">模型</span>
            <input
              className="field"
              style={{ width: 260 }}
              placeholder="bge-m3"
              value={ec?.model ?? ''}
              onChange={(e) => ec && setEc({ ...ec, model: e.target.value })}
              onBlur={() => ec && saveEmbedding(ec)}
            />
          </div>
          <div className="setting-row">
            <span className="setting-label">Ollama 程序路径</span>
            <input
              className="field"
              style={{ width: 260 }}
              placeholder="D:\AI\Ollama\ollama.exe"
              value={ec?.ollamaPath ?? ''}
              onChange={(e) => ec && setEc({ ...ec, ollamaPath: e.target.value })}
              onBlur={() => ec && saveEmbedding(ec)}
            />
          </div>
          <div className="setting-row">
            <span className="setting-label">连接</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" disabled={testing} onClick={() => void testEmbedding()}>
                <span className="material-symbols-outlined">network_check</span>
                {testing ? '测试中…' : '测试连接'}
              </button>
              <button className="btn" disabled={serving} onClick={() => void serveOllama()}>
                <span className="material-symbols-outlined">play_circle</span>
                {serving ? '拉起中…' : '拉起 Ollama'}
              </button>
            </div>
          </div>
          <div className="module-sub" style={{ paddingLeft: 2 }}>
            语义检索用于内容关联推荐，不可用时自动跳过、不影响其他功能。
          </div>
        </div>
      </section>
    )
  }

  // ================ 超级工作台区 ================
  return (
    <section className="zone">
      <div className="zone-header">
        <span>超级工作台</span>
        {cfg && <span className="zone-count">{cfg.enabled ? '运行中' : '已关闭'}</span>}
        {onOpenWorkspace && (
          <div className="zone-actions">
            <button className="btn btn-primary" onClick={onOpenWorkspace}>
              <span className="material-symbols-outlined">smart_toy</span>
              打开任务中心
            </button>
          </div>
        )}
      </div>
      <div className="zone-body">
        <div className="setting-row">
          <span className="setting-label">引擎总开关</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.85em' }}>
            <input
              type="checkbox"
              checked={cfg?.enabled ?? false}
              onChange={(e) => toggleEngine(e.target.checked)}
              style={{ accentColor: 'var(--color-primary)' }}
            />
            后台持续搜集 / 整理 / 汇报知识资源
          </label>
        </div>
        <div className="setting-row">
          <span className="setting-label">运行机制</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className="badge">后台错峰巡检海选</span>
            <span className="badge">任务队列</span>
            <span className="badge">负载卫兵</span>
            <span className="badge">额度预算</span>
          </div>
        </div>

        {TRACK_META.map(({ track, label, hint }) => {
          const list = domains.filter((d) => d.track === track)
          return (
            <div
              key={track}
              style={{
                margin: '8px 4px 0',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 10px 8px'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', padding: '6px 2px 2px' }}>
                <span style={{ fontWeight: 600 }}>{label}</span>
                <span className="module-sub">{hint}</span>
              </div>
              {list.length === 0 && (
                <div className="module-sub" style={{ padding: '2px 2px 6px' }}>
                  暂无领域，添加后引擎每日自动海选一次
                </div>
              )}
              {list.map((d) => (
                <div className="setting-row" key={d.id} style={{ padding: '7px 2px' }}>
                  <span className="setting-label">{d.name}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {d.keywords.map((k) => (
                      <span className="badge" key={k}>
                        {k}
                      </span>
                    ))}
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.85em' }}>
                      <input
                        type="checkbox"
                        checked={d.enabled}
                        onChange={(e) => toggleDomain(d, e.target.checked)}
                        style={{ accentColor: 'var(--color-primary)' }}
                      />
                      启用
                    </label>
                    <button className="icon-btn danger" title="删除领域" onClick={() => setDelDomain(d)}>
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                  </div>
                </div>
              ))}
              {addingTrack === track ? (
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <input
                    className="field"
                    style={{ width: 160 }}
                    placeholder="领域名称"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    autoFocus
                  />
                  <input
                    className="field"
                    style={{ flex: 1 }}
                    placeholder="检索关键词，逗号分隔（最多 10 个）"
                    value={newKw}
                    onChange={(e) => setNewKw(e.target.value)}
                  />
                  <button className="btn btn-primary" onClick={() => addDomain(track)}>
                    保存
                  </button>
                  <button className="btn" onClick={() => setAddingTrack(null)}>
                    取消
                  </button>
                </div>
              ) : (
                <button className="btn" style={{ marginTop: 4 }} onClick={() => setAddingTrack(track)}>
                  <span className="material-symbols-outlined">add</span>
                  添加领域
                </button>
              )}
            </div>
          )
        })}

        <div style={{ marginTop: 10 }}>
          <div className="setting-row">
            <span className="setting-label">负载阈值</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="module-sub">CPU &gt;</span>
              <input
                className="field"
                style={{ width: 70 }}
                value={pauseDraft}
                onChange={(e) => setPauseDraft(e.target.value)}
                onBlur={commitThresholds}
              />
              <span className="module-sub">% 暂停 · &lt;</span>
              <input
                className="field"
                style={{ width: 70 }}
                value={resumeDraft}
                onChange={(e) => setResumeDraft(e.target.value)}
                onBlur={commitThresholds}
              />
              <span className="module-sub">% 恢复（连续窗口迟滞防抖）</span>
            </div>
          </div>
          <div className="setting-row">
            <span className="setting-label">每日额度预算</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                className="field"
                style={{ width: 120 }}
                value={budgetDraft}
                onChange={(e) => setBudgetDraft(e.target.value)}
                onBlur={commitBudget}
              />
              <span className="module-sub">token（0 = 不限；超限暂停搜集类，按需任务不受限）</span>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <div className="setting-row">
            <span className="setting-label">隐私白名单</span>
            <span className="module-sub">默认全关：后台任务不注入任何个人信息；前台对话不受影响</span>
          </div>
          <div className="setting-row">
            <span className="setting-label">允许后台任务参考我的画像</span>
            <input
              type="checkbox"
              checked={cfg?.privacyProfile ?? false}
              onChange={(e) => togglePrivacy('Profile', e.target.checked)}
              style={{ accentColor: 'var(--color-primary)' }}
            />
          </div>
          <div className="setting-row">
            <span className="setting-label">允许后台任务参考学习记录</span>
            <input
              type="checkbox"
              checked={cfg?.privacyLearn ?? false}
              onChange={(e) => togglePrivacy('Learn', e.target.checked)}
              style={{ accentColor: 'var(--color-primary)' }}
            />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={!!delDomain}
        title="删除领域"
        danger
        confirmText="删除"
        onConfirm={removeDomain}
        onCancel={() => setDelDomain(null)}
      >
        确认删除领域「{delDomain?.name}」？其已发现的条目将保留，但不再关联该领域。
      </ConfirmDialog>
    </section>
  )
}
