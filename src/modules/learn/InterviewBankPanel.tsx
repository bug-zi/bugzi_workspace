// 面经题库面板（2026-09-24-面经题库化-design.md §六）：分类胶囊夹 + 题目列表 +
// 去搜集（agent 任务 interview_collect）/ 待审核（采纳/丢弃/批量）/ 手动添加 / 分类管理。
// 样式类全复用既有：recycle-tab 胶囊 / row-item 行 / btn / empty-state / dialog / ConfirmDialog / ActionMenu。
import { useCallback, useEffect, useState } from 'react'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import ActionMenu from '../../components/ActionMenu'
import { useToast } from '../../components/Toast'
import type { InterviewCategory, InterviewIntakeRow, InterviewQuestionRow } from '../../renderer/api'

/** 题库内页签（优化建议区 260924）：题库（未掌握）/待审核/已掌握（毕业题） */
type BankTab = 'bank' | 'intake' | 'mastered'

/** 毕业题（已掌握）：走完 1/3/7/15 天四轮复习，review_stage≥5 */
const isMastered = (q: InterviewQuestionRow): boolean => q.state === 'learned' && q.review_stage >= 5

export default function InterviewBankPanel() {
  const { toast } = useToast()
  const [cats, setCats] = useState<InterviewCategory[]>([])
  const [catId, setCatId] = useState<number | null>(null)
  const [list, setList] = useState<InterviewQuestionRow[]>([])
  const [tab, setTab] = useState<BankTab>('bank')
  const [pending, setPending] = useState<InterviewIntakeRow[]>([])
  const [collecting, setCollecting] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  // 手动添加表单
  const [addCat, setAddCat] = useState<number | ''>('')
  const [addQ, setAddQ] = useState('')
  const [addA, setAddA] = useState('')
  // 审核逐条与批量
  const [adoptId, setAdoptId] = useState<{ intake: InterviewIntakeRow; catId: number } | null>(null)
  const [confirmBatch, setConfirmBatch] = useState<'adopt' | 'discard' | null>(null)
  const [delQ, setDelQ] = useState<InterviewQuestionRow | null>(null)
  const [delCat, setDelCat] = useState<InterviewCategory | null>(null)
  const [openQ, setOpenQ] = useState<InterviewQuestionRow | null>(null)
  const [recallQ, setRecallQ] = useState<InterviewQuestionRow | null>(null)
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null)
  const [goConfig, setGoConfig] = useState<{ open: boolean; kind: 'llm' | 'mcp' }>({
    open: false,
    kind: 'llm'
  })
  // 分类管理弹窗内
  const [newCatName, setNewCatName] = useState('')
  const [renameCat, setRenameCat] = useState<{ id: number; name: string } | null>(null)
  // 移动分类菜单（ActionMenu，anchorEl 锚定）
  const [moveMenuFor, setMoveMenuFor] = useState<{ q: InterviewQuestionRow; anchor: HTMLElement } | null>(null)
  // 回炉重刷（已掌握页签/弹窗入口共用）
  const [reburnQ, setReburnQ] = useState<InterviewQuestionRow | null>(null)

  const loadCats = useCallback(async (): Promise<void> => {
    setCats(await window.api.interview.categories())
  }, [])
  const loadList = useCallback(async (): Promise<void> => {
    setList(await window.api.interview.questions(catId))
  }, [catId])
  const loadPending = useCallback(async (): Promise<void> => {
    setPending(await window.api.interview.intakeList())
  }, [])

  useEffect(() => {
    void loadCats()
    void loadPending()
  }, [loadCats, loadPending])
  useEffect(() => {
    void loadList()
  }, [loadList])

  // 搜集批次事件：运行中置态 + 完成轻提示（点击跳审核）——AI 后台任务完成轻提示全局范式
  useEffect(() => {
    const off = window.api.agent.onAgentStatus((s) => {
      const ev = s.lastEvent
      if (!ev || ev.type !== 'interview_collect') return
      if (ev.status === 'enqueued') {
        setCollecting(true)
        return
      }
      setCollecting(false)
      if (ev.status === 'done') {
        void loadPending()
        toast('面经搜集完成，点击处理待审核题目', {
          onClick: () => {
            setTab('intake')
            void loadPending()
          }
        })
      } else if (ev.status === 'failed') {
        toast('面经搜集失败，详见任务中心')
      }
    })
    return off
  }, [loadPending, toast])

  const collect = (): void => {
    if (collecting) return
    setCollecting(true)
    void window.api.interview
      .collect()
      .catch((e: unknown) => {
        const msg = String((e as Error).message)
        if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig({ open: true, kind: 'llm' })
        else if (msg.includes('MCP')) setGoConfig({ open: true, kind: 'mcp' })
        else toast(`搜集触发失败：${msg}`)
        setCollecting(false)
      })
  }

  const openQuestion = (q: InterviewQuestionRow): void => {
    setOpenQ(null)
    setRecallQ(q)
  }
  const markQ = (id: number, action: 'learn' | 'remember' | 'forget'): void => {
    void window.api.interview.mark(id, action).then((r) => {
      if (!r.ok) return
      setOpenQ(null)
      setRecallQ(null)
      void loadList()
      toast(r.completed ? '今日要求完成！' : action === 'learn' ? '已会，明天复习' : '已记录')
    })
  }
  const skipQ = (): void => {
    toast('别急——明天题库里还会遇到它')
  }
  const reburnConfirm = (): void => {
    if (!reburnQ) return
    void window.api.interview.mark(reburnQ.id, 'reburn').then((r) => {
      if (!r.ok) return
      setReburnQ(null)
      setOpenQ(null)
      setRecallQ(null)
      void loadList()
      toast('已回炉，题目回到待刷池')
    })
  }
  const discardOne = (p: InterviewIntakeRow): void => {
    void window.api.interview.intakeDiscard(p.id).then(() => {
      void loadPending()
      toast('已丢弃')
    })
  }
  const previewIntake = async (p: InterviewIntakeRow): Promise<void> => {
    const md = await window.api.md.read(p.answer_path)
    setPreview({ title: p.question, content: md })
  }
  const adoptConfirm = (): void => {
    if (!adoptId) return
    void window.api.interview
      .intakeAdopt(adoptId.intake.id, adoptId.catId)
      .then(() => {
        setAdoptId(null)
        void loadPending()
        void loadList()
        toast('已采纳入库')
      })
      .catch((e: unknown) => toast(`采纳失败：${(e as Error).message}`))
  }
  const addSave = (): void => {
    if (addCat === '' || !addQ.trim()) return
    void window.api.interview
      .questionAdd(Number(addCat), addQ.trim(), addA)
      .then(() => {
        setAddOpen(false)
        setAddQ('')
        setAddA('')
        void loadList()
        toast(addA.trim() ? '已入库' : '已入库，AI 正在后台补全答案')
      })
      .catch((e: unknown) => {
        const msg = String((e as Error).message)
        toast(msg.includes('DUP_QUESTION') ? '题库已有该题（重复）' : `添加失败：${msg}`)
      })
  }
  const delCatCount = async (c: InterviewCategory): Promise<number> => {
    const rows = await window.api.interview.questions(c.id)
    return rows.length
  }

  // 题库/已掌握分流（渲染层过滤）：题库=待攻克（待刷+复习中），已掌握=毕业题只在已掌握页签
  const bankList = list.filter((q) => !isMastered(q))
  const masteredList = list.filter(isMastered)

  const currentDue = (q: InterviewQuestionRow): boolean =>
    q.state === 'learned' &&
    q.review_stage >= 1 &&
    q.review_stage <= 4 &&
    q.next_review_at != null &&
    q.next_review_at <= new Date()
      .toLocaleDateString('sv')
      .slice(0, 10)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 页签 + 动作条（优化建议区 260924：页签化取代视图切换按钮；去搜集居最右） */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="recycle-tabs">
          <button className={`recycle-tab${tab === 'bank' ? ' active' : ''}`} onClick={() => setTab('bank')}>
            题库
          </button>
          <button
            className={`recycle-tab${tab === 'intake' ? ' active' : ''}`}
            onClick={() => {
              setTab('intake')
              void loadPending()
            }}
          >
            待审核{pending.length > 0 ? ` (${pending.length})` : ''}
          </button>
          <button
            className={`recycle-tab${tab === 'mastered' ? ' active' : ''}`}
            onClick={() => setTab('mastered')}
          >
            已掌握{masteredList.length > 0 ? ` (${masteredList.length})` : ''}
          </button>
        </div>
        <button className="btn" onClick={() => setAddOpen(true)}>
          <span className="material-symbols-outlined">add</span>
          手动添加题
        </button>
        <button className="btn" onClick={() => setManageOpen(true)}>
          <span className="material-symbols-outlined">category</span>
          分类管理
        </button>
        <button className="btn btn-primary" onClick={collect} disabled={collecting} style={{ marginLeft: 'auto' }}>
          <span className={`material-symbols-outlined${collecting ? ' spin' : ''}`}>
            {collecting ? 'progress_activity' : 'cloud_download'}
          </span>
          {collecting ? '搜集中…' : '去搜集'}
        </button>
      </div>

      {tab === 'intake' ? (
        /* 待审核视图 */
        <div>
          {pending.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button className="btn" onClick={() => setConfirmBatch('adopt')}>
                全部采纳
              </button>
              <button className="btn" onClick={() => setConfirmBatch('discard')}>
                全部丢弃
              </button>
              <span className="module-sub" style={{ marginLeft: 'auto', alignSelf: 'center' }}>
                共 {pending.length} 题待审
              </span>
            </div>
          )}
          {pending.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">inbox</span>
              没有待审核的题目——「去搜集」一批面经试试
            </div>
          )}
          {pending.map((p) => (
            <div className="row-item" key={p.id}>
              <div className="row-main">
                <div className="row-title">{p.question}</div>
                <div className="row-sub">
                  建议分类：{p.category_name ?? '待指定'}
                  {p.source ? ` ｜ ${p.source}` : ''}
                </div>
              </div>
              <div className="row-actions">
                <button className="icon-btn" title="查看答案" onClick={() => void previewIntake(p)}>
                  <span className="material-symbols-outlined">visibility</span>
                </button>
                <button
                  className="icon-btn"
                  title="采纳"
                  onClick={() => setAdoptId({ intake: p, catId: p.category_id ?? (cats[0]?.id ?? 0) })}
                >
                  <span className="material-symbols-outlined">check</span>
                </button>
                <button className="icon-btn" title="丢弃" onClick={() => discardOne(p)}>
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* 分类胶囊行（题库/已掌握共用） */}
          <div className="recycle-tabs" style={{ flexWrap: 'wrap' }}>
            <button className={`recycle-tab${catId === null ? ' active' : ''}`} onClick={() => setCatId(null)}>
              全部
            </button>
            {cats.map((c) => (
              <button
                key={c.id}
                className={`recycle-tab${catId === c.id ? ' active' : ''}`}
                onClick={() => setCatId(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
          {/* 题目列表 */}
          <div className="zone-body">
            {tab === 'bank' ? (
              <>
                {bankList.length === 0 && (
                  <div className="empty-state">
                    <span className="material-symbols-outlined">quiz</span>
                    {catId == null
                      ? masteredList.length > 0
                        ? `全部刷完啦——${masteredList.length} 题已掌握，可到「已掌握」页签回看`
                        : '题库还是空的——点「去搜集」抓一批真实面经题'
                      : '该分类暂无未掌握的题目'}
                  </div>
                )}
                {bankList.map((q) => (
                  <div className="row-item" key={q.id} onClick={() => openQuestion(q)}>
                    <span className="material-symbols-outlined">
                      {q.state === 'todo' ? 'radio_button_unchecked' : 'check_circle'}
                    </span>
                    <div className="row-main">
                      <div className="row-title">{q.question}</div>
                      <div className="row-sub">
                        {q.category_name}
                        {q.source ? ` ｜ ${q.source}` : ''}
                      </div>
                    </div>
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="icon-btn"
                        title="移动分类"
                        onClick={(e) => setMoveMenuFor({ q, anchor: e.currentTarget })}
                      >
                        <span className="material-symbols-outlined">drive_file_move_outline</span>
                      </button>
                      <button className="icon-btn" title="删除（入回收站）" onClick={() => setDelQ(q)}>
                        <span className="material-symbols-outlined">delete</span>
                      </button>
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <>
                {masteredList.length === 0 && (
                  <div className="empty-state">
                    <span className="material-symbols-outlined">award</span>
                    还没有已掌握的题——走完 1/3/7/15 天四轮复习的题会毕业到这里
                  </div>
                )}
                {masteredList.map((q) => (
                  <div className="row-item" key={q.id} onClick={() => openQuestion(q)}>
                    <span className="material-symbols-outlined">award</span>
                    <div className="row-main">
                      <div className="row-title">{q.question}</div>
                      <div className="row-sub">
                        {q.category_name}
                        {q.source ? ` ｜ ${q.source}` : ''}
                      </div>
                    </div>
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="icon-btn"
                        title="移动分类"
                        onClick={(e) => setMoveMenuFor({ q, anchor: e.currentTarget })}
                      >
                        <span className="material-symbols-outlined">drive_file_move_outline</span>
                      </button>
                      <button
                        className="icon-btn"
                        title="回炉重刷（重置回待刷，重新进入复习轮转）"
                        onClick={() => setReburnQ(q)}
                      >
                        <span className="material-symbols-outlined">replay</span>
                      </button>
                      <button className="icon-btn" title="删除（入回收站）" onClick={() => setDelQ(q)}>
                        <span className="material-symbols-outlined">delete</span>
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}

      {/* 采纳弹窗：可改分类 */}
      {adoptId && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAdoptId(null)}>
          <div className="dialog" style={{ width: 460 }}>
            <div className="dialog-header">采纳入库</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontWeight: 600, lineHeight: 1.6 }}>{adoptId.intake.question}</div>
              <label className="module-sub">选择分类</label>
              <select
                className="field"
                value={adoptId.catId}
                onChange={(e) => setAdoptId({ ...adoptId, catId: Number(e.target.value) })}
              >
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="dialog-footer" style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setAdoptId(null)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={adoptConfirm}>
                采纳
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 手动添加弹窗 */}
      {addOpen && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAddOpen(false)}>
          <div className="dialog" style={{ width: 520 }}>
            <div className="dialog-header">手动添加面试题</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <select
                className="field"
                value={addCat}
                onChange={(e) => setAddCat(e.target.value ? Number(e.target.value) : '')}
              >
                <option value="">选择分类…</option>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <textarea
                className="field"
                rows={3}
                placeholder="题干（必填）"
                value={addQ}
                onChange={(e) => setAddQ(e.target.value)}
              />
              <textarea
                className="field"
                rows={6}
                placeholder="参考答案（可留空 = 让 AI 后台补全）"
                value={addA}
                onChange={(e) => setAddA(e.target.value)}
              />
            </div>
            <div className="dialog-footer" style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setAddOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" disabled={addCat === '' || !addQ.trim()} onClick={addSave}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 分类管理弹窗：改名 / 上下移 / 删除 / 新建 */}
      {manageOpen && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setManageOpen(false)}>
          <div className="dialog" style={{ width: 480 }}>
            <div className="dialog-header">分类管理</div>
            <div
              className="dialog-body"
              style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '60vh', overflowY: 'auto' }}
            >
              {cats.map((c, i) => (
                <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {renameCat?.id === c.id ? (
                    <input
                      className="field"
                      value={renameCat.name}
                      autoFocus
                      onChange={(e) => setRenameCat({ id: c.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && renameCat.name.trim()) {
                          void window.api.interview
                            .categoryRename(c.id, renameCat.name.trim())
                            .then(() => {
                              setRenameCat(null)
                              return loadCats()
                            })
                            .then(() => loadList())
                            .catch((err: unknown) =>
                              toast(
                                String((err as Error).message).includes('DUP_CATEGORY') ? '分类名已存在' : '改名失败'
                              )
                            )
                        } else if (e.key === 'Escape') setRenameCat(null)
                      }}
                    />
                  ) : (
                    <span style={{ flex: 1 }}>{c.name}</span>
                  )}
                  <button
                    className="icon-btn"
                    title="上移"
                    disabled={i === 0}
                    onClick={() => void window.api.interview.categoryReorder(c.id, 'up').then(() => loadCats())}
                  >
                    <span className="material-symbols-outlined">arrow_upward</span>
                  </button>
                  <button
                    className="icon-btn"
                    title="下移"
                    disabled={i === cats.length - 1}
                    onClick={() => void window.api.interview.categoryReorder(c.id, 'down').then(() => loadCats())}
                  >
                    <span className="material-symbols-outlined">arrow_downward</span>
                  </button>
                  <button className="icon-btn" title="改名" onClick={() => setRenameCat({ id: c.id, name: c.name })}>
                    <span className="material-symbols-outlined">edit</span>
                  </button>
                  <button className="icon-btn" title="删除分类" onClick={() => setDelCat(c)}>
                    <span className="material-symbols-outlined">delete</span>
                  </button>
                </div>
              ))}
              <input
                className="field"
                style={{ marginTop: 8 }}
                placeholder="新分类名，回车创建"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newCatName.trim()) {
                    void window.api.interview
                      .categoryCreate(newCatName.trim())
                      .then(() => {
                        setNewCatName('')
                        return loadCats()
                      })
                      .catch((err: unknown) =>
                        toast(String((err as Error).message).includes('DUP_CATEGORY') ? '分类名已存在' : '创建失败')
                      )
                  }
                }}
              />
            </div>
            <div className="dialog-footer" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setManageOpen(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 移动分类菜单 */}
      {moveMenuFor && (
        <ActionMenu
          anchorEl={moveMenuFor.anchor}
          items={cats.map((c) => ({
            key: String(c.id),
            icon: c.id === moveMenuFor.q.category_id ? 'check' : undefined,
            label: c.name,
            onClick: () => {
              const q = moveMenuFor.q
              setMoveMenuFor(null)
              void window.api.interview.questionMove(q.id, c.id).then(() => {
                void loadList()
                toast(`已移入「${c.name}」`)
              })
            }
          }))}
          onClose={() => setMoveMenuFor(null)}
        />
      )}
      {/* 待审核答案预览（只读） */}
      {preview && (
        <MdDialog open title={preview.title} content={preview.content} readOnly onClose={() => setPreview(null)} />
      )}
      {/* 回忆态小窗（题库内点题同款交互） */}
      {recallQ && !openQ && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setRecallQ(null)}>
          <div className="dialog" style={{ width: 560 }}>
            <div className="dialog-header">回忆这道题</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span
                  style={{
                    alignSelf: 'flex-start',
                    fontSize: '0.75em',
                    padding: '2px 10px',
                    borderRadius: 999,
                    background: 'var(--color-primary-soft)',
                    color: 'var(--color-primary-deep)',
                    border: '1px solid var(--color-primary)'
                  }}
                >
                  {recallQ.category_name}
                </span>
                {recallQ.source && <span className="module-sub">{recallQ.source}</span>}
              </div>
              <div style={{ fontSize: '1.15em', fontWeight: 600, lineHeight: 1.7 }}>{recallQ.question}</div>
              <div className="module-sub">先在脑子里把答案过一遍（或口述一遍），再对照参考答案查漏。</div>
            </div>
            <div className="dialog-footer" style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setRecallQ(null)}>
                关闭
              </button>
              <button className="btn btn-primary" onClick={() => setOpenQ(recallQ)}>
                <span className="material-symbols-outlined">visibility</span>
                查看参考答案
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 对照态：MdDialog + footerBar 自评条 */}
      {openQ && (
        <MdDialog
          open
          title={openQ.question}
          titleTag={openQ.category_name}
          subtitle={openQ.source || undefined}
          filePath={openQ.answer_path}
          footerBar={
            openQ.state === 'todo' ? (
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={skipQ}>
                  还不熟
                </button>
                <button className="btn btn-primary" onClick={() => markQ(openQ.id, 'learn')}>
                  会了
                </button>
              </div>
            ) : currentDue(openQ) ? (
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => markQ(openQ.id, 'forget')}>
                  忘记了
                </button>
                <button className="btn btn-primary" onClick={() => markQ(openQ.id, 'remember')}>
                  记住了
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end' }}>
                <span className="module-sub">
                  {openQ.review_stage >= 5
                    ? '已毕业'
                    : openQ.next_review_at != null
                      ? `已会 · ${openQ.next_review_at} 复习`
                      : '已会'}
                </span>
                {isMastered(openQ) && (
                  <button className="btn" onClick={() => setReburnQ(openQ)}>
                    <span className="material-symbols-outlined">replay</span>
                    回炉重刷
                  </button>
                )}
              </div>
            )
          }
          onClose={() => {
            setOpenQ(null)
            setRecallQ(null)
            void loadList()
          }}
        />
      )}
      {/* ConfirmDialog 群 */}
      <ConfirmDialog
        open={delQ != null}
        title="删除题目"
        danger
        confirmText="删除"
        onConfirm={() => {
          if (delQ)
            void window.api.interview.questionDelete(delQ.id).then(() => {
              void loadList()
              toast('已移入回收站')
            })
          setDelQ(null)
        }}
        onCancel={() => setDelQ(null)}
      >
        确定删除「{delQ?.question.slice(0, 30)}…」？将移入回收站。
      </ConfirmDialog>
      <ConfirmDialog
        open={delCat != null}
        title="删除分类"
        danger
        confirmText="删除"
        onConfirm={() => {
          if (delCat)
            void window.api.interview.categoryDelete(delCat.id).then(() => {
              if (catId === delCat.id) setCatId(null)
              void loadCats()
              void loadList()
              void loadPending()
            })
          setDelCat(null)
        }}
        onCancel={() => setDelCat(null)}
      >
        将删除分类「{delCat?.name}」及其下全部题目（一并移入回收站，可在回收站恢复题目）。确定继续？
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmBatch != null}
        title={confirmBatch === 'adopt' ? '全部采纳' : '全部丢弃'}
        danger={confirmBatch === 'discard'}
        confirmText={confirmBatch === 'adopt' ? '全部采纳' : '全部丢弃'}
        onConfirm={() => {
          const adopt = confirmBatch === 'adopt'
          setConfirmBatch(null)
          void window.api.interview.intakeBatch(adopt).then(() => {
            void loadPending()
            if (adopt) void loadList()
            toast(adopt ? '已全部采纳入库（默认归入第一个分类，可后改）' : '已全部丢弃')
          })
        }}
        onCancel={() => setConfirmBatch(null)}
      >
        {confirmBatch === 'adopt'
          ? `将 ${pending.length} 题全部采纳入库（未指定分类的归入第一个分类）。确定继续？`
          : `将 ${pending.length} 题全部丢弃（不可恢复）。确定继续？`}
      </ConfirmDialog>
      <ConfirmDialog
        open={reburnQ != null}
        title="回炉重刷"
        confirmText="回炉"
        onConfirm={reburnConfirm}
        onCancel={() => setReburnQ(null)}
      >
        「{reburnQ?.question.slice(0, 30)}
        …」将重置回待刷状态（清空复习进度），重新进入 1/3/7/15 天复习轮转。确定回炉？
      </ConfirmDialog>
      <GoConfigDialog
        open={goConfig.open}
        kind={goConfig.kind}
        onGoConfig={() => setGoConfig({ open: false, kind: goConfig.kind })}
        onCancel={() => setGoConfig({ open: false, kind: goConfig.kind })}
      />
    </div>
  )
}
