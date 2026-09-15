// 致知己模块（致知己 specs §2 + 优化建议区第13/14轮）：问题 + 多版本答案，保存即版本，
// 弹窗右侧内嵌追问栏（可收起/拖宽/多会话，与全局边栏同频道同数据），AI 只追问不代笔
import { useEffect, useState } from 'react'
import type { AiChannel, ZhijijiQuestion, ZhijijiVersion } from '../../renderer/api'
import MdDialog from '../../components/MdDialog'
import ActionMenu from '../../components/ActionMenu'
import { ChannelChatPanel, ChannelChatRail, CHAT_PANEL_W_DEFAULT, CHAT_PANEL_W_MAX, CHAT_PANEL_W_MIN, clampChatPanelW } from '../../components/ChannelChatPanel'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { useModuleNavigate } from '../../hooks/useModuleNavigate'
import { SettingsKeys } from '../../shared/types'
import ProphetPanel from './ProphetPanel'
import TwelvePanel from './TwelvePanel'

export interface ZhijijiModuleProps {
  onNavigateToProfile: () => void
  /** 模块动作请求展开右栏（预言家切频道 / 十二问题问 AI 追问频道）；opts.auto 时切频道后自动发送 */
  onOpenAi: (prefill?: string, opts?: { auto?: boolean; channel?: AiChannel }) => void
  /** 通知 App 层 AiSidebar 重载（预言家分析过程消息推送后） */
  bumpAi: () => void
}

/** 标签输入解析：逗号（,，）或顿号（、）分隔多个 */
const parseTagInput = (raw: string): string[] =>
  raw
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)

/** 助手消息中的协议标记（画像建议/检索）：追问栏内仅剥除显示，不影响数据 */
const PROFILE_SUGGEST_RE = /^<<<PROFILE_SUGGEST:[^>]*>>>\s*$/m
const PROFILE_LOOKUP_RE = /^<<<PROFILE_LOOKUP:[^>]*>>>\s*$/m

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function ZhijijiModule(props: ZhijijiModuleProps) {
  const { toast } = useToast()
  const [questions, setQuestions] = useState<ZhijijiQuestion[]>([])
  // 新问题
  const [adding, setAdding] = useState(false)
  const [addTitle, setAddTitle] = useState('')
  const [addTags, setAddTags] = useState('')
  const [addAiInit, setAddAiInit] = useState(false)
  const [createJob, setCreateJob] = useState<string | null>(null)
  const creating = createJob != null
  // 详情弹窗：问题 + 版本列表 + 当前版本
  const [viewQ, setViewQ] = useState<ZhijijiQuestion | null>(null)
  const [versions, setVersions] = useState<ZhijijiVersion[]>([])
  const [curVerId, setCurVerId] = useState<number | null>(null)
  const [autoEdit, setAutoEdit] = useState(false)
  // 追问栏自动发送请求（版本条「让 AI 追问」）
  const [askPrompt, setAskPrompt] = useState<{ text: string; n: number } | null>(null)
  // 追问栏布局（优化建议区第14轮）：宽度 + 收起态，持久化 settings
  const [panelW, setPanelW] = useState(CHAT_PANEL_W_DEFAULT)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  // 删除确认 / LLM 未配置
  const [discardTarget, setDiscardTarget] = useState<ZhijijiQuestion | null>(null)
  const [needConfig, setNeedConfig] = useState(false)
  // 三 tab（2026-09-12 设计 §二）：沉淀 = 原问题+版本区；tab 不持久化（万象库/推理角惯例）
  const [tab, setTab] = useState<'core' | 'prophet' | 'twelve'>('core')
  // 问题分级（优化建议区 260912）：AI 出题候选 / 补评 / 改星菜单 / 星级筛选
  const [suggestions, setSuggestions] = useState<{ title: string; stars: number; note: string }[] | null>(
    null
  )
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [suggestJob, setSuggestJob] = useState<string | null>(null)
  const [rateJob, setRateJob] = useState<string | null>(null)
  const [starMenu, setStarMenu] = useState<{ q: ZhijijiQuestion; anchor: HTMLElement } | null>(null)
  const [starFilter, setStarFilter] = useState<'all' | '4plus' | '5' | 'unrated'>('all')
  const switchTab = (t: 'core' | 'prophet' | 'twelve'): void => {
    setTab(t)
    if (t !== 'core') {
      setViewQ(null)
      setAdding(false)
    }
  }

  // 总导览「十二问题」数字块深链（target = 'twelve' → 直切该页签）
  useModuleNavigate('zhijiji', (target) => {
    if (target === 'twelve') switchTab('twelve')
  })

  const curVersion = versions.find((v) => v.id === curVerId) ?? null

  const load = async (): Promise<void> => {
    const rows = await window.api.zhijiji.list()
    setQuestions(rows)
    // 弹窗打开中：同步标题/版本数/更新时间（改名、保存版本后列表保持新鲜）
    setViewQ((vq) => rows.find((r) => r.id === vq?.id) ?? vq)
  }

  useEffect(() => {
    void load()
    // 追问栏布局偏好
    void window.api.settings.get(SettingsKeys.ZjPanelWidth).then((v) => {
      const n = v ? Number(v) : NaN
      if (Number.isFinite(n) && n >= CHAT_PANEL_W_MIN && n <= CHAT_PANEL_W_MAX) setPanelW(n)
    })
    void window.api.settings.get(SettingsKeys.ZjPanelCollapsed).then((v) => setPanelCollapsed(v === '1'))
  }, [])

  // keep-alive：切回致知己时刷新（回收站恢复等问题列表可能已变）
  useModuleActivated('zhijiji', () => void load())

  const changePanelW = (w: number): void => {
    setPanelW(w)
    void window.api.settings.set(SettingsKeys.ZjPanelWidth, String(w))
  }

  const togglePanel = (): void => {
    const next = !panelCollapsed
    setPanelCollapsed(next)
    void window.api.settings.set(SettingsKeys.ZjPanelCollapsed, next ? '1' : '0')
  }

  /** 打开问题详情：载入版本列表并定位到最新版本 */
  const open = async (q: ZhijijiQuestion, auto: boolean): Promise<void> => {
    const vs = await window.api.zhijiji.versions(q.id)
    setVersions(vs)
    setCurVerId(vs[0]?.id ?? null)
    setViewQ(q)
    setAutoEdit(auto)
  }

  /** 新建问题：默认空白 v1 直开编辑态；勾选 AI 初始化则 LLM 先出 v0 参考答案（失败不创建） */
  const createQuestion = async (): Promise<void> => {
    if (creating) return
    const t = addTitle.trim()
    if (!t) {
      toast('请填写问题标题')
      return
    }
    if (addAiInit) {
      const configured = await window.api.ai.configured()
      if (!configured) {
        setNeedConfig(true)
        return
      }
    }
    const jobId = crypto.randomUUID()
    setCreateJob(jobId)
    try {
      const r = await window.api.zhijiji.createQuestion(jobId, t, parseTagInput(addTags), addAiInit || undefined)
      setAdding(false)
      setAddTitle('')
      setAddTags('')
      setAddAiInit(false)
      toast(addAiInit ? 'AI 初始答案（v0）已生成，在此基础上写出你的 v1' : '已创建，写下属于你的 v1')
      await load()
      // 后台异步评星（260912 分级；不阻塞创建；失败静默；WHERE stars IS NULL 不覆盖用户手改）
      void window.api.zhijiji
        .rateQuestion(crypto.randomUUID(), r.questionId)
        .then(() => load())
        .catch(() => {})
      const rows = await window.api.zhijiji.list()
      const q = rows.find((x) => x.id === r.questionId)
      // 空白 v1 直开编辑态；AI v0 先渲染阅读，双击再动笔
      if (q) await open(q, !r.mdPath.endsWith('-v0.md'))
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else if (msg.includes('LLM_NOT_CONFIGURED')) setNeedConfig(true)
      else toast(`创建失败：${msg.slice(0, 100)}`)
    } finally {
      setCreateJob(null)
    }
  }

  /** 保存即版本（MdDialog versioned.onSave）：默认新版本，勾选覆盖当前版本 */
  const saveVersion = async (content: string, overwrite: boolean): Promise<void> => {
    if (!viewQ) return
    try {
      if (overwrite && curVerId != null) {
        await window.api.zhijiji.overwriteVersion(curVerId, content)
        toast('已覆盖当前版本')
      } else {
        const r = await window.api.zhijiji.saveNewVersion(viewQ.id, content)
        toast(`已保存新版本 v${r.seq}-${r.date}`)
        const vs = await window.api.zhijiji.versions(viewQ.id)
        setVersions(vs)
        setCurVerId(r.versionId)
      }
      await load()
    } catch (e) {
      toast(`保存失败：${String((e as Error).message).slice(0, 80)}`)
      throw e
    }
  }

  /** 让 AI 追问（版本条按钮）：直发弹窗内嵌追问栏（优化建议区第13轮，交互不出弹窗） */
  const askAi = async (content: string): Promise<void> => {
    const configured = await window.api.ai.configured()
    if (!configured) {
      setNeedConfig(true)
      return
    }
    if (panelCollapsed) togglePanel()
    const label = curVersion ? `v${curVersion.seq}-${curVersion.date}` : '当前版本'
    setAskPrompt((p) => ({
      text: `请对我写给自己的这个答案发起追问（较真地检验它，不要替我重写）：\n\n【问题】${viewQ?.title ?? ''}\n【当前版本】${label}\n【我的答案】\n${content}`,
      n: (p?.n ?? 0) + 1
    }))
  }

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    await window.api.zhijiji.discard(discardTarget.id)
    toast('已放入回收站')
    if (viewQ?.id === discardTarget.id) setViewQ(null)
    setDiscardTarget(null)
    await load()
  }

  // ---------- 问题分级（优化建议区 260912）：AI 出题 / 补评 / 改星 / 筛选 ----------
  const runSuggest = async (): Promise<void> => {
    if (suggestJob) return
    if (!(await window.api.ai.configured())) {
      setNeedConfig(true)
      return
    }
    const jobId = crypto.randomUUID()
    setSuggestJob(jobId)
    setSuggestions([]) // 空数组 = 弹窗开着显示 loading
    try {
      setSuggestions(await window.api.zhijiji.suggestQuestions(jobId))
    } catch (e) {
      setSuggestions(null)
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else if (msg.includes('LLM_NOT_CONFIGURED')) setNeedConfig(true)
      else toast(`AI 出题失败：${msg.slice(0, 80)}`)
    } finally {
      setSuggestJob(null)
    }
  }

  const adoptSuggestions = async (): Promise<void> => {
    const cands = (suggestions ?? []).filter((_, i) => picked.has(i))
    if (cands.length === 0) return
    try {
      const ids = await window.api.zhijiji.adoptQuestions(cands)
      toast(`已采纳 ${ids.length} 个问题`)
      setSuggestions(null)
      setPicked(new Set())
      await load()
    } catch (e) {
      toast(`采纳失败：${String((e as Error).message).slice(0, 80)}`)
    }
  }

  const runRatePending = async (): Promise<void> => {
    if (rateJob) return
    if (!(await window.api.ai.configured())) {
      setNeedConfig(true)
      return
    }
    const jobId = crypto.randomUUID()
    setRateJob(jobId)
    try {
      const n = await window.api.zhijiji.ratePending(jobId)
      toast(n > 0 ? `已为 ${n} 个问题评星` : '没有需要评星的问题')
      await load()
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else if (msg.includes('LLM_NOT_CONFIGURED')) setNeedConfig(true)
      else toast(`AI 补评失败：${msg.slice(0, 80)}`)
    } finally {
      setRateJob(null)
    }
  }

  const applyStars = async (q: ZhijijiQuestion, stars: number | null): Promise<void> => {
    await window.api.zhijiji.setStars(q.id, stars)
    setStarMenu(null)
    await load()
  }

  const displayed =
    starFilter === 'all'
      ? questions
      : starFilter === 'unrated'
        ? questions.filter((q) => q.stars == null)
        : questions.filter((q) => q.stars != null && q.stars >= (starFilter === '5' ? 5 : 4))

  return (
    <div className="module-page">
      <div className="module-header">
        <span className="material-symbols-outlined">self_improvement</span>
        <span className="module-title">致知己</span>
        <span className="module-sub">把属于自己的答案沉淀成版本</span>
        {tab === 'core' && (
          <div className="zone-actions" style={{ marginLeft: 'auto' }}>
            <button
              className="btn"
              onClick={() => void runSuggest()}
              disabled={suggestJob != null}
              title="AI 结合画像与高星问题特征出 5 条候选，勾选采纳"
            >
              <span className="material-symbols-outlined">auto_awesome</span>
              {suggestJob ? '出题中…' : 'AI 出题'}
            </button>
            {questions.some((q) => q.stars == null) && (
              <button
                className="btn"
                onClick={() => void runRatePending()}
                disabled={rateJob != null}
                title="AI 按四维标准为未评星问题批量评星"
              >
                <span className="material-symbols-outlined">stars</span>
                {rateJob ? '评星中…' : 'AI 补评'}
              </button>
            )}
            <button className="btn" onClick={() => setAdding(true)}>
              <span className="material-symbols-outlined">add</span>
              新问题
            </button>
          </div>
        )}
      </div>

      {/* 三 tab：沉淀 ｜ 预言家 ｜ 十二问题（recycle-tabs 同款样式，万象库百科|辩真一致） */}
      <div className="recycle-tabs">
        <button className={`recycle-tab${tab === 'core' ? ' active' : ''}`} onClick={() => switchTab('core')}>
          沉淀
        </button>
        <button className={`recycle-tab${tab === 'prophet' ? ' active' : ''}`} onClick={() => switchTab('prophet')}>
          预言家
        </button>
        <button className={`recycle-tab${tab === 'twelve' ? ' active' : ''}`} onClick={() => switchTab('twelve')}>
          十二问题
        </button>
      </div>

      {tab === 'core' && (
        <>
      <section className="zone">
        <div className="recycle-tabs" style={{ padding: '10px 12px 0' }}>
          {(
            [
              ['all', '全部'],
              ['4plus', '★4+'],
              ['5', '★5'],
              ['unrated', '未评']
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={`recycle-tab${starFilter === k ? ' active' : ''}`}
              onClick={() => setStarFilter(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="zone-body">
          {questions.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">self_improvement</span>
              还没有问题，点右上角「新问题」开始写下属于自己的答案
            </div>
          )}
          {questions.length > 0 && displayed.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">filter_alt</span>
              该筛选下没有问题
            </div>
          )}
          {displayed.map((q) => (
            <div className="row-item" key={q.id} onClick={() => void open(q, false)} title="点击打开答案版本">
              <div className="row-main">
                <div className="row-title">
                  <span
                    className={`material-symbols-outlined zj-origin${q.origin === 'ai' ? ' ai' : ''}`}
                    title={q.origin === 'ai' ? 'AI 生成' : '手动创建'}
                  >
                    {q.origin === 'ai' ? 'auto_awesome' : 'person'}
                  </span>
                  {q.title}
                </div>
                <div className="row-sub">
                  {(q.tags ?? []).slice(0, 4).map((t) => (
                    <span key={t} className="tag-chip mini">
                      {t}
                    </span>
                  ))}
                  {q.tags.length > 4 && <span className="tag-chip mini more">+{q.tags.length - 4}</span>}
                  　{q.version_count} 个版本 ｜ 更新 {fmtTime(q.updated_at)}
                </div>
              </div>
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className={`icon-btn zj-star${q.stars == null ? ' dim' : ''}`}
                  title={q.star_note ? `${'★'.repeat(q.stars ?? 0)} ${q.star_note}` : '未评星，点击设置星级'}
                  onClick={(e) => setStarMenu({ q, anchor: e.currentTarget })}
                >
                  <span className="material-symbols-outlined">{q.stars == null ? 'star_rate' : 'star'}</span>
                  {q.stars != null && <span className="zj-star-n">{q.stars}</span>}
                </button>
                <button
                  className="icon-btn danger"
                  title="删除（进回收站）"
                  onClick={() => setDiscardTarget(q)}
                >
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 答案版本弹窗：md 区 + 右侧内嵌追问栏（可收起/拖宽/多会话） */}
      <MdDialog
        open={viewQ != null}
        title={viewQ?.title ?? ''}
        filePath={curVersion?.md_path ?? ''}
        onClose={() => setViewQ(null)}
        onChanged={() => void load()}
        onTitleChange={viewQ ? (t) => void window.api.zhijiji.renameQuestion(viewQ.id, t).then(load) : undefined}
        autoEdit={autoEdit}
        versioned={{
          versions: versions.map((v) => ({ id: v.id, label: `v${v.seq}-${v.date}` })),
          currentId: curVerId,
          onSelect: (id) => setCurVerId(id),
          onSave: saveVersion,
          onAskAi: (content) => void askAi(content)
        }}
        sidePanel={
          viewQ ? (
            panelCollapsed ? (
              <ChannelChatRail title="追问" onExpand={togglePanel} />
            ) : (
              <ChannelChatPanel
                channel="zhijiji"
                sessionKey={SettingsKeys.AiActiveSessionZhijiji}
                title="追问"
                icon="contact_support"
                iconTitle="较真的朋友 · 只提问不代笔"
                placeholder="回应追问…"
                emptyHint="点版本条上的「让 AI 追问」，或直接在这里和 AI 讨论当前答案"
                stripPatterns={[PROFILE_SUGGEST_RE, PROFILE_LOOKUP_RE]}
                width={panelW}
                onWidthChange={changePanelW}
                onCollapse={togglePanel}
                autoAsk={askPrompt}
                onAutoAskConsumed={() => setAskPrompt(null)}
                onNeedConfig={() => setNeedConfig(true)}
              />
            )
          ) : undefined
        }
      />

      {/* 新问题弹窗（可选 AI 初始化答案 v0） */}
      {adding && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && !creating && setAdding(false)}>
          <div className="dialog" style={{ width: 440 }}>
            <div className="dialog-header">新问题</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                className="field"
                placeholder="问题标题（必填，如：线性代数和 AI 有什么渊源？）"
                value={addTitle}
                onChange={(e) => setAddTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void createQuestion()}
                autoFocus
              />
              <input
                className="field"
                placeholder="领域标签（可选，逗号或顿号分隔，如：线性代数、AI）"
                value={addTags}
                onChange={(e) => setAddTags(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void createQuestion()}
              />
              <label
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.9em', cursor: 'pointer' }}
                title="勾选后由 AI 先思考该问题并给出初始参考答案，记为 v0 版本；之后你在其上写自己的 v1、v2…"
              >
                <input
                  type="checkbox"
                  checked={addAiInit}
                  onChange={(e) => setAddAiInit(e.target.checked)}
                  style={{ accentColor: 'var(--color-primary)' }}
                />
                AI 初始化答案（生成 v0 参考答案，我再写自己的 v1）
              </label>
              <div className="module-sub">
                {addAiInit ? 'AI 生成约需十几秒，创建后会先展示 v0 供阅读' : '创建后直接打开空白 v1，双击即可开始写属于你的答案'}
              </div>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAdding(false)} disabled={creating}>
                取消
              </button>
              {createJob && (
                <button
                  className="btn"
                  onClick={() => void window.api.ai.cancel(createJob)}
                  title="取消本次生成"
                >
                  <span className="material-symbols-outlined">stop_circle</span>
                  取消
                </button>
              )}
              <button className="btn btn-primary" onClick={() => void createQuestion()} disabled={creating}>
                {creating ? 'AI 思考中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除二次确认（全局规则） */}
      <ConfirmDialog
        open={discardTarget != null}
        title="删除问题"
        confirmText="删除"
        danger
        onConfirm={() => void doDiscard()}
        onCancel={() => setDiscardTarget(null)}
      >
        将删除问题「{discardTarget?.title}」并放入回收站（全部版本答案一并封存，3 天后彻底删除）。
      </ConfirmDialog>

      {/* 改星菜单（ActionMenu 复用：五档直选 + 清除） */}
      {starMenu && (
        <ActionMenu
          anchorEl={starMenu.anchor}
          onClose={() => setStarMenu(null)}
          items={[
            ...[5, 4, 3, 2, 1].map((n) => ({
              key: `s${n}`,
              icon: 'star',
              label: `${'★'.repeat(n)}（${n} 星）`,
              onClick: () => void applyStars(starMenu.q, n)
            })),
            {
              key: 'clear',
              icon: 'block',
              label: '清除星级',
              separatorAbove: true,
              onClick: () => void applyStars(starMenu.q, null)
            }
          ]}
        />
      )}

      {/* AI 出题候选弹窗（260912 分级；勾选采纳，灵感泉/万象库审核范式） */}
      {suggestions && (
        <div
          className="dialog-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && suggestJob == null && setSuggestions(null)}
        >
          <div className="dialog" style={{ width: 560 }}>
            <div className="dialog-header">AI 出题 · 候选问题</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {suggestions.length === 0 ? (
                <div className="module-sub">AI 正在结合你的画像与高星问题特征出题…</div>
              ) : (
                suggestions.map((c, i) => (
                  <label
                    key={i}
                    className="zj-cand"
                    style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(i)}
                      onChange={(e) =>
                        setPicked((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(i)
                          else next.delete(i)
                          return next
                        })
                      }
                      style={{ marginTop: 4, accentColor: 'var(--color-primary)' }}
                    />
                    <div>
                      <div>{c.title}</div>
                      <div className="module-sub">
                        {'★'.repeat(c.stars)} {c.note}
                      </div>
                    </div>
                  </label>
                ))
              )}
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setSuggestions(null)} disabled={suggestJob != null}>
                取消
              </button>
              {suggestJob && (
                <button
                  className="btn"
                  onClick={() => void window.api.ai.cancel(suggestJob)}
                  title="取消本次生成"
                >
                  <span className="material-symbols-outlined">stop_circle</span>
                  取消
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={() => void adoptSuggestions()}
                disabled={suggestJob != null || picked.size === 0}
              >
                采纳{picked.size > 0 ? `（${picked.size}）` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LLM 未配置引导（全局规则：不置灰，点击提示 + 去配置） */}
      <GoConfigDialog
        open={needConfig}
        kind="llm"
        onGoConfig={() => {
          setNeedConfig(false)
          props.onNavigateToProfile()
        }}
        onCancel={() => setNeedConfig(false)}
      />
        </>
      )}

      {tab === 'prophet' && (
        <ProphetPanel
          onOpenAi={props.onOpenAi}
          bumpAi={props.bumpAi}
          onNavigateToProfile={props.onNavigateToProfile}
        />
      )}
      {tab === 'twelve' && (
        <TwelvePanel onOpenAi={props.onOpenAi} onNavigateToProfile={props.onNavigateToProfile} />
      )}
    </div>
  )
}
