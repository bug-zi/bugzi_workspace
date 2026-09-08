// 万象库模块（万象库 specs 全量）：总览/板块页/板块管理/卡片生成/划词/笔记本
// 260908 辩真阁并入：双板块「百科 | 辩真」（推理角同款 keep-alive 隐藏切换，验证中任务切板块不中断）
import { useCallback, useEffect, useState } from 'react'
import type { WikiEntry, WikiSection, WikiHighlightRow, WikiQuizQuestion } from '../../renderer/api'
import type { AiChannel } from '../../shared/types'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import VerifyPanel from './VerifyPanel'

export interface WikiModuleProps {
  onOpenAi: (prefill?: string, opts?: { auto?: boolean; channel?: AiChannel }) => void
  bumpAi: () => void
}

type View = { kind: 'overview' } | { kind: 'section'; id: number } | { kind: 'notebook' } | { kind: 'quiz' }

/** 手动生成弹窗的占位词条名示例：初始板块各配一个代表词，自定义板块用通用示例 */
const SECTION_TERM_EXAMPLES: Record<string, string> = {
  经济学: '通货膨胀',
  法学: '无罪推定',
  心理学: '认知失调',
  博弈论: '囚徒困境',
  历史神话: '特洛伊战争'
}
const GENERIC_TERM_EXAMPLE = '词条名'

/** 按板块名取占位示例词（未匹配到初始板块时回退通用词） */
function termExampleOf(sectionName: string): string {
  return SECTION_TERM_EXAMPLES[sectionName] ?? GENERIC_TERM_EXAMPLE
}

export default function WikiModule(props: WikiModuleProps) {
  const { toast } = useToast()
  const [view, setView] = useState<View>({ kind: 'overview' })
  // 双板块 tab（260908 辩真阁并入；默认百科，选择不持久化——推理角同款）
  const [tab, setTab] = useState<'wiki' | 'verify'>('wiki')
  const [sections, setSections] = useState<WikiSection[]>([])
  const [entries, setEntries] = useState<WikiEntry[]>([])
  const [counts, setCounts] = useState<Record<number, number>>({})
  const [highlights, setHighlights] = useState<WikiHighlightRow[]>([])
  // 卡片弹窗
  const [cardEntry, setCardEntry] = useState<WikiEntry | null>(null)
  const [mdVersion, setMdVersion] = useState(0)
  // 生成
  const [genJob, setGenJob] = useState<string | null>(null)
  const generating = genJob != null
  const [manualOpen, setManualOpen] = useState(false)
  const [manualTerm, setManualTerm] = useState('')
  const [manualSection, setManualSection] = useState<number | null>(null)
  // 手动弹窗骰子：随机词条名加载中
  const [suggestJob, setSuggestJob] = useState<string | null>(null)
  const suggesting = suggestJob != null
  const [conflictTerm, setConflictTerm] = useState<string | null>(null)
  const [conflictEntry, setConflictEntry] = useState<WikiEntry | null>(null)
  const [goConfig, setGoConfig] = useState<'llm' | 'mcp' | null>(null)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  // 板块管理（菜单锚定触发按钮，优化建议区：原 ctx-menu 写死 top/left 不跟随按钮）
  const [sectionMenu, setSectionMenu] = useState<{ section: WikiSection; left: number; top: number } | null>(null)
  const [addSectionOpen, setAddSectionOpen] = useState(false)
  const [newSectionName, setNewSectionName] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  // 改名目标（存量 bug 修复：原条件 renameOpen && sectionMenu，但点改名即关菜单 → 弹窗永不显示）
  const [renameTarget, setRenameTarget] = useState<WikiSection | null>(null)
  const [delSectionTarget, setDelSectionTarget] = useState<WikiSection | null>(null)
  // 词条编辑
  const [editEntry, setEditEntry] = useState<WikiEntry | null>(null)
  const [editTerm, setEditTerm] = useState('')
  const [editSummary, setEditSummary] = useState('')
  // 丢弃
  const [discardTarget, setDiscardTarget] = useState<WikiEntry | null>(null)
  // 笔记本删除
  const [delHighlightTarget, setDelHighlightTarget] = useState<WikiHighlightRow | null>(null)
  // 跳转：笔记本 → 原卡片
  const [jumpEntryId, setJumpEntryId] = useState<number | null>(null)
  // 生成审核（优化建议区：第一遍生成弹窗三选 加入/丢弃/直接删除）
  const [reviewing, setReviewing] = useState(false)
  const [reviewDelete, setReviewDelete] = useState<WikiEntry | null>(null)
  // 测一测（优化建议区）
  const [quizJob, setQuizJob] = useState<string | null>(null)
  const quizLoading = quizJob != null
  const [quizQuestions, setQuizQuestions] = useState<WikiQuizQuestion[]>([])
  const [quizIdx, setQuizIdx] = useState(0)
  const [quizPick, setQuizPick] = useState<number | null>(null)
  const [quizPicks, setQuizPicks] = useState<number[]>([])
  const [quizFinished, setQuizFinished] = useState(false)

  const loadSections = useCallback(async () => {
    const rows = await window.api.wiki.sections()
    setSections(rows)
    const c: Record<number, number> = {}
    for (const s of rows) {
      c[s.id] = (await window.api.wiki.entries(s.id)).length
    }
    setCounts(c)
  }, [])

  const loadHighlights = useCallback(async () => {
    setHighlights(await window.api.wiki.highlights())
  }, [])

  useEffect(() => {
    void loadSections()
    void loadHighlights()
  }, [loadSections, loadHighlights])

  // keep-alive：切回万象库时刷新板块/词条/高光（后台生成可能已入库）
  useModuleActivated('wiki', () => {
    void loadSections()
    void loadHighlights()
    if (view.kind === 'section') void window.api.wiki.entries(view.id).then(setEntries)
  })

  // 板块页加载词条
  useEffect(() => {
    if (view.kind === 'section') {
      void window.api.wiki.entries(view.id).then(setEntries)
    }
  }, [view, mdVersion])

  // 笔记本跳转原卡片
  useEffect(() => {
    if (jumpEntryId == null) return
    void window.api.wiki.entry(jumpEntryId).then((e) => {
      setCardEntry(e)
      setJumpEntryId(null)
    })
  }, [jumpEntryId])

  const openSection = (id: number): void => setView({ kind: 'section', id })
  const refreshCard = useCallback(async () => {
    if (!cardEntry) return
    const e = await window.api.wiki.entry(cardEntry.id)
    setCardEntry(e)
    setMdVersion((v) => v + 1)
    await loadSections()
  }, [cardEntry, loadSections])

  // ---------- 生成 ----------
  /** 手动弹窗骰子：随机填一个词条名（当前所选板块），只构思词条不生成卡片 */
  const suggestTerm = async (): Promise<void> => {
    if (suggestJob || manualSection == null) return
    const jobId = crypto.randomUUID()
    setSuggestJob(jobId)
    try {
      setManualTerm(await window.api.wiki.suggestTerm(jobId, manualSection))
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else setFailMsg(msg)
    } finally {
      setSuggestJob(null)
    }
  }

  const runGenerate = async (term: string | null, sectionId: number | null): Promise<void> => {
    if (genJob) return
    const jobId = crypto.randomUUID()
    setGenJob(jobId)
    try {
      const r = await window.api.wiki.generate(jobId, term, sectionId)
      if (r.ok) {
        toast(`已生成词条「${r.data.term}」`)
        await loadSections()
        // 打开新卡片（生成审核态：读完三选 加入/丢弃/直接删除）
        const e = await window.api.wiki.entry(r.data.entryId)
        setReviewing(true)
        setCardEntry(e)
        setMdVersion((v) => v + 1)
      } else {
        // 已存在 → 拦截提示 + 可跳原卡片
        setConflictTerm(r.conflict)
        const list = await window.api.wiki.entries(sectionId ?? sections[0]?.id ?? 0)
        const found = list.find((x) => x.term === r.conflict) ?? null
        setConflictEntry(found)
      }
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig('llm')
      else setFailMsg(msg)
    } finally {
      setGenJob(null)
    }
  }

  // ---------- 划词动作（MdDialog） ----------
  const onHighlight = useCallback(
    async (text: string) => {
      if (!cardEntry) return
      // md 中包裹 ==标记==
      const md = await window.api.md.read(cardEntry.md_path)
      const wrapped = `==${text}==`
      if (md.includes(wrapped)) {
        // 已有标记，仅补笔记本记录
        await window.api.wiki.addHighlight(cardEntry.id, text)
      } else if (md.includes(text)) {
        await window.api.md.write(cardEntry.md_path, md.replace(text, wrapped))
        await window.api.wiki.addHighlight(cardEntry.id, text)
      } else {
        await window.api.wiki.addHighlight(cardEntry.id, text)
      }
      setMdVersion((v) => v + 1)
      await refreshCard()
      await loadHighlights()
      toast('已加入高光')
    },
    [cardEntry, refreshCard, loadHighlights, toast]
  )

  const onAskAi = useCallback(
    (text: string) => {
      props.onOpenAi(`关于词条「${cardEntry?.term ?? ''}」：「${text}」\n\n请帮我解释。`)
    },
    [props]
  )

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    await window.api.wiki.discardEntry(discardTarget.id)
    toast('已放入回收站')
    setDiscardTarget(null)
    setReviewing(false)
    setCardEntry(null)
    await loadSections()
    if (view.kind === 'section') void window.api.wiki.entries(view.id).then(setEntries)
  }

  /** 生成审核「直接删除」：彻底删卡片（含高光），不进回收站 */
  const doReviewDelete = async (): Promise<void> => {
    if (!reviewDelete) return
    await window.api.wiki.deleteForeverEntry(reviewDelete.id)
    toast('已彻底删除')
    setReviewDelete(null)
    setReviewing(false)
    setCardEntry(null)
    await loadSections()
    if (view.kind === 'section') void window.api.wiki.entries(view.id).then(setEntries)
  }

  // ---------- 测一测（优化建议区：随机 5 张卡片各 1 题，逐题反馈） ----------
  const startQuiz = async (): Promise<void> => {
    if (quizJob) return
    const jobId = crypto.randomUUID()
    setView({ kind: 'quiz' })
    setQuizJob(jobId)
    setQuizQuestions([])
    setQuizIdx(0)
    setQuizPick(null)
    setQuizPicks([])
    setQuizFinished(false)
    try {
      setQuizQuestions(await window.api.wiki.quiz(jobId))
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig('llm')
      else setFailMsg(msg)
      setView({ kind: 'overview' })
    } finally {
      setQuizJob(null)
    }
  }

  const pickOption = (i: number): void => {
    if (quizPick != null) return
    setQuizPick(i)
    setQuizPicks((arr) => [...arr, i])
  }

  const quizNext = (): void => {
    if (quizPick == null) return
    if (quizIdx + 1 >= quizQuestions.length) setQuizFinished(true)
    else {
      setQuizIdx((v) => v + 1)
      setQuizPick(null)
    }
  }

  const quizScore = (): number => quizPicks.filter((p, i) => quizQuestions[i] && p === quizQuestions[i].answer).length

  const saveEntryEdit = async (): Promise<void> => {
    if (!editEntry) return
    await window.api.wiki.updateEntry(editEntry.id, editTerm.trim(), editSummary.trim())
    setEditEntry(null)
    await loadSections()
    if (view.kind === 'section') void window.api.wiki.entries(view.id).then(setEntries)
    if (cardEntry?.id === editEntry.id) await refreshCard()
  }

  // ---------- 渲染 ----------
  const currentSection = view.kind === 'section' ? sections.find((s) => s.id === view.id) : null

  return (
    <div className="module-page">
      <div className="module-header">
        <span className="material-symbols-outlined">public</span>
        <span className="module-title">万象库</span>
        {view.kind !== 'overview' && tab === 'wiki' && (
          <button className="btn btn-ghost" onClick={() => setView({ kind: 'overview' })}>
            <span className="material-symbols-outlined">arrow_back</span>
            总览
          </button>
        )}
      </div>

      {/* 双板块 tab（260908 辩真阁并入万象库）：百科 = 原有内容；辩真 = 原辩真阁面板 */}
      <div className="recycle-tabs">
        <button className={`recycle-tab${tab === 'wiki' ? ' active' : ''}`} onClick={() => setTab('wiki')}>
          百科
        </button>
        <button className={`recycle-tab${tab === 'verify' ? ' active' : ''}`} onClick={() => setTab('verify')}>
          辩真
        </button>
      </div>

      {/* 百科板块（照推理角 keep-alive 模式：常驻挂载仅隐藏，切板块不打断生成中任务） */}
      <div className={tab === 'wiki' ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== 'wiki'}>

      {/* 总览页 */}
      {view.kind === 'overview' && (
        <>
          <div className="card" style={{ padding: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => void runGenerate(null, null)} disabled={generating}>
              <span className="material-symbols-outlined">casino</span>
              {generating ? '生成中…' : '随机来一条'}
            </button>
            {genJob && (
              <button className="btn" onClick={() => void window.api.ai.cancel(genJob)} title="取消本次生成">
                <span className="material-symbols-outlined">stop_circle</span>
                取消
              </button>
            )}
            <button
              className="btn"
              onClick={() => {
                setManualTerm('')
                setManualSection(sections[0]?.id ?? null)
                setManualOpen(true)
              }}
            >
              <span className="material-symbols-outlined">edit_note</span>
              手动输入生成
            </button>
            <button className="btn" onClick={() => void startQuiz()} disabled={quizLoading}>
              <span className="material-symbols-outlined">quiz</span>
              {quizLoading ? '出题中…' : '测一测'}
            </button>
            <span className="module-sub" style={{ marginLeft: 'auto' }}>AI 按固定模板生成知识卡片</span>
          </div>

          <div className="zone">
            <div
              className="zone-header"
              onClick={(e) => {
                e.stopPropagation()
                setAddSectionOpen(true)
              }}
              title="新增板块"
            >
              <span className="material-symbols-outlined">library_books</span>
              <span>板块</span>
              <div className="zone-actions">
                <button className="icon-btn" title="新增板块" onClick={() => setAddSectionOpen(true)}>
                  <span className="material-symbols-outlined">add</span>
                </button>
              </div>
            </div>
            <div className="zone-body">
              {sections.map((s) => (
                <div className="row-item" key={s.id} onClick={() => openSection(s.id)}>
                  <span className="material-symbols-outlined">folder</span>
                  <div className="row-main">
                    <div className="row-title">{s.name}</div>
                  </div>
                  <span className="zone-count">{counts[s.id] ?? 0}</span>
                  <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="icon-btn"
                      title="板块管理"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect()
                        setSectionMenu({ section: s, left: r.right, top: r.bottom + 4 })
                      }}
                    >
                      <span className="material-symbols-outlined">more_vert</span>
                    </button>
                  </div>
                </div>
              ))}
              <div
                className="row-item"
                onClick={() => setView({ kind: 'notebook' })}
                style={{ borderStyle: 'dashed' }}
              >
                <span className="material-symbols-outlined">bookmark</span>
                <div className="row-main">
                  <div className="row-title">笔记本</div>
                  <div className="row-sub">全部高光集合</div>
                </div>
                <span className="zone-count">{highlights.length}</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* 板块页 */}
      {view.kind === 'section' && currentSection && (
        <div className="zone">
          <div className="zone-header">
            <span className="material-symbols-outlined">folder_open</span>
            <span>{currentSection.name}</span>
            <span className="zone-count">{entries.length}</span>
            <div className="row-actions" style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
              <button
                className="icon-btn"
                title="本板块随机来一条"
                disabled={generating}
                onClick={() => void runGenerate(null, currentSection.id)}
              >
                <span className={`material-symbols-outlined${generating ? ' spin' : ''}`}>casino</span>
              </button>
              {genJob && (
                <button
                  className="icon-btn"
                  title="取消本次生成"
                  onClick={() => void window.api.ai.cancel(genJob)}
                >
                  <span className="material-symbols-outlined">stop_circle</span>
                </button>
              )}
            </div>
          </div>
          <div className="zone-body">
            {entries.length === 0 && (
              <div className="empty-state">
                <span className="material-symbols-outlined">public</span>
                暂无词条，去总览「随机来一条」或手动输入生成
              </div>
            )}
            {entries.map((e) => (
              <div className="row-item" key={e.id} onClick={() => void window.api.wiki.entry(e.id).then((x: WikiEntry) => setCardEntry(x))}>
                <div className="row-main">
                  <div className="row-title">{e.term}</div>
                  <div className="row-sub">{e.summary}</div>
                </div>
                <div className="row-actions" onClick={(ev) => ev.stopPropagation()}>
                  <button
                    className="icon-btn"
                    title="查看"
                    onClick={() => void window.api.wiki.entry(e.id).then((x: WikiEntry) => setCardEntry(x))}
                  >
                    <span className="material-symbols-outlined">visibility</span>
                  </button>
                  <button
                    className="icon-btn"
                    title="编辑"
                    onClick={() => {
                      setEditEntry(e)
                      setEditTerm(e.term)
                      setEditSummary(e.summary)
                    }}
                  >
                    <span className="material-symbols-outlined">edit</span>
                  </button>
                  <button className="icon-btn danger" title="回收站" onClick={() => setDiscardTarget(e)}>
                    <span className="material-symbols-outlined">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 笔记本页签 */}
      {view.kind === 'notebook' && (
        <div className="zone">
          <div className="zone-header">
            <span className="material-symbols-outlined">bookmark</span>
            <span>笔记本</span>
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
              <div className="row-item" key={h.id} onClick={() => setJumpEntryId(h.entry_id)}>
                <div className="row-main">
                  <div className="row-title" style={{ whiteSpace: 'normal' }}>{h.text}</div>
                  <div className="row-sub">
                    {h.term} ｜ {fmtTime(h.created_at)}
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
      )}

      {/* 卡片 MdDialog（划词能力仅此处启用） */}
      {/* 测一测（优化建议区）：随机 5 题逐题反馈 */}
      {view.kind === 'quiz' && (
        <div className="zone">
          <div className="zone-header" style={{ cursor: 'default' }}>
            <span className="material-symbols-outlined">quiz</span>
            <span>测一测</span>
            {quizQuestions.length > 0 && !quizFinished && (
              <span className="zone-count">{quizQuestions.length}</span>
            )}
          </div>
          <div className="zone-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {quizLoading && (
              <div className="empty-state">
                <span className="material-symbols-outlined spin">progress_activity</span>
                <div>出题中，约需数秒…</div>
                <button className="btn" onClick={() => void window.api.ai.cancel(quizJob!)} title="取消本次出题">
                  <span className="material-symbols-outlined">stop_circle</span>
                  取消
                </button>
              </div>
            )}
            {!quizLoading && !quizFinished && quizQuestions[quizIdx] && (
              <div className="card quiz-card">
                <div className="quiz-meta">
                  第 {quizIdx + 1} / {quizQuestions.length} 题 · 来源词条「{quizQuestions[quizIdx].term}」
                </div>
                <div className="quiz-question">{quizQuestions[quizIdx].question}</div>
                {quizQuestions[quizIdx].options.map((opt, i) => {
                  const isAnswer = i === quizQuestions[quizIdx].answer
                  const picked = quizPick === i
                  const cls = quizPick == null ? '' : isAnswer ? ' correct' : picked ? ' wrong' : ''
                  return (
                    <button
                      key={i}
                      className={`quiz-opt${cls}`}
                      disabled={quizPick != null}
                      onClick={() => pickOption(i)}
                    >
                      <span className="quiz-opt-key">{'ABCD'[i]}</span>
                      <span>{opt}</span>
                    </button>
                  )
                })}
                {quizPick != null && (
                  <div className="quiz-feedback">
                    <span>
                      {quizPick === quizQuestions[quizIdx].answer
                        ? '回答正确'
                        : `答错了，正确答案是 ${'ABCD'[quizQuestions[quizIdx].answer]}`}
                    </span>
                    <button className="btn btn-primary" onClick={quizNext}>
                      {quizIdx + 1 >= quizQuestions.length ? '查看成绩' : '下一题'}
                    </button>
                  </div>
                )}
              </div>
            )}
            {!quizLoading && quizFinished && (
              <div className="card quiz-card" style={{ alignItems: 'center', textAlign: 'center' }}>
                <div className="quiz-score">
                  {quizScore()} / {quizQuestions.length}
                </div>
                <div className="module-sub">
                  答对率 {Math.round((quizScore() / Math.max(1, quizQuestions.length)) * 100)}%
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                  <button className="btn" onClick={() => setView({ kind: 'overview' })}>
                    返回总览
                  </button>
                  <button className="btn btn-primary" onClick={() => void startQuiz()} disabled={quizLoading}>
                    <span className="material-symbols-outlined">casino</span>
                    再来一轮
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <MdDialog
        key={cardEntry?.id ?? 'none'}
        open={cardEntry != null}
        title={cardEntry?.term ?? ''}
        titleTag={cardEntry ? sections.find((s) => s.id === cardEntry.section_id)?.name : undefined}
        filePath={cardEntry?.md_path ?? ''}
        onClose={() => {
          // 生成审核态关闭 =「加入」保留（优化建议区）
          if (reviewing) {
            setReviewing(false)
            toast('已加入万象库')
          }
          setCardEntry(null)
        }}
        onChanged={() => void refreshCard()}
        selectionActions={{ onHighlight: (t) => void onHighlight(t), onAskAi }}
        review={
          reviewing && cardEntry
            ? {
                onDiscard: () => setDiscardTarget(cardEntry),
                onDelete: () => setReviewDelete(cardEntry)
              }
            : undefined
        }
      />

      {/* 手动输入生成 */}
      {manualOpen && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setManualOpen(false)}>
          <div className="dialog" style={{ width: 440 }}>
            <div className="dialog-header">手动生成知识卡片</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <select
                className="field"
                value={manualSection ?? ''}
                onChange={(e) => setManualSection(Number(e.target.value))}
              >
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  className="field"
                  style={{ flex: 1 }}
                  value={manualTerm}
                  onChange={(e) => setManualTerm(e.target.value)}
                  placeholder={`词条名（如：${termExampleOf(sections.find((s) => s.id === manualSection)?.name ?? '')}）`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && manualTerm.trim()) {
                      setManualOpen(false)
                      void runGenerate(manualTerm.trim(), manualSection)
                    }
                  }}
                />
                <button
                  className="icon-btn"
                  title="随机填一个词条（当前所选板块）"
                  disabled={suggesting || manualSection == null}
                  onClick={() => void suggestTerm()}
                >
                  <span className={`material-symbols-outlined${suggesting ? ' spin' : ''}`}>casino</span>
                </button>
                {suggestJob && (
                  <button
                    className="icon-btn"
                    title="取消本次生成"
                    onClick={() => void window.api.ai.cancel(suggestJob)}
                  >
                    <span className="material-symbols-outlined">stop_circle</span>
                  </button>
                )}
              </div>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setManualOpen(false)}>取消</button>
              <button
                className="btn btn-primary"
                disabled={!manualTerm.trim()}
                onClick={() => {
                  setManualOpen(false)
                  void runGenerate(manualTerm.trim(), manualSection)
                }}
              >
                生成
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 已存在拦截 */}
      {conflictTerm && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setConflictTerm(null)}>
          <div className="dialog" style={{ width: 400 }}>
            <div className="dialog-header">词条已存在</div>
            <div className="dialog-body">「{conflictTerm}」已存在，点击可查看原卡片。</div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setConflictTerm(null)}>关闭</button>
              <button
                className="btn btn-primary"
                disabled={!conflictEntry}
                onClick={() => {
                  if (conflictEntry) setCardEntry(conflictEntry)
                  setConflictTerm(null)
                }}
              >
                查看原卡片
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 板块悬浮菜单 */}
      {sectionMenu && (
        <>
          <div className="dialog-overlay" style={{ background: 'transparent' }} onMouseDown={() => setSectionMenu(null)} />
          <div
            className="ctx-menu"
            style={{ position: 'fixed', top: sectionMenu.top, left: Math.max(8, sectionMenu.left - 150), zIndex: 300 }}
          >
            <button
              className="btn btn-ghost"
              disabled={generating}
              onClick={() => {
                const sid = sectionMenu.section.id
                setSectionMenu(null)
                void runGenerate(null, sid)
              }}
            >
              <span className="material-symbols-outlined">casino</span>
              本板块随机来一条
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setRenameTarget(sectionMenu.section)
                setRenameName(sectionMenu.section.name)
                setRenameOpen(true)
                setSectionMenu(null)
              }}
            >
              <span className="material-symbols-outlined">edit</span>
              改名
            </button>
            <button
              className="btn btn-ghost btn-danger"
              onClick={() => {
                setDelSectionTarget(sectionMenu.section)
                setSectionMenu(null)
              }}
            >
              <span className="material-symbols-outlined">delete</span>
              删除
            </button>
          </div>
        </>
      )}

      {/* 新增板块 */}
      {addSectionOpen && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAddSectionOpen(false)}>
          <div className="dialog" style={{ width: 360 }}>
            <div className="dialog-header">新增板块</div>
            <div className="dialog-body">
              <input className="field" value={newSectionName} onChange={(e) => setNewSectionName(e.target.value)} placeholder="板块名" />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAddSectionOpen(false)}>取消</button>
              <button
                className="btn btn-primary"
                disabled={!newSectionName.trim()}
                onClick={() => {
                  void window.api.wiki.createSection(newSectionName.trim()).then(() => {
                    setAddSectionOpen(false)
                    setNewSectionName('')
                    void loadSections()
                  })
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 板块改名 */}
      {renameOpen && renameTarget && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setRenameOpen(false)}>
          <div className="dialog" style={{ width: 360 }}>
            <div className="dialog-header">板块改名</div>
            <div className="dialog-body">
              <input className="field" value={renameName} onChange={(e) => setRenameName(e.target.value)} />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setRenameOpen(false)}>取消</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  void window.api.wiki.renameSection(renameTarget.id, renameName.trim()).then(() => {
                    setRenameOpen(false)
                    void loadSections()
                  })
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除空板块 */}
      {delSectionTarget && (
        <ConfirmDialog
          open
          title="删除板块"
          confirmText="删除"
          danger
          onConfirm={() => {
            void window.api.wiki.deleteSection(delSectionTarget.id).then(() => {
              setDelSectionTarget(null)
              void loadSections()
              toast('板块已删除')
            }).catch(() => {
              toast('板块非空，不可删除')
              setDelSectionTarget(null)
            })
          }}
          onCancel={() => setDelSectionTarget(null)}
        >
          仅空板块可删除；板块「{delSectionTarget.name}」下的词条需先清空。
        </ConfirmDialog>
      )}

      {/* 词条编辑 */}
      {editEntry && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setEditEntry(null)}>
          <div className="dialog" style={{ width: 460 }}>
            <div className="dialog-header">编辑词条</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input className="field" value={editTerm} onChange={(e) => setEditTerm(e.target.value)} placeholder="词条名" />
              <input className="field" value={editSummary} onChange={(e) => setEditSummary(e.target.value)} placeholder="一句话定义" />
              <div className="module-sub">卡片正文在查看弹窗中双击编辑</div>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setEditEntry(null)}>取消</button>
              <button className="btn btn-primary" onClick={() => void saveEntryEdit()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 词条丢弃 */}
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

      {/* 生成审核：直接删除二次确认（不进回收站） */}
      <ConfirmDialog
        open={reviewDelete != null}
        title="直接删除"
        confirmText="彻底删除"
        danger
        onConfirm={() => void doReviewDelete()}
        onCancel={() => setReviewDelete(null)}
      >
        将彻底删除词条「{reviewDelete?.term ?? ''}」的知识卡片（含划词高光），不经过回收站，删除后无法恢复。
      </ConfirmDialog>

      {/* 高光单删（非破坏性，无二次确认——specs §4） */}
      {delHighlightTarget && (
        <ConfirmDialog
          open
          title="删除笔记本记录"
          onConfirm={() => {
            void window.api.wiki.deleteHighlight(delHighlightTarget.id).then(() => {
              setDelHighlightTarget(null)
              void loadHighlights()
            })
          }}
          onCancel={() => setDelHighlightTarget(null)}
        >
          仅移除笔记本记录，卡片中的高亮标记不受影响。
        </ConfirmDialog>
      )}

      {/* LLM 未配置 */}
      <GoConfigDialog
        open={goConfig != null}
        kind={goConfig ?? 'llm'}
        onGoConfig={() => setGoConfig(null)}
        onCancel={() => setGoConfig(null)}
      />

      {/* 生成失败 */}
      {failMsg && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setFailMsg(null)}>
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-header">生成失败</div>
            <div className="dialog-body" style={{ lineHeight: 1.7, wordBreak: 'break-all' }}>{failMsg}</div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setFailMsg(null)}>关闭</button>
              <button className="btn btn-primary" onClick={() => { setFailMsg(null); void runGenerate(null, null) }}>重试</button>
            </div>
          </div>
        </div>
      )}
      </div>

      {/* 辩真板块（原辩真阁整面板迁入，数据层零改动；onOpenAi 包装直连「辩真·核查」频道） */}
      <div className={tab === 'verify' ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== 'verify'}>
        <VerifyPanel onOpenAi={(p) => props.onOpenAi(p, { channel: 'verify' })} bumpAi={props.bumpAi} />
      </div>
    </div>
  )
}

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
