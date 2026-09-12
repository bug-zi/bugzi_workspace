// 学习库模块（学习库 specs 全量）：今日学习 / 知识树 / 高光笔记 三 tab
// 知识树（领域→主题→知识点，懒建树）+ 每日新学 3-5 张 + 间隔复习 1/3/7/15 天 + 划词高光/问 AI。
// 卡片 md 在 md/learn/<id>.md（扁平路径）；问 AI 走「学习·问答」频道（App 层 CHANNEL_BY_MODULE 映射）。
import { useCallback, useEffect, useState } from 'react'
import type {
  LearnDomain,
  LearnTopicView,
  LearnCardRow,
  LearnDailyRow,
  LearnHighlightRow,
  LearnNode
} from '../../renderer/api'
import type { AiChannel } from '../../shared/types'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import LearnQuizZone from './LearnQuizZone'
import LearnTaskDialog from './LearnTaskDialog'
import { cancelLearnGen, enqueueLearnGen, setLearnQueueHandlers, useLearnQueue } from '../../services/learnGenQueue'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

export interface LearnModuleProps {
  /** 问 AI：频道由 App 层 CHANNEL_BY_MODULE（learn → 学习·问答）自动映射 */
  onOpenAi: (prefill?: string, opts?: { auto?: boolean; channel?: AiChannel }) => void
}

/** 本地日期 YYYY-MM-DD（到期判断用，与主进程 localDateStr 同口径） */
function todayStr(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

/** 今天距 date 的天数（date ≥ 今天） */
function daysUntil(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const target = new Date(y, m - 1, d)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target.getTime() - today.getTime()) / 86400000)
}

/** 到期（今日应复习）：已学、未毕业、下次复习日 ≤ 今天 */
function isDue(n: { state: string; review_stage: number; next_review_at: string | null }): boolean {
  return (
    n.state === 'learned' &&
    n.review_stage >= 1 &&
    n.review_stage <= 4 &&
    n.next_review_at != null &&
    n.next_review_at <= todayStr()
  )
}

/** 树/列表行的状态图标 */
function stateIcon(n: { state: string; review_stage: number }): string {
  if (n.state === 'todo') return 'radio_button_unchecked'
  return n.review_stage >= 5 ? 'verified' : 'task_alt'
}

/** 行首图标（待加载队列版）：排队中/生成中优先于学习状态图标（相位来自 learnGenQueue store） */
function RowIcon(props: { n: LearnNode; gen?: 'queued' | 'loading' }) {
  if (props.gen != null) {
    return (
      <span className={`material-symbols-outlined${props.gen === 'loading' ? ' spin' : ''}`}>
        {props.gen === 'loading' ? 'progress_activity' : 'hourglass_top'}
      </span>
    )
  }
  return <span className="material-symbols-outlined">{stateIcon(props.n)}</span>
}

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function LearnModule(props: LearnModuleProps) {
  const { toast } = useToast()
  const [tab, setTab] = useState<'daily' | 'tree' | 'notes'>('daily')
  // 今日学习
  const [dailyNew, setDailyNew] = useState<LearnDailyRow[]>([])
  const [dailyReview, setDailyReview] = useState<LearnDailyRow[]>([])
  // 知识树
  const [domains, setDomains] = useState<LearnDomain[]>([])
  const [domainId, setDomainId] = useState<number | null>(null)
  const [tree, setTree] = useState<LearnTopicView[]>([])
  // 高光
  const [highlights, setHighlights] = useState<LearnHighlightRow[]>([])
  // 卡片弹窗
  const [card, setCard] = useState<LearnCardRow | null>(null)
  const [mdVersion, setMdVersion] = useState(0)
  // 待加载队列（优化区2 + 260912 面板）：状态在 learnGenQueue 全局 store（LlmActivity 面板同源读取）
  const queue = useLearnQueue()
  const [queueOpen, setQueueOpen] = useState(false)
  // 主题折叠（优化区3）：会话内记忆
  const [collapsedTopics, setCollapsedTopics] = useState<Set<number>>(new Set())
  // 今日小测答错的节点（LearnQuizZone 上抛，行内标记）
  const [wrongNodes, setWrongNodes] = useState<Set<number>>(new Set())
  // 实战任务弹窗（主题行入口）
  const [taskTopic, setTaskTopic] = useState<{ id: number; title: string } | null>(null)
  const [randomJob, setRandomJob] = useState<string | null>(null)
  // 生成 job（建树/展开/手动加）
  const [treeJob, setTreeJob] = useState<string | null>(null)
  const [expandJob, setExpandJob] = useState<string | null>(null)
  const [addJob, setAddJob] = useState<string | null>(null)
  // 弹窗与菜单
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const [goConfig, setGoConfig] = useState(false)
  const [delNodeTarget, setDelNodeTarget] = useState<LearnNode | LearnDailyRow | null>(null)
  const [delTopicTarget, setDelTopicTarget] = useState<LearnTopicView | null>(null)
  const [delDomainTarget, setDelDomainTarget] = useState<LearnDomain | null>(null)
  const [delHighlightTarget, setDelHighlightTarget] = useState<LearnHighlightRow | null>(null)
  const [topicMenu, setTopicMenu] = useState<{ topic: LearnTopicView; left: number; top: number } | null>(null)
  const [domainMenu, setDomainMenu] = useState<{ left: number; top: number } | null>(null)
  const [addDomainOpen, setAddDomainOpen] = useState(false)
  const [newDomainName, setNewDomainName] = useState('')
  const [renameDomainOpen, setRenameDomainOpen] = useState(false)
  const [renameDomainName, setRenameDomainName] = useState('')
  const [addTopicOpen, setAddTopicOpen] = useState(false)
  const [newTopicTitle, setNewTopicTitle] = useState('')
  const [renameTopicTarget, setRenameTopicTarget] = useState<LearnTopicView | null>(null)
  const [renameTopicTitle, setRenameTopicTitle] = useState('')
  const [addPointTarget, setAddPointTarget] = useState<LearnTopicView | null>(null)
  const [addPointTitle, setAddPointTitle] = useState('')

  const loadDomains = useCallback(async () => {
    setDomains(await window.api.learn.domains())
  }, [])

  const loadTree = useCallback(async (did: number) => {
    setTree(await window.api.learn.tree(did))
  }, [])

  const loadDaily = useCallback(async () => {
    const v = await window.api.learn.daily()
    setDailyNew(v.new)
    setDailyReview(v.review)
  }, [])

  const loadHighlights = useCallback(async () => {
    setHighlights(await window.api.learn.highlights())
  }, [])

  const reloadAll = useCallback(async (): Promise<void> => {
    await loadDomains()
    await loadDaily()
    await loadHighlights()
    const cur = domainId ?? (await window.api.learn.domains())[0]?.id ?? null
    if (cur != null) {
      setDomainId(cur)
      await loadTree(cur)
    } else {
      setTree([])
    }
  }, [domainId, loadDomains, loadDaily, loadHighlights, loadTree])

  useEffect(() => {
    void reloadAll()
  }, [reloadAll])

  // keep-alive：切回学习库刷新（后台泵可能已补卡）+ 泵触发
  useModuleActivated('learn', () => {
    void loadDomains()
    void loadDaily()
    void loadHighlights()
    if (domainId != null) void loadTree(domainId)
    void window.api.learn.stockCheck()
  })

  // 泵产出渐进到达（learn:stockChanged）：今日列表与树进度刷新
  useEffect(
    () =>
      window.api.learn.onStockChanged(() => {
        void loadDaily()
        void loadDomains()
        if (domainId != null) void loadTree(domainId)
      }),
    [loadDaily, loadDomains, loadTree, domainId]
  )

  /** 统一的 AI 调用错误口径（已取消静默 toast / 未配置直达 / 其余失败弹窗） */
  const handleAiError = (e: unknown): void => {
    const msg = String((e as Error).message)
    if (msg.includes('已取消')) toast('已取消')
    else if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
    else setFailMsg(msg)
  }

  /** 待加载队列：就绪后行内实时补上 content_ready（免整树重拉） */
  const markCardReady = useCallback((id: number) => {
    const patch = <T extends LearnNode>(rows: T[]): T[] =>
      rows.map((r) => (r.id === id ? { ...r, content_ready: 1 as const } : r))
    setDailyNew((rows) => patch(rows))
    setTree((topics) => topics.map((t) => ({ ...t, points: patch(t.points) })))
  }, [])

  /** 队列回调注册：就绪回写行 content_ready；失败按既有口径提示（取消静默、未配置去配置） */
  useEffect(() => {
    setLearnQueueHandlers({
      onReady: (id) => markCardReady(id),
      onFail: (_id, title, msg) => {
        if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
        else if (!msg.includes('已取消')) toast(`「${title}」生成失败，可再次点击重试`)
      }
    })
  }, [markCardReady, toast])

  /** 打开卡片：已生成秒开弹窗；未生成 → 加入待加载队列（行内排队/生成中反馈，就绪后行恢复常态再点查看） */
  const openCard = (n: { id: number; content_ready: number; title?: string }): void => {
    if (n.content_ready === 1) {
      if (card != null) return
      window.api.learn
        .getCard(crypto.randomUUID(), n.id)
        .then((c) => setCard(c))
        .catch(handleAiError)
      return
    }
    if (queue.phaseOf(n.id) != null) return
    enqueueLearnGen({ id: n.id, title: n.title ?? '' })
  }

  const toggleTopic = (id: number): void => {
    setCollapsedTopics((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 随机来一条：优先已生成未学卡秒开；无则现场生成 */
  const runRandom = async (): Promise<void> => {
    if (randomJob) return
    const jobId = crypto.randomUUID()
    setRandomJob(jobId)
    try {
      setCard(await window.api.learn.randomOne(jobId))
    } catch (e) {
      handleAiError(e)
    } finally {
      setRandomJob(null)
    }
  }

  /** 建树（懒建树显式触发） */
  const runGenerateTree = async (did: number): Promise<void> => {
    if (treeJob) return
    const jobId = crypto.randomUUID()
    setTreeJob(jobId)
    try {
      const r = await window.api.learn.generateTree(jobId, did)
      toast(`知识树已生成：${r.topics} 个主题 · ${r.points} 个知识点`)
      await loadDomains()
      await loadTree(did)
    } catch (e) {
      handleAiError(e)
    } finally {
      setTreeJob(null)
    }
  }

  /** AI 展开主题 */
  const runExpand = async (topicId: number): Promise<void> => {
    if (expandJob) return
    const jobId = crypto.randomUUID()
    setExpandJob(jobId)
    try {
      const r = await window.api.learn.expandTopic(jobId, topicId)
      toast(`已展开：新增 ${r.points} 个知识点`)
      if (domainId != null) await loadTree(domainId)
      await loadDomains()
    } catch (e) {
      handleAiError(e)
    } finally {
      setExpandJob(null)
    }
  }

  /** 手动添加知识点（工作即学即用入口） */
  const runAddPoint = async (): Promise<void> => {
    if (!addPointTarget || addJob) return
    const title = addPointTitle.trim()
    if (!title) return
    const jobId = crypto.randomUUID()
    setAddJob(jobId)
    try {
      const c = await window.api.learn.nodeAdd(jobId, addPointTarget.id, title)
      setAddPointTarget(null)
      setAddPointTitle('')
      toast(`已添加知识点「${title}」`)
      if (domainId != null) await loadTree(domainId)
      await loadDomains()
      setCard(c)
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.startsWith('CONFLICT:')) {
        toast('该主题下已存在同名知识点')
        setAddPointTarget(null)
        setAddPointTitle('')
      } else {
        handleAiError(e)
      }
    } finally {
      setAddJob(null)
    }
  }

  /** 学习操作后的统一刷新（今日列表 + 树进度 + 弹窗按钮态） */
  const refreshAfterMark = useCallback(async (): Promise<void> => {
    await loadDaily()
    await loadDomains()
    if (domainId != null) await loadTree(domainId)
    if (card != null) {
      setCard(await window.api.learn.getCard(crypto.randomUUID(), card.id))
    }
  }, [loadDaily, loadDomains, loadTree, domainId, card])

  const onLearn = async (): Promise<void> => {
    if (!card) return
    await window.api.learn.mark(card.id, 'learn')
    toast('已学会，明天复习')
    await refreshAfterMark()
  }

  const onRemember = async (): Promise<void> => {
    if (!card) return
    const ok = await window.api.learn.mark(card.id, 'remember')
    if (ok) toast(card.review_stage >= 4 ? '已记住，毕业！' : `已记住，${[3, 7, 15][card.review_stage - 1]} 天后复习`)
    await refreshAfterMark()
  }

  const onForget = async (): Promise<void> => {
    if (!card) return
    await window.api.learn.mark(card.id, 'forget')
    toast('没关系，明天再来')
    await refreshAfterMark()
  }

  /** 划词高光：md 内包裹 ==标记== + 记入高光笔记（万象库同款） */
  const onHighlight = useCallback(
    async (text: string) => {
      if (!card) return
      const p = `md/learn/${card.id}.md`
      const md = await window.api.md.read(p)
      const wrapped = `==${text}==`
      if (!md.includes(wrapped) && md.includes(text)) {
        await window.api.md.write(p, md.replace(text, wrapped))
      }
      await window.api.learn.addHighlight(card.id, text)
      setMdVersion((v) => v + 1)
      setCard(await window.api.learn.getCard(crypto.randomUUID(), card.id))
      await loadHighlights()
      toast('已加入高光')
    },
    [card, loadHighlights, toast]
  )

  const onAskAi = useCallback(
    (text: string) => {
      props.onOpenAi(`关于知识点「${card?.title ?? ''}」：「${text}」\n\n请帮我讲解。`)
    },
    [props]
  )

  /** 深挖（升级设计 §四）：带卡文一键自动发右栏「学习·问答」频道（App 层 CHANNEL_BY_MODULE 自动映射） */
  const onDig = useCallback(
    async (c: LearnCardRow) => {
      let md = ''
      try {
        md = await window.api.md.read(`md/learn/${c.id}.md`)
      } catch {
        toast('卡片内容读取失败')
        return
      }
      const pre = `请深挖知识点「${c.title}」（领域：${c.domain_name} · 主题：${c.topic_title ?? '（无）'}）。结合下面的卡片内容，从四个角度展开：1）原理再进一层（卡片没讲到的机制细节）；2）常见误解与易错点；3）知识串联（同主题其他知识点与跨主题关联）；4）实际工作中的坑与经验。\n\n<卡片内容>\n${md}\n</卡片内容>`
      props.onOpenAi(pre, { auto: true })
    },
    [props, toast]
  )

  const doDiscardNode = async (): Promise<void> => {
    if (!delNodeTarget) return
    await window.api.learn.nodeDelete(delNodeTarget.id)
    toast('已放入回收站')
    setDelNodeTarget(null)
    setCard(null)
    await loadDaily()
    await loadDomains()
    if (domainId != null) await loadTree(domainId)
    await loadHighlights()
  }

  const currentDomain = domains.find((d) => d.id === domainId) ?? null
  const learnedToday = dailyNew.filter((n) => n.state === 'learned').length
  const queueLoading = queue.items.filter((i) => i.phase === 'loading').length
  const queueTotal = queue.items.length
  const anyTreeReady = domains.some((d) => d.tree_ready === 1)

  /** 学习操作条（弹窗 footer）：todo→学会了；到期→记住了/忘记了；其余只读态 */
  const studyBarOf = (c: LearnCardRow) => {
    if (c.state === 'todo') return { mode: 'new' as const, onLearn: () => void onLearn() }
    if (isDue(c)) {
      return {
        mode: 'review' as const,
        onRemember: () => void onRemember(),
        onForget: () => void onForget()
      }
    }
    const statusText =
      c.review_stage >= 5
        ? '已毕业'
        : c.next_review_at != null
          ? `已学 · ${daysUntil(c.next_review_at) <= 1 ? '明天' : `${daysUntil(c.next_review_at)} 天后`}复习`
          : '已学'
    return { mode: 'done' as const, statusText }
  }

  // ---------- 渲染 ----------
  return (
    <div className="module-page">
      <div className="module-header">
        <span className="material-symbols-outlined">school</span>
        <span className="module-title">学习库</span>
        <span className="module-sub">计算机专业知识 · 知识树 + 每日新学与间隔复习</span>
        {queueTotal > 0 && (
          <button
            className="btn"
            style={{ marginLeft: 'auto' }}
            title="查看生成队列（可取消排队/生成中的卡片）"
            onClick={() => setQueueOpen((v) => !v)}
          >
            <span className="material-symbols-outlined">low_priority</span>
            生成队列
            <span className="zone-count">
              生成中 {queueLoading} · 排队 {queueTotal - queueLoading}
            </span>
          </button>
        )}
      </div>

      {/* 生成队列面板（可视化 + 逐项取消） */}
      {queueOpen && queueTotal > 0 && (
        <>
          <div
            className="dialog-overlay"
            style={{ background: 'transparent' }}
            onMouseDown={() => setQueueOpen(false)}
          />
          <div className="ctx-menu" style={{ position: 'fixed', top: 60, right: 16, minWidth: 280, zIndex: 300 }}>
            {queue.items.map((job) => (
              <div
                key={job.id}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', minWidth: 240 }}
              >
                <span
                  className={`material-symbols-outlined${job.phase === 'loading' ? ' spin' : ''}`}
                  style={{ fontSize: 16 }}
                >
                  {job.phase === 'loading' ? 'progress_activity' : 'hourglass_top'}
                </span>
                <span
                  style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={job.title}
                >
                  {job.title}
                </span>
                <span className="module-sub" style={{ flexShrink: 0 }}>
                  {job.phase === 'loading' ? '生成中' : '排队中'}
                </span>
                <button
                  className="icon-btn"
                  title={job.phase === 'loading' ? '取消生成' : '移出队列'}
                  onClick={() => {
                    cancelLearnGen(job.id)
                    toast('已取消')
                  }}
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="recycle-tabs">
        <button className={`recycle-tab${tab === 'daily' ? ' active' : ''}`} onClick={() => setTab('daily')}>
          今日学习
          <span className="zone-count">{dailyNew.length + dailyReview.length}</span>
        </button>
        <button className={`recycle-tab${tab === 'tree' ? ' active' : ''}`} onClick={() => setTab('tree')}>
          知识树
        </button>
        <button className={`recycle-tab${tab === 'notes' ? ' active' : ''}`} onClick={() => setTab('notes')}>
          高光笔记
          <span className="zone-count">{highlights.length}</span>
        </button>
      </div>

      {/* ===== 今日学习 ===== */}
      <div className={tab === 'daily' ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== 'daily'}>
        <div className="card" style={{ padding: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={() => void runRandom()} disabled={randomJob != null}>
            <span className={`material-symbols-outlined${randomJob ? ' spin' : ''}`}>casino</span>
            {randomJob ? '生成中…' : '随机来一条'}
          </button>
          {randomJob && (
            <button className="btn" onClick={() => void window.api.ai.cancel(randomJob)} title="取消本次生成">
              <span className="material-symbols-outlined">stop_circle</span>
              取消
            </button>
          )}
          <span className="module-sub" style={{ marginLeft: 'auto' }}>
            学会了进入 1/3/7/15 天间隔复习
          </span>
        </div>

        <div className="zone">
          <div className="zone-header" style={{ cursor: 'default' }}>
            <span className="material-symbols-outlined">fiber_new</span>
            <span>今日新学</span>
            <span className="zone-count">{dailyNew.length}</span>
          </div>
          <div className="zone-body">
            {dailyNew.length === 0 && (
              <div className="empty-state">
                <span className="material-symbols-outlined">school</span>
                {anyTreeReady
                  ? '树都学完了，去知识树 AI 展开主题或手动添加知识点'
                  : '还没有已建树领域，去「知识树」生成知识树'}
              </div>
            )}
            {dailyNew.map((n) => (
              <div
                className={`row-item${n.content_ready === 0 ? ' row-pending' : ''}`}
                key={n.id}
                onClick={() => openCard(n)}
                style={{ cursor: queue.phaseOf(n.id) === 'loading' ? 'wait' : undefined }}
              >
                <RowIcon n={n} gen={queue.phaseOf(n.id) ?? undefined} />
                <div className="row-main">
                  <div className="row-title">
                    {n.title}
                    {wrongNodes.has(n.id) && (
                      <span className="material-symbols-outlined quiz-wrong-mark" title="今日小测答错">
                        error
                      </span>
                    )}
                  </div>
                  <div className="row-sub">
                    {n.domain_name} · {n.topic_title} ｜ {n.summary}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="zone">
          <div className="zone-header" style={{ cursor: 'default' }}>
            <span className="material-symbols-outlined">history_edu</span>
            <span>到期复习</span>
            <span className="zone-count">{dailyReview.length}</span>
          </div>
          <div className="zone-body">
            {dailyReview.length === 0 && (
              <div className="empty-state">
                <span className="material-symbols-outlined">history_edu</span>
                今日暂无到期复习卡
              </div>
            )}
            {dailyReview.map((n) => (
              <div className="row-item" key={n.id} onClick={() => openCard(n)}>
                <RowIcon n={n} />
                <div className="row-main">
                  <div className="row-title">{n.title}</div>
                  <div className="row-sub">
                    {n.domain_name} · {n.topic_title} ｜ 第 {[0, 1, 3, 7, 15][n.review_stage] ?? 0}天档
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <LearnQuizZone learnedCount={learnedToday} onWrongChange={setWrongNodes} />
      </div>

      {/* ===== 知识树 ===== */}
      <div className={tab === 'tree' ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== 'tree'}>
        <div className="recycle-tabs" style={{ flexWrap: 'wrap' }}>
          {domains.map((dm) => (
            <button
              key={dm.id}
              className={`recycle-tab${domainId === dm.id ? ' active' : ''}`}
              onClick={() => {
                setDomainId(dm.id)
                void loadTree(dm.id)
              }}
              title={dm.tree_ready === 1 ? `已学 ${dm.learned}/${dm.total}` : '尚未生成知识树'}
            >
              {dm.name}
              <span className="zone-count">
                {dm.tree_ready === 1 ? `${dm.learned}/${dm.total}` : '未建树'}
              </span>
            </button>
          ))}
          <button className="recycle-tab" onClick={() => setAddDomainOpen(true)} title="新建领域">
            <span className="material-symbols-outlined">add</span>
          </button>
        </div>

        {currentDomain && currentDomain.tree_ready === 0 && (
          <div className="zone">
            <div className="zone-body">
              <div className="empty-state">
                <span className="material-symbols-outlined">park</span>
                <div>「{currentDomain.name}」还没有知识树</div>
                <button
                  className="btn btn-primary"
                  onClick={() => void runGenerateTree(currentDomain.id)}
                  disabled={treeJob != null}
                >
                  <span className={`material-symbols-outlined${treeJob ? ' spin' : ''}`}>park</span>
                  {treeJob ? '生成中…' : '生成知识树'}
                </button>
                {treeJob && (
                  <button className="btn" onClick={() => void window.api.ai.cancel(treeJob)}>
                    <span className="material-symbols-outlined">stop_circle</span>
                    取消
                  </button>
                )}
                <div className="module-sub">AI 生成 5-8 个主题 × 每主题 5-8 个知识点的骨架</div>
              </div>
            </div>
          </div>
        )}

        {currentDomain && currentDomain.tree_ready === 1 && (
          <>
            <div className="card" style={{ padding: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
              <span className="module-sub">
                「{currentDomain.name}」已学 {currentDomain.learned}/{currentDomain.total}
              </span>
              <div className="row-actions" style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" title="新建主题" onClick={() => setAddTopicOpen(true)}>
                  <span className="material-symbols-outlined">add</span>
                </button>
                <button
                  className="icon-btn"
                  title="领域管理"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setDomainMenu({ left: r.right, top: r.bottom + 4 })
                  }}
                >
                  <span className="material-symbols-outlined">more_vert</span>
                </button>
              </div>
            </div>
            {tree.map((t) => {
              const collapsed = collapsedTopics.has(t.id)
              return (
                <div className="zone" key={t.id}>
                  <div
                    className="zone-header"
                    style={{ cursor: 'pointer' }}
                    title={collapsed ? '展开主题' : '收起主题'}
                    onClick={() => toggleTopic(t.id)}
                  >
                    <span className="material-symbols-outlined">{collapsed ? 'chevron_right' : 'expand_more'}</span>
                    <span className="material-symbols-outlined">folder_open</span>
                    <span>{t.title}</span>
                    <span className="zone-count" title="已学/知识点数">
                      已学 {t.learned}/{t.total}
                    </span>
                    <div className="row-actions" style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
                      <button
                        className="icon-btn"
                        title="AI 展开：补充 3-5 个知识点"
                        disabled={expandJob != null}
                        onClick={() => void runExpand(t.id)}
                      >
                        <span className={`material-symbols-outlined${expandJob ? ' spin' : ''}`}>auto_awesome</span>
                      </button>
                      {expandJob && (
                        <button
                          className="icon-btn"
                          title="取消本次展开"
                          onClick={() => void window.api.ai.cancel(expandJob)}
                        >
                          <span className="material-symbols-outlined">stop_circle</span>
                        </button>
                      )}
                      <button
                        className="icon-btn"
                        title="实战任务：30 分钟小任务 + AI 点评"
                        onClick={() => setTaskTopic({ id: t.id, title: t.title })}
                      >
                        <span className="material-symbols-outlined">construction</span>
                      </button>
                      <button
                        className="icon-btn"
                        title="主题管理"
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect()
                          setTopicMenu({ topic: t, left: r.right, top: r.bottom + 4 })
                        }}
                      >
                        <span className="material-symbols-outlined">more_vert</span>
                      </button>
                    </div>
                  </div>
                  {!collapsed && (
                    <div className="zone-body">
                      {t.points.length === 0 && (
                        <div className="empty-state">
                          <span className="material-symbols-outlined">radio_button_unchecked</span>
                          暂无知识点：AI 展开或手动添加
                        </div>
                      )}
                      {t.points.map((p) => (
                        <div
                          className={`row-item${p.content_ready === 0 ? ' row-pending' : ''}`}
                          key={p.id}
                          onClick={() => openCard(p)}
                          style={{ cursor: queue.phaseOf(p.id) === 'loading' ? 'wait' : undefined }}
                        >
                          <RowIcon n={p} gen={queue.phaseOf(p.id) ?? undefined} />
                          <div className="row-main">
                            <div className="row-title">{p.title}</div>
                            <div className="row-sub">{p.summary}</div>
                          </div>
                          <div className="row-actions" onClick={(ev) => ev.stopPropagation()}>
                            <button className="icon-btn" title="查看" onClick={() => openCard(p)}>
                              <span className="material-symbols-outlined">visibility</span>
                            </button>
                            <button className="icon-btn danger" title="回收站" onClick={() => setDelNodeTarget(p)}>
                              <span className="material-symbols-outlined">delete</span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* ===== 高光笔记 ===== */}
      <div className={tab === 'notes' ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== 'notes'}>
        <div className="zone">
          <div className="zone-header" style={{ cursor: 'default' }}>
            <span className="material-symbols-outlined">bookmark</span>
            <span>高光笔记</span>
            <span className="zone-count">{highlights.length}</span>
          </div>
          <div className="zone-body">
            {highlights.length === 0 && (
              <div className="empty-state">
                <span className="material-symbols-outlined">bookmark</span>
                暂无高光：在卡片中划选文本即可添加
              </div>
            )}
            {highlights.map((h) => (
              <div
                className="row-item"
                key={h.id}
                onClick={() => openCard({ id: h.node_id, content_ready: 1 })}
              >
                <div className="row-main">
                  <div className="row-title" style={{ whiteSpace: 'normal' }}>
                    {h.text}
                  </div>
                  <div className="row-sub">
                    {h.title} ｜ {fmtTime(h.created_at)}
                  </div>
                </div>
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn danger" title="删除" onClick={() => setDelHighlightTarget(h)}>
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 卡片弹窗（划词能力 + 学习操作条；md 路径派生 md/learn/<id>.md） */}
      <MdDialog
        key={card?.id ?? 'none'}
        open={card != null}
        title={card?.title ?? ''}
        titleTag={card ? `${card.domain_name} · ${card.topic_title ?? ''}` : undefined}
        filePath={card ? `md/learn/${card.id}.md` : ''}
        onClose={() => setCard(null)}
        onChanged={() => setMdVersion((v) => v + 1)}
        selectionActions={{ onHighlight: (t) => void onHighlight(t), onAskAi }}
        studyBar={card ? { ...studyBarOf(card), onDig: () => void onDig(card) } : undefined}
      />

      {taskTopic && <LearnTaskDialog topic={taskTopic} onClose={() => setTaskTopic(null)} />}

      {/* 领域悬浮菜单 */}
      {domainMenu && currentDomain && (
        <>
          <div
            className="dialog-overlay"
            style={{ background: 'transparent' }}
            onMouseDown={() => setDomainMenu(null)}
          />
          <div
            className="ctx-menu"
            style={{ position: 'fixed', top: domainMenu.top, left: Math.max(8, domainMenu.left - 150), zIndex: 300 }}
          >
            <button
              className="btn btn-ghost"
              onClick={() => {
                setRenameDomainName(currentDomain.name)
                setRenameDomainOpen(true)
                setDomainMenu(null)
              }}
            >
              <span className="material-symbols-outlined">edit</span>
              改名
            </button>
            <button
              className="btn btn-ghost btn-danger"
              onClick={() => {
                setDelDomainTarget(currentDomain)
                setDomainMenu(null)
              }}
            >
              <span className="material-symbols-outlined">delete</span>
              删除领域
            </button>
          </div>
        </>
      )}

      {/* 主题悬浮菜单 */}
      {topicMenu && (
        <>
          <div
            className="dialog-overlay"
            style={{ background: 'transparent' }}
            onMouseDown={() => setTopicMenu(null)}
          />
          <div
            className="ctx-menu"
            style={{ position: 'fixed', top: topicMenu.top, left: Math.max(8, topicMenu.left - 150), zIndex: 300 }}
          >
            <button
              className="btn btn-ghost"
              disabled={expandJob != null}
              onClick={() => {
                const tid = topicMenu.topic.id
                setTopicMenu(null)
                void runExpand(tid)
              }}
            >
              <span className="material-symbols-outlined">auto_awesome</span>
              AI 展开（补 3-5 个知识点）
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setAddPointTarget(topicMenu.topic)
                setAddPointTitle('')
                setTopicMenu(null)
              }}
            >
              <span className="material-symbols-outlined">edit_note</span>
              手动添加知识点
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setRenameTopicTarget(topicMenu.topic)
                setRenameTopicTitle(topicMenu.topic.title)
                setTopicMenu(null)
              }}
            >
              <span className="material-symbols-outlined">edit</span>
              改名
            </button>
            <button
              className="btn btn-ghost btn-danger"
              onClick={() => {
                setDelTopicTarget(topicMenu.topic)
                setTopicMenu(null)
              }}
            >
              <span className="material-symbols-outlined">delete</span>
              删除主题
            </button>
          </div>
        </>
      )}

      {/* 新建领域 */}
      {addDomainOpen && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAddDomainOpen(false)}>
          <div className="dialog" style={{ width: 380 }}>
            <div className="dialog-header">新建领域</div>
            <div className="dialog-body">
              <input
                className="field"
                value={newDomainName}
                onChange={(e) => setNewDomainName(e.target.value)}
                placeholder="领域名（如：编译原理）"
              />
              <div className="module-sub">创建后进入该领域点「生成知识树」建骨架</div>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAddDomainOpen(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={!newDomainName.trim()}
                onClick={() => {
                  void window.api.learn
                    .domainCreate(newDomainName.trim())
                    .then(async (id) => {
                      setAddDomainOpen(false)
                      setNewDomainName('')
                      await loadDomains()
                      setDomainId(id)
                      await loadTree(id)
                      toast('领域已创建，点「生成知识树」开始')
                    })
                    .catch((e: unknown) => {
                      toast(String((e as Error).message).startsWith('CONFLICT:') ? '该领域已存在' : '创建失败')
                    })
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 领域改名 */}
      {renameDomainOpen && currentDomain && (
        <div
          className="dialog-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && setRenameDomainOpen(false)}
        >
          <div className="dialog" style={{ width: 360 }}>
            <div className="dialog-header">领域改名</div>
            <div className="dialog-body">
              <input className="field" value={renameDomainName} onChange={(e) => setRenameDomainName(e.target.value)} />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setRenameDomainOpen(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  void window.api.learn
                    .domainRename(currentDomain.id, renameDomainName.trim())
                    .then(async () => {
                      setRenameDomainOpen(false)
                      await loadDomains()
                    })
                    .catch(() => toast('该名称已存在'))
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除领域（清空才能删） */}
      {delDomainTarget && (
        <ConfirmDialog
          open
          title="删除领域"
          confirmText="删除"
          danger
          onConfirm={() => {
            void window.api.learn
              .domainDelete(delDomainTarget.id)
              .then(async () => {
                setDelDomainTarget(null)
                toast('领域已删除')
                const rest = await window.api.learn.domains()
                setDomains(rest)
                setDomainId(rest[0]?.id ?? null)
                if (rest[0]) await loadTree(rest[0].id)
                else setTree([])
              })
              .catch(() => {
                toast('领域下还有主题，需先清空才能删除')
                setDelDomainTarget(null)
              })
          }}
          onCancel={() => setDelDomainTarget(null)}
        >
          仅空领域可删除；领域「{delDomainTarget.name}」下的主题需先清空。
        </ConfirmDialog>
      )}

      {/* 新建主题 */}
      {addTopicOpen && currentDomain && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAddTopicOpen(false)}>
          <div className="dialog" style={{ width: 360 }}>
            <div className="dialog-header">新建主题</div>
            <div className="dialog-body">
              <input
                className="field"
                value={newTopicTitle}
                onChange={(e) => setNewTopicTitle(e.target.value)}
                placeholder="主题名"
              />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAddTopicOpen(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={!newTopicTitle.trim()}
                onClick={() => {
                  void window.api.learn.topicCreate(currentDomain.id, newTopicTitle.trim()).then(async () => {
                    setAddTopicOpen(false)
                    setNewTopicTitle('')
                    await loadTree(currentDomain.id)
                  })
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 主题改名 */}
      {renameTopicTarget && (
        <div
          className="dialog-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && setRenameTopicTarget(null)}
        >
          <div className="dialog" style={{ width: 360 }}>
            <div className="dialog-header">主题改名</div>
            <div className="dialog-body">
              <input
                className="field"
                value={renameTopicTitle}
                onChange={(e) => setRenameTopicTitle(e.target.value)}
              />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setRenameTopicTarget(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  void window.api.learn
                    .topicRename(renameTopicTarget.id, renameTopicTitle.trim())
                    .then(async () => {
                      setRenameTopicTarget(null)
                      if (domainId != null) await loadTree(domainId)
                    })
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除主题（清空才能删，判空含回收站节点） */}
      {delTopicTarget && (
        <ConfirmDialog
          open
          title="删除主题"
          confirmText="删除"
          danger
          onConfirm={() => {
            void window.api.learn
              .topicDelete(delTopicTarget.id)
              .then(async () => {
                setDelTopicTarget(null)
                toast('主题已删除')
                if (domainId != null) await loadTree(domainId)
              })
              .catch(() => {
                toast('主题下还有知识点（含回收站中未彻底删除的），需先清空')
                setDelTopicTarget(null)
              })
          }}
          onCancel={() => setDelTopicTarget(null)}
        >
          仅空主题可删除；主题「{delTopicTarget.title}」下的知识点需先清空（含回收站中未彻底删除的）。
        </ConfirmDialog>
      )}

      {/* 手动添加知识点 */}
      {addPointTarget && (
        <div
          className="dialog-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && addJob == null && setAddPointTarget(null)}
        >
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-header">添加知识点 · {addPointTarget.title}</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                className="field"
                value={addPointTitle}
                onChange={(e) => setAddPointTitle(e.target.value)}
                placeholder="知识点名（如：OSPF 邻居状态机）"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && addPointTitle.trim()) void runAddPoint()
                }}
              />
              <div className="module-sub">AI 立即生成完整学习卡片（原理/实操/应用场景）挂到本主题下</div>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAddPointTarget(null)} disabled={addJob != null}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={!addPointTitle.trim() || addJob != null}
                onClick={() => void runAddPoint()}
              >
                {addJob != null ? '生成中…' : '生成并添加'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 知识点删除（入回收站） */}
      <ConfirmDialog
        open={delNodeTarget != null}
        title="放入回收站"
        confirmText="丢弃"
        danger
        onConfirm={() => void doDiscardNode()}
        onCancel={() => setDelNodeTarget(null)}
      >
        放入回收站，3 天后自动彻底删除；恢复时回到原主题。
      </ConfirmDialog>

      {/* 高光删除（非破坏性——同万象库笔记本口径） */}
      {delHighlightTarget && (
        <ConfirmDialog
          open
          title="删除高光笔记"
          onConfirm={() => {
            void window.api.learn.deleteHighlight(delHighlightTarget.id).then(async () => {
              setDelHighlightTarget(null)
              await loadHighlights()
            })
          }}
          onCancel={() => setDelHighlightTarget(null)}
        >
          仅移除高光笔记记录，卡片中的高亮标记不受影响。
        </ConfirmDialog>
      )}

      {/* LLM 未配置 */}
      <GoConfigDialog open={goConfig} kind="llm" onGoConfig={() => setGoConfig(false)} onCancel={() => setGoConfig(false)} />

      {/* 生成失败 */}
      {failMsg && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setFailMsg(null)}>
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-header">生成失败</div>
            <div className="dialog-body" style={{ lineHeight: 1.7, wordBreak: 'break-all' }}>
              {failMsg}
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setFailMsg(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
