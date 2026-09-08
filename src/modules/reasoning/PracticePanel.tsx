// 思维墙·练习场（design v2 备选提前落地 v1.1）：随时刷题、自选难度，不计入打卡墙/连胜。
// 题目生成即入题库 wall_bank（260909 优化，todo 态）；作答态会话级暂存主进程内存
// （wall:practiceNew / practiceHint / practiceAnswer），判答即终局并回写题库终态与详情 md；
// 弃做的题留在题库（todo）可回补。答案与讲解内联渲染（MdView）。
import { useState } from 'react'
import type { WallPracticeInfo } from '../../renderer/api'
import MdView from '../../components/MdView'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'

const PREFS = [
  { id: 'random', label: '随机难度' },
  { id: 'easy', label: '简单' },
  { id: 'medium', label: '中等' },
  { id: 'hard', label: '困难' }
] as const

/** 题型自选（v1.6 思维游戏题型池；默认随机，单次有效不持久化） */
const TYPE_PREFS = [
  { id: 'random', label: '随机题型' },
  { id: 'detective_case', label: '侦探断案' },
  { id: 'lateral_puzzle', label: '情境谜题' },
  { id: 'word_logic', label: '文字谜题' },
  { id: 'life_logic', label: '生活逻辑' }
] as const

type Pref = (typeof PREFS)[number]['id']
type TypePref = (typeof TYPE_PREFS)[number]['id']

interface PracticeResult {
  correct: boolean
  standardAnswer: string
  explanation: string
  myAnswer: string
}

export default function PracticePanel() {
  const { toast } = useToast()
  const [pref, setPref] = useState<Pref>('random')
  const [typePref, setTypePref] = useState<TypePref>('random')
  const [practice, setPractice] = useState<WallPracticeInfo | null>(null)
  const [result, setResult] = useState<PracticeResult | null>(null)
  const [newJob, setNewJob] = useState<string | null>(null)
  const loading = newJob != null
  const [answering, setAnswering] = useState('')
  const [submitJob, setSubmitJob] = useState<string | null>(null)
  const submitting = submitJob != null
  const [hinting, setHinting] = useState(false)
  const [hintsShown, setHintsShown] = useState<{ level: number; text: string }[]>([])
  const [goConfig, setGoConfig] = useState(false)
  const [failMsg, setFailMsg] = useState<string | null>(null)

  const handleErr = (e: unknown): void => {
    const msg = String((e as Error).message)
    if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
    else setFailMsg(msg)
  }

  /** 来一道：出一道新题即弃当前题（会话态随容量清理；题库侧留 todo 可回补作答） */
  const newPuzzle = async (): Promise<void> => {
    if (newJob) return
    const jobId = crypto.randomUUID()
    setNewJob(jobId)
    try {
      const p = await window.api.wall.practiceNew(
        jobId,
        pref,
        typePref === 'random' ? undefined : typePref
      )
      setPractice(p)
      setResult(null)
      setHintsShown([])
      setAnswering('')
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else handleErr(e)
    } finally {
      setNewJob(null)
    }
  }

  const submit = async (): Promise<void> => {
    const a = answering.trim()
    if (!a || !practice || submitting) return
    const jobId = crypto.randomUUID()
    setSubmitJob(jobId)
    try {
      const r = await window.api.wall.practiceAnswer(jobId, practice.id, a)
      setResult({ ...r, myAnswer: a })
      toast(r.correct ? '答对了' : '答错了，看讲解')
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('PRACTICE_GONE')) {
        toast('本题已失效，请重新出一道')
        setPractice(null)
        setResult(null)
      } else if (msg.includes('已取消')) {
        // 取消：判答未完成，entry 未删，可重新提交
        toast('已取消')
      } else {
        handleErr(e)
      }
    } finally {
      setSubmitJob(null)
    }
  }

  /** 要提示：内存直取下一级（不调 LLM），当次会话内累积展示（照每日一题） */
  const hint = async (): Promise<void> => {
    if (!practice || hinting) return
    setHinting(true)
    try {
      const r = await window.api.wall.practiceHint(practice.id)
      if (r) setHintsShown((arr) => [...arr, { level: r.level, text: r.text }])
      else toast('提示已用完')
    } catch (e) {
      handleErr(e)
    } finally {
      setHinting(false)
    }
  }

  return (
    <>
      <div className="zone">
        <div className="zone-header" style={{ cursor: 'default' }}>
          <span className="material-symbols-outlined">fitness_center</span>
          <span>练习场</span>
          <span className="module-sub" style={{ marginLeft: 'auto' }}>
            随时刷题 · 自选难度 · 不计入打卡墙与连胜 · 生成题自动入题库
          </span>
        </div>
        <div className="zone-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 控制行：难度偏好 + 题型偏好（单次有效不持久化）+ 来一道 */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              className="field"
              style={{ width: 'auto' }}
              value={pref}
              onChange={(e) => setPref(e.target.value as Pref)}
              title="出题难度偏好（单次有效）"
            >
              {PREFS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <select
              className="field"
              style={{ width: 'auto' }}
              value={typePref}
              onChange={(e) => setTypePref(e.target.value as TypePref)}
              title="出题题型偏好（单次有效）"
            >
              {TYPE_PREFS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" disabled={loading} onClick={() => void newPuzzle()}>
              <span className={`material-symbols-outlined${loading ? ' spin' : ''}`}>casino</span>
              {loading ? '出题中…' : '来一道'}
            </button>
            {newJob && (
              <button className="btn" onClick={() => void window.api.ai.cancel(newJob)} title="取消本次出题">
                <span className="material-symbols-outlined">stop_circle</span>
                取消
              </button>
            )}
            {practice && !result && <span className="module-sub">不想做了？换题后本题留「题库」待作答</span>}
          </div>

          {/* 作答卡（照每日一题 quiz-card；提示累积展示、用尽禁用） */}
          {practice && !result && (
            <div className="card quiz-card">
              <div className="quiz-meta">
                {practice.typeZh} · {practice.diffZh}难度
                {hintsShown.length > 0 && ` · 已用提示 ${hintsShown.length}/${practice.hintsTotal}`}
              </div>
              <MdView md={practice.puzzle} className="quiz-question" />
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
                  disabled={hinting || hintsShown.length >= practice.hintsTotal}
                  onClick={() => void hint()}
                  title="一级比一级具体，都不直接给答案"
                >
                  <span className={`material-symbols-outlined${hinting ? ' spin' : ''}`}>
                    lightbulb
                  </span>
                  {hintsShown.length >= practice.hintsTotal
                    ? '提示已用完'
                    : `要提示（已用 ${hintsShown.length}/${practice.hintsTotal}）`}
                </button>
              </div>
            </div>
          )}

          {/* 结果卡：判定 + 我的作答 + 标准答案 + 讲解内联渲染（练习无 md 文档） */}
          {practice && result && (
            <div className="card quiz-card">
              <div className="quiz-meta">
                {practice.typeZh} · {practice.diffZh}难度
              </div>
              <div className={`rs-result${result.correct ? '' : ' wrong'}`}>
                {result.correct ? '答对了' : '答错了'}
              </div>
              <div className="module-sub" style={{ whiteSpace: 'pre-wrap' }}>
                我的作答：{result.myAnswer}
              </div>
              <div className="module-sub">标准答案：{result.standardAnswer}</div>
              <MdView md={result.explanation} className="rs-explain" />
              <div>
                <button className="btn btn-primary" onClick={() => void newPuzzle()}>
                  <span className="material-symbols-outlined">casino</span>
                  再来一道
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

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
                  void newPuzzle()
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
