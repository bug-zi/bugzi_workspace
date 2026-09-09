// 思维墙板块（推理角 specs §2）：每日一题（v1.3 打开现取——题池转正秒开，池空才现场出题）
// + 打卡月历
// + 题库（v1.2 双层题源第二层，260909 由「精选题库」改名并收入练习场生成题）
// + 练习场（v1.1，生成题自动入题库）。
// keep-alive 常驻挂载：出题以 active（真正进入思维墙板块）为准，挂载≠进入。
import { useCallback, useEffect, useState } from 'react'
import type { WallDayCell, WallMonthInfo, WallTodayInfo } from '../../renderer/api'
import MdDialog from '../../components/MdDialog'
import MdView from '../../components/MdView'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import BankPanel from './BankPanel'
import PracticePanel from './PracticePanel'

export interface WallPanelProps {
  /** 板块当前是否可见（ReasoningModule 双板块 keep-alive，隐藏时不得触发出题） */
  active: boolean
}

const DIFF_ZH: Record<string, string> = { easy: '简单', medium: '中等', hard: '困难' }
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function todayYM(): { year: number; month: number } {
  const t = new Date()
  return { year: t.getFullYear(), month: t.getMonth() + 1 }
}

/** 月历格：前导空格 + 当月每天；mdPath 有值的格子可点开当日详情 */
function calendarCells(year: number, month: number, days: Map<string, WallDayCell>): {
  key: string
  day: number
  date: string
  cell: WallDayCell | null
}[] {
  const lead = new Date(year, month - 1, 1).getDay() // 周日起
  const total = new Date(year, month, 0).getDate()
  const cells: { key: string; day: number; date: string; cell: WallDayCell | null }[] = []
  for (let i = 0; i < lead; i++) cells.push({ key: `b${i}`, day: 0, date: '', cell: null })
  for (let d = 1; d <= total; d++) {
    const date = `${year}-${pad2(month)}-${pad2(d)}`
    cells.push({ key: date, day: d, date, cell: days.get(date) ?? null })
  }
  return cells
}

export default function WallPanel(props: WallPanelProps) {
  const { active } = props
  const { toast } = useToast()
  const [today, setToday] = useState<WallTodayInfo | null>(null)
  const [ensureJob, setEnsureJob] = useState<string | null>(null)
  const loading = ensureJob != null
  const [answering, setAnswering] = useState('')
  const [submitJob, setSubmitJob] = useState<string | null>(null)
  const submitting = submitJob != null
  const [hinting, setHinting] = useState(false)
  const [hintsShown, setHintsShown] = useState<{ level: number; text: string }[]>([])
  const [lastResult, setLastResult] = useState<{ correct: boolean; standardAnswer: string } | null>(
    null
  )
  const [monthInfo, setMonthInfo] = useState<WallMonthInfo | null>(null)
  const [ym, setYm] = useState(todayYM())
  const [recordDoc, setRecordDoc] = useState<{ title: string; subtitle: string; path: string } | null>(
    null
  )
  const [goConfig, setGoConfig] = useState(false)
  const [failMsg, setFailMsg] = useState<string | null>(null)

  const handleErr = (e: unknown): void => {
    const msg = String((e as Error).message)
    if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
    else setFailMsg(msg)
  }

  /** 打开现出（specs §2）：每天首次进入思维墙，无当日题则 AI 现场出一道 */
  const ensure = useCallback(async () => {
    const jobId = crypto.randomUUID()
    setEnsureJob(jobId)
    try {
      setToday(await window.api.wall.ensureToday(jobId))
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else handleErr(e)
    } finally {
      setEnsureJob(null)
    }
  }, [])

  const loadMonth = useCallback(async () => {
    try {
      setMonthInfo(await window.api.wall.month(ym.year, ym.month))
    } catch {
      /* 月历加载失败不打断今日题 */
    }
  }, [ym])

  useEffect(() => {
    if (active) void ensure()
  }, [active, ensure])
  useEffect(() => {
    if (active) void loadMonth()
  }, [active, loadMonth])

  // keep-alive：切回推理角重新确认当日题与月历（跨零点日期翻转）；仅当前就在思维墙板块时触发
  useModuleActivated('reasoning', () => {
    if (!active) return
    void ensure()
    void loadMonth()
  })

  const submit = async (): Promise<void> => {
    const a = answering.trim()
    if (!a || !today || submitting) return
    const jobId = crypto.randomUUID()
    setSubmitJob(jobId)
    try {
      const r = await window.api.wall.answer(jobId, today.puzzleId, a)
      toast(r.correct ? '答对！打卡成功' : '答错，明日再战')
      setLastResult({ correct: r.correct, standardAnswer: r.standardAnswer })
      setToday((prev) =>
        prev && {
          ...prev,
          phase: 'done',
          status: r.correct ? 'correct' : 'wrong',
          myAnswer: a,
          mdPath: r.mdPath
        }
      )
      await loadMonth()
    } catch (e) {
      // 取消：判答未落库，题目仍是 answering 态可重交
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else handleErr(e)
    } finally {
      setSubmitJob(null)
    }
  }

  /** 要提示：库存直取下一级（不调 LLM），当次会话内累积展示 */
  const hint = async (): Promise<void> => {
    if (!today || hinting) return
    setHinting(true)
    try {
      const r = await window.api.wall.hint(today.puzzleId)
      if (r) {
        setHintsShown((arr) => [...arr, { level: r.level, text: r.text }])
        setToday((prev) => prev && { ...prev, hintsUsed: r.level })
      } else {
        toast('提示已用完')
      }
    } catch (e) {
      handleErr(e)
    } finally {
      setHinting(false)
    }
  }

  const shiftMonth = (delta: number): void => {
    setYm((prev) => {
      const d = new Date(prev.year, prev.month - 1 + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() + 1 }
    })
  }

  const daysMap = new Map((monthInfo?.days ?? []).map((c) => [c.date, c]))
  const cells = calendarCells(ym.year, ym.month, daysMap)
  const todayStr = today?.date ?? ''

  return (
    <>
      {/* 每日一题 */}
      <div className="zone">
        <div className="zone-header" style={{ cursor: 'default' }}>
          <span className="material-symbols-outlined">event</span>
          <span>每日一题</span>
          {today && <span className="zone-count">{today.date}</span>}
          {(monthInfo?.streak ?? 0) > 0 && (
            <span className="badge primary">连胜 {monthInfo?.streak} 天</span>
          )}
          <span className="module-sub" style={{ marginLeft: 'auto' }}>
            每天首次进入现出一题，答错即终局、明日再战
          </span>
        </div>
        <div className="zone-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {loading && (
            <div className="empty-state">
              <span className="material-symbols-outlined spin">progress_activity</span>
              <div>题库见底，现场出题中…</div>
              <button className="btn" onClick={() => void window.api.ai.cancel(ensureJob!)} title="取消本次出题">
                <span className="material-symbols-outlined">stop_circle</span>
                取消
              </button>
            </div>
          )}
          {!loading && !today && (
            <div className="empty-state">
              <span className="material-symbols-outlined">event</span>
              <div>今日暂无题（配置 LLM 后重新进入思维墙即可出题）</div>
            </div>
          )}
          {!loading && today && today.phase === 'answering' && (
            <div className="card quiz-card">
              <div className="quiz-meta">
                {today.typeZh} · {today.diffZh}难度
                {today.hintsUsed > 0 && ` · 已用提示 ${today.hintsUsed}/${today.hintsTotal}`}
              </div>
              <MdView md={today.puzzle} className="quiz-question" />
              {hintsShown.length > 0 && (
                <div className="rs-hints">
                  {hintsShown.map((h) => (
                    <div key={h.level}>
                      提示 {h.level}：{h.text}
                    </div>
                  ))}
                </div>
              )}
              <textarea
                className="field"
                rows={2}
                placeholder="写下你的答案（表述不同但等价算对）…"
                value={answering}
                onChange={(e) => setAnswering(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button
                  className="btn btn-primary"
                  disabled={!answering.trim() || submitting}
                  onClick={() => void submit()}
                >
                  {submitting ? '判定中…' : '提交作答'}
                </button>
                {submitJob && (
                  <button
                    className="btn"
                    onClick={() => void window.api.ai.cancel(submitJob)}
                    title="取消本次判答"
                  >
                    <span className="material-symbols-outlined">stop_circle</span>
                    取消
                  </button>
                )}
                <button
                  className="btn"
                  disabled={hinting || today.hintsUsed >= today.hintsTotal}
                  onClick={() => void hint()}
                  title="一级比一级具体，都不直接给答案；用提示答对仍算打卡成功"
                >
                  <span className={`material-symbols-outlined${hinting ? ' spin' : ''}`}>lightbulb</span>
                  {today.hintsUsed >= today.hintsTotal
                    ? '提示已用完'
                    : `要提示（已用 ${today.hintsUsed}/${today.hintsTotal}）`}
                </button>
              </div>
            </div>
          )}
          {!loading && today && today.phase === 'done' && (
            <div className="card quiz-card">
              <div className="quiz-meta">
                {today.date} · {today.typeZh} · {today.diffZh}难度 · 用提示 {today.hintsUsed}/
                {today.hintsTotal}
              </div>
              <div className={`rs-result${today.status === 'wrong' ? ' wrong' : ''}`}>
                {today.status === 'correct' ? '今日已答对，打卡成功' : '今日答错，明日再战'}
              </div>
              <div className="module-sub" style={{ whiteSpace: 'pre-wrap' }}>
                我的作答：{today.myAnswer}
              </div>
              {lastResult && (
                <div className="module-sub">标准答案：{lastResult.standardAnswer}</div>
              )}
              {today.mdPath && (
                <div>
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      const p = today.mdPath
                      if (!p) return
                      setRecordDoc({
                        title: `${today.date} 每日一题`,
                        subtitle: `${today.typeZh} · ${today.diffZh} · ${
                          today.status === 'correct' ? '答对' : '答错'
                        }`,
                        path: p
                      })
                    }}
                  >
                    <span className="material-symbols-outlined">description</span>
                    查看讲解
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 打卡墙（月历三态格子） */}
      <div className="zone">
        <div className="zone-header" style={{ cursor: 'default' }}>
          <span className="material-symbols-outlined">date_range</span>
          <span>打卡墙</span>
          {monthInfo && (
            <span className="zone-count">
              对 {monthInfo.correct} · 错 {monthInfo.wrong}
            </span>
          )}
          <div className="zone-actions">
            <button className="icon-btn" title="上个月" onClick={() => shiftMonth(-1)}>
              <span className="material-symbols-outlined">chevron_left</span>
            </button>
            <span className="module-sub" style={{ minWidth: 90, textAlign: 'center' }}>
              {ym.year} 年 {ym.month} 月
            </span>
            <button className="icon-btn" title="下个月" onClick={() => shiftMonth(1)}>
              <span className="material-symbols-outlined">chevron_right</span>
            </button>
          </div>
        </div>
        <div className="zone-body">
          <div className="wall-cal">
            {WEEKDAYS.map((w) => (
              <div key={w} className="wall-week">
                {w}
              </div>
            ))}
            {cells.map((c) => {
              if (!c.date) return <div key={c.key} className="wall-cell blank" />
              const st = c.cell?.status
              const cls = [
                'wall-cell',
                st === 'correct' ? 'correct' : '',
                st === 'wrong' ? 'wrong' : '',
                c.date === todayStr ? ' today' : '',
                c.cell?.mdPath ? 'has-doc' : ''
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <div
                  key={c.key}
                  className={cls}
                  title={
                    c.cell
                      ? `${c.date} · ${st === 'correct' ? '答对' : '答错'}${
                          c.cell.hintsUsed > 0 ? ` · 用提示 ${c.cell.hintsUsed}` : ''
                        }`
                      : c.date
                  }
                  onClick={() => {
                    const cell = c.cell
                    if (!cell?.mdPath) return
                    setRecordDoc({
                      title: `${c.date} 每日一题`,
                      subtitle: `${DIFF_ZH[cell.difficulty] ?? cell.difficulty} · ${
                        cell.status === 'correct' ? '答对' : '答错'
                      }`,
                      path: cell.mdPath
                    })
                  }}
                >
                  <span className="wall-day">{c.day}</span>
                  {st === 'wrong' && (
                    <span className="material-symbols-outlined wall-mark">close</span>
                  )}
                  {st === 'correct' && (c.cell?.hintsUsed ?? 0) > 0 && (
                    <span className="wall-hintlv" title={`用提示 ${c.cell?.hintsUsed} 级`}>
                      {c.cell?.hintsUsed}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* 题库（v1.2）：策展难题 + 练习场生成题，AI 只判答不出题；独立组件自带状态与弹窗 */}
      <BankPanel />

      {/* 练习场（v1.1）：随时刷题不计入墙；独立组件自带状态与弹窗，进入思维墙即可见 */}
      <PracticePanel />

      {/* 当日详情（全局 md 弹窗） */}
      <MdDialog
        key={recordDoc?.path ?? 'none'}
        open={recordDoc != null}
        title={recordDoc?.title ?? ''}
        subtitle={recordDoc?.subtitle}
        filePath={recordDoc?.path ?? ''}
        onClose={() => setRecordDoc(null)}
      />

      {/* LLM 未配置（全局规则 8） */}
      <GoConfigDialog
        open={goConfig}
        kind="llm"
        onGoConfig={() => setGoConfig(false)}
        onCancel={() => setGoConfig(false)}
      />

      {/* 调用失败 */}
      {failMsg && (
        <div
          className="dialog-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && setFailMsg(null)}
        >
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-header">出错了</div>
            <div className="dialog-body" style={{ lineHeight: 1.7, wordBreak: 'break-all' }}>
              {failMsg}
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setFailMsg(null)}>
                关闭
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setFailMsg(null)
                  void ensure()
                }}
              >
                重试
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
