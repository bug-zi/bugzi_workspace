// 总导览（左栏置顶 · 启动默认页，260912 新功能开发区）：今日驱动——问候 +
// 每日要求 / 待消化 / 每日一题 / 今日挑战（260916）/ 续读 今日块 + 轻数字条 +
// 热力图卡（260916）+ 底部格言轮播。纯渲染层并行聚合既有 IPC（零 AI、逐块独立
// catch；挑战/热力图走专属 challenge/overview 通道）；深链 = 派发 MODULE_NAVIGATE_EVENT，
// App 集中切模块、目标模块 useModuleNavigate 切内部视图（260915 起单一导航路径）。
import { useCallback, useEffect, useState } from 'react'
import { useAppSettings } from '../../theme/ThemeProvider'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { useModuleNavigate } from '../../hooks/useModuleNavigate'
import { SettingsKeys } from '../../shared/types'
import type { ModuleId, MottoRecord, ChallengeDailyView, HeatmapDay, WhoamiGetResult } from '../../shared/types'
import { MODULE_NAVIGATE_EVENT } from '../../App'
import HeatmapCard, { heatmapRange } from './HeatmapCard'
import ChallengeManageDialog from './ChallengeManageDialog'
import './zonglan.css'

/** 今日 YYYY-MM-DD（wall.month 的 WallDayCell.date 同格式比对） */
function todayStr(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** 格言轮播取下一条下标（随机且不与当前重复；仅一条不动） */
function nextMottoIdx(len: number, cur: number): number {
  if (len < 2) return cur
  let n = Math.floor(Math.random() * len)
  if (n === cur) n = (n + 1) % len
  return n
}

export default function OverviewModule() {
  const { settings } = useAppSettings()

  // ----- 各块状态（null = 加载失败 → 该块显示「--」/失败态，不拖垮整页） -----
  const [settledMottos, setSettledMottos] = useState<MottoRecord[]>([])
  const [mottoIdx, setMottoIdx] = useState(0)
  const [learnReq, setLearnReq] = useState<{
    goal: number
    done: number
    streak: number
    quizStatus: 'answering' | 'graded' | null
    learned: number
  } | null>(null)
  const [learnCount, setLearnCount] = useState<number | null>(null)
  const [wallState, setWallState] = useState<{ done: boolean; streak: number } | null>(null)
  const [reading, setReading] = useState<{ id: number; title: string; percent: number; todayLabel: string } | null>(null)
  const [feedUnread, setFeedUnread] = useState<number | null>(null)
  const [monthExpense, setMonthExpense] = useState<string | null>(null)
  const [twelve, setTwelve] = useState<string | null>(null)
  const [challengeInfo, setChallengeInfo] = useState<{
    daily: ChallengeDailyView | null
    poolCount: number
  } | null>(null)
  // 我是谁（260921）：今日题数/已答/未答 + 往日候选待确认数（当日无题整行不显示）
  const [whoami, setWhoami] = useState<{
    total: number
    answered: number
    unanswered: number
    pendingCount: number
  } | null>(null)
  const [heat, setHeat] = useState<HeatmapDay[] | null>(null)
  const [manageOpen, setManageOpen] = useState(false)

  /** 深链：派发导航事件（App 集中切模块，目标模块 useModuleNavigate 切内部视图） */
  const go = useCallback((module: ModuleId, target?: string, payload?: Record<string, unknown>) => {
    window.dispatchEvent(new CustomEvent(MODULE_NAVIGATE_EVENT, { detail: { module, target, payload } }))
  }, [])

  // ----- 逐块加载（各自 catch） -----
  const loadMottos = useCallback(async (): Promise<void> => {
    try {
      const settled = await window.api.mottos.list('settled')
      setSettledMottos(settled)
      setMottoIdx(settled.length > 0 ? Math.floor(Math.random() * settled.length) : 0)
    } catch {
      setSettledMottos([])
    }
  }, [])
  const loadDaily = useCallback(async (): Promise<void> => {
    try {
      const d = await window.api.learn.daily()
      setLearnReq({
        goal: d.goal,
        done: d.done,
        streak: d.streak,
        quizStatus: d.quizStatus,
        learned: d.learned.length
      })
    } catch {
      setLearnReq(null)
    }
  }, [])
  const loadLearnCount = useCallback(async (): Promise<void> => {
    try {
      setLearnCount((await window.api.wiki.learnEntries()).length)
    } catch {
      setLearnCount(null)
    }
  }, [])
  const loadWall = useCallback(async (): Promise<void> => {
    try {
      const now = new Date()
      const info = await window.api.wall.month(now.getFullYear(), now.getMonth() + 1)
      const t = todayStr(now)
      setWallState({ done: info.days.some((d) => d.date === t), streak: info.streak })
    } catch {
      setWallState(null)
    }
  }, [])
  const loadReading = useCallback(async (): Promise<void> => {
    try {
      const [books, stats] = await Promise.all([window.api.books.list(), window.api.books.readStats()])
      const inProgress = books.find((b) => b.last_read_at != null && b.progress_percent < 100) ?? null
      if (!inProgress) {
        setReading(null)
        return
      }
      const mins = Math.floor(stats.todaySeconds / 60)
      setReading({
        id: inProgress.id,
        title: inProgress.title,
        percent: Math.round(inProgress.progress_percent),
        todayLabel: mins > 0 ? `今日 ${mins} 分钟` : stats.todaySeconds > 0 ? '今日 <1 分钟' : '今日尚未阅读'
      })
    } catch {
      setReading(null)
    }
  }, [])
  const loadNumbers = useCallback(async (): Promise<void> => {
    try {
      const feeds = await window.api.feeds.list()
      setFeedUnread(feeds.reduce((s, f) => s + f.unread, 0))
    } catch {
      setFeedUnread(null)
    }
    try {
      const now = new Date()
      const s = await window.api.ledger.stats(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
      setMonthExpense(`¥${(s.expenseCents / 100).toFixed(2)}`)
    } catch {
      setMonthExpense(null)
    }
    try {
      const qs = await window.api.twelve.list()
      setTwelve(`${qs.filter((q) => q.thought_count > 0).length}/${qs.length}`)
    } catch {
      setTwelve(null)
    }
  }, [])

  const loadChallenge = useCallback(async (): Promise<void> => {
    try {
      setChallengeInfo(await window.api.challenge.daily())
    } catch {
      setChallengeInfo(null)
    }
  }, [])
  const loadWhoami = useCallback(async (): Promise<void> => {
    try {
      const r: WhoamiGetResult = await window.api.whoami.get()
      setWhoami({
        total: r.today.length,
        answered: r.today.filter((q) => q.answer != null).length,
        unanswered: r.today.filter((q) => q.answer == null && !q.skipped).length,
        pendingCount: r.pending.length
      })
    } catch {
      setWhoami(null)
    }
  }, [])
  const loadHeat = useCallback(async (): Promise<void> => {
    try {
      const { from, to } = heatmapRange()
      setHeat(await window.api.overview.heatmap(from, to))
    } catch {
      setHeat(null)
    }
  }, [])

  const loadAll = useCallback((): void => {
    void loadMottos()
    void loadDaily()
    void loadLearnCount()
    void loadWall()
    void loadReading()
    void loadNumbers()
    void loadChallenge()
    void loadWhoami()
    void loadHeat()
  }, [loadMottos, loadDaily, loadLearnCount, loadWall, loadReading, loadNumbers, loadChallenge, loadWhoami, loadHeat])

  useEffect(() => {
    loadAll()
  }, [loadAll])
  useModuleActivated('zonglan', loadAll)

  // ----- 格言轮播（沉淀区随机，10s 自动换下一条；仅展示，可手动换一条） -----
  useEffect(() => {
    if (settledMottos.length < 2) return
    const timer = setInterval(() => {
      setMottoIdx((i) => nextMottoIdx(settledMottos.length, i))
    }, 10000)
    return () => clearInterval(timer)
  }, [settledMottos])
  const motto = settledMottos[mottoIdx] ?? null

  /** 打卡/撤销（可逆）：挑战与热力图联动刷新 */
  const toggleChallengeDone = async (): Promise<void> => {
    const d = challengeInfo?.daily
    if (!d) return
    try {
      const next = await window.api.challenge.setDone(d.date, !d.done)
      setChallengeInfo((info) => (info ? { ...info, daily: next } : info))
      void loadHeat()
    } catch {
      /* 本地操作极少失败，静默 */
    }
  }
  /** 换一条：done 保留 → 热力图不变，只刷挑战卡 */
  const swapChallenge = async (): Promise<void> => {
    try {
      const next = await window.api.challenge.swap()
      setChallengeInfo((info) => (info ? { ...info, daily: next } : info))
    } catch {
      /* 池 <2 已置灰，静默 */
    }
  }

  // ----- 问候行（用户名取个人档；未设置退「你好」） -----
  const now = new Date()
  const name = settings[SettingsKeys.UserName]?.trim()
  const greetLine = `${name || '你好'}，${now.getMonth() + 1}月${now.getDate()}日 周${'日一二三四五六'[now.getDay()]}`

  return (
    <div className="module-page" style={{ maxWidth: 1200 }}>
      <div className="module-header">
        <span className="material-symbols-outlined">space_dashboard</span>
        <span className="module-title">总导览</span>
        <span className="module-sub">{greetLine}</span>
      </div>

      {/* 今日学习（整卡深链「今日学习」tab；260915 起显示每日要求状态行） */}
      <button className="card zl-row" onClick={() => go('learn', 'today')} title="进入学习库·今日学习">
        <span className="material-symbols-outlined">school</span>
        <div className="zl-row-main">
          <div className="zl-row-line">
            <span className="zl-row-title">今日学习</span>
            <span className="module-sub">
              {learnReq
                ? learnReq.done
                  ? `今日要求已完成 · 连胜 ${learnReq.streak} 天`
                  : `新学 ${learnReq.learned}/${learnReq.goal} · 小测${
                      learnReq.quizStatus === 'graded'
                        ? '已交卷'
                        : learnReq.quizStatus === 'answering'
                          ? '作答中'
                          : '未出卷'
                    } · 连胜 ${learnReq.streak} 天`
                : '加载失败'}
            </span>
          </div>
        </div>
      </button>

      {/* 待消化（0 置灰不可点） */}
      <button
        className={`card zl-row${learnCount === 0 ? ' zl-muted' : ''}`}
        disabled={learnCount === 0}
        onClick={() => go('wiki', 'learn-zone')}
        title="进入万象库·待学习区"
      >
        <span className="material-symbols-outlined">public</span>
        <span className="zl-row-title">待学习区</span>
        <span className="module-sub">
          {learnCount == null ? '加载失败' : learnCount === 0 ? '今日无待消化' : `${learnCount} 张待消化`}
        </span>
      </button>

      {/* 每日一题（wall.month 被动查，绝不触发出题） */}
      <button
        className="card zl-row"
        onClick={() => go('reasoning', 'daily')}
        title="进入推理角·思维墙"
      >
        <span className="material-symbols-outlined">psychology</span>
        <span className="zl-row-title">每日一题</span>
        <span className="module-sub">
          {wallState
            ? wallState.done
              ? `已完成 · 连胜 ${wallState.streak} 天`
              : `未打卡 · 连胜 ${wallState.streak} 天`
            : '加载失败'}
        </span>
      </button>

      {/* 今日挑战（260916 新功能开发区）：日定一条 + 可逆打卡 + 池管理；div 卡（内嵌按钮不可用 button） */}
      <div className="card zl-row zl-challenge-card">
        <span className="material-symbols-outlined">fitness_center</span>
        <div className="zl-row-main">
          <div className="zl-row-line">
            <span className="zl-row-title">今日挑战</span>
            <span className="module-sub">
              {challengeInfo === null
                ? '加载失败'
                : challengeInfo.daily
                  ? challengeInfo.daily.done
                    ? '已完成 · 计入今日热力图'
                    : '待打卡'
                  : '池空'}
            </span>
          </div>
          <div className="zl-challenge-content">
            {challengeInfo === null
              ? '--'
              : challengeInfo.daily
                ? (challengeInfo.daily.content ?? '（已删除的挑战）')
                : '还没有挑战项目，去添加第一条吧'}
          </div>
        </div>
        {challengeInfo?.daily ? (
          <>
            <button className="btn" onClick={() => void toggleChallengeDone()}>
              <span className="material-symbols-outlined">{challengeInfo.daily.done ? 'undo' : 'check_circle'}</span>
              {challengeInfo.daily.done ? '撤销' : '完成'}
            </button>
            <button
              className="icon-btn"
              disabled={challengeInfo.poolCount < 2}
              title="换一条"
              onClick={() => void swapChallenge()}
            >
              <span className="material-symbols-outlined">autorenew</span>
            </button>
          </>
        ) : null}
        <button className="icon-btn" title="管理挑战池" onClick={() => setManageOpen(true)}>
          <span className="material-symbols-outlined">tune</span>
        </button>
      </div>
      <ChallengeManageDialog
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        onChanged={() => {
          void loadChallenge()
        }}
      />

      {/* 我是谁（260921）：当日有题才显示；点击深链个人档并展开我是谁区 */}
      {whoami && whoami.total > 0 && (
        <button className="card zl-row" onClick={() => go('profile', 'whoami')} title="进入个人档·我是谁">
          <span className="material-symbols-outlined">psychology</span>
          <div className="zl-row-main">
            <div className="zl-row-line">
              <span className="zl-row-title">我是谁</span>
              <span className="module-sub">
                {`今日 ${whoami.total} 问 · 已答 ${whoami.answered}`}
                {whoami.unanswered > 0 && (
                  <span style={{ color: 'var(--color-primary)' }}>{` · ${whoami.unanswered} 问待答`}</span>
                )}
                {whoami.pendingCount > 0 && ` · ${whoami.pendingCount} 条候选待确认`}
              </span>
            </div>
          </div>
        </button>
      )}

      {/* 续读（无在读书显引导） */}
      {reading ? (
        <button
          className="card zl-row"
          onClick={() => go('zangyue', 'read', { bookId: reading.id })}
          title="继续阅读"
        >
          <span className="material-symbols-outlined">auto_stories</span>
          <span className="zl-row-title">继续阅读：{reading.title}</span>
          <span className="module-sub">
            {reading.percent}% · {reading.todayLabel}
          </span>
        </button>
      ) : (
        <button className="card zl-row" onClick={() => go('zangyue')} title="进入图书馆">
          <span className="material-symbols-outlined">auto_stories</span>
          <span className="zl-row-title">图书馆·书架</span>
          <span className="module-sub">没有在读的书 · 去导入一本</span>
        </button>
      )}

      {/* 轻数字条（点击直达对应模块） */}
      <div className="zl-numbar">
        <button className="zl-num" onClick={() => go('feed')} title="进入信息源">
          <span className="zl-num-val">{feedUnread ?? '--'}</span>
          <span className="module-sub">信息源未读</span>
        </button>
        <button className="zl-num" onClick={() => go('ledger')} title="进入记账本">
          <span className="zl-num-val">{monthExpense ?? '--'}</span>
          <span className="module-sub">本月支出</span>
        </button>
        <button className="zl-num" onClick={() => go('zhijiji', 'twelve')} title="进入致知己·十二问题">
          <span className="zl-num-val">{twelve ?? '--'}</span>
          <span className="module-sub">十二问题</span>
        </button>
      </div>

      {/* 热力图（260916 新功能开发区）：近一年三任务完成度四档 */}
      <HeatmapCard days={heat} />

      {/* 底部格言轮播（沉淀区随机 10s 换 + 手动换一条，点击进格言库） */}
      {motto && (
        <div className="card zl-quote" onClick={() => go('wenbi', 'mottos')} title="进入格言库">
          <span className="zl-quote-text">{motto.content}</span>
          {motto.source && <span className="zl-quote-src module-sub">—— {motto.source}</span>}
          {settledMottos.length > 1 && (
            <button
              className="icon-btn zl-quote-refresh"
              title="换一条"
              onClick={(e) => {
                e.stopPropagation()
                setMottoIdx((i) => nextMottoIdx(settledMottos.length, i))
              }}
            >
              <span className="material-symbols-outlined">refresh</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
