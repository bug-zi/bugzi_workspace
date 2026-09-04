// 致知己模块（致知己 specs §2）：问题 + 多版本答案，保存即版本，AI 只追问不代笔
import { useCallback, useEffect, useState } from 'react'
import type { ZhijijiQuestion, ZhijijiVersion } from '../../renderer/api'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

export interface ZhijijiModuleProps {
  onOpenAi: (prefill?: string, opts?: { auto?: boolean }) => void
  onNavigateToProfile: () => void
}

/** 标签输入解析：逗号（,，）或顿号（、）分隔多个 */
const parseTagInput = (raw: string): string[] =>
  raw
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)

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
  // 详情弹窗：问题 + 版本列表 + 当前版本
  const [viewQ, setViewQ] = useState<ZhijijiQuestion | null>(null)
  const [versions, setVersions] = useState<ZhijijiVersion[]>([])
  const [curVerId, setCurVerId] = useState<number | null>(null)
  const [autoEdit, setAutoEdit] = useState(false)
  // 删除确认 / LLM 未配置
  const [discardTarget, setDiscardTarget] = useState<ZhijijiQuestion | null>(null)
  const [needConfig, setNeedConfig] = useState(false)

  const curVersion = versions.find((v) => v.id === curVerId) ?? null

  const load = useCallback(async () => {
    const rows = await window.api.zhijiji.list()
    setQuestions(rows)
    // 弹窗打开中：同步标题/版本数/更新时间（改名、保存版本后列表保持新鲜）
    setViewQ((vq) => rows.find((r) => r.id === vq?.id) ?? vq)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // keep-alive：切回致知己时刷新（回收站恢复等问题列表可能已变）
  useModuleActivated('zhijiji', () => void load())

  /** 打开问题详情：载入版本列表并定位到最新版本 */
  const open = useCallback(async (q: ZhijijiQuestion, auto: boolean): Promise<void> => {
    const vs = await window.api.zhijiji.versions(q.id)
    setVersions(vs)
    setCurVerId(vs[0]?.id ?? null)
    setViewQ(q)
    setAutoEdit(auto)
  }, [])

  /** 新建问题：创建即建空白 v1 → 打开弹窗直接进入编辑态 */
  const createQuestion = async (): Promise<void> => {
    const t = addTitle.trim()
    if (!t) {
      toast('请填写问题标题')
      return
    }
    const r = await window.api.zhijiji.createQuestion(t, parseTagInput(addTags))
    setAdding(false)
    setAddTitle('')
    setAddTags('')
    toast('已创建，写下属于你的 v1')
    await load()
    const rows = await window.api.zhijiji.list()
    const q = rows.find((x) => x.id === r.questionId)
    if (q) await open(q, true)
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

  /** 让 AI 追问（specs §2）：切边栏致知己频道并自动发送，AI 只追问不代笔 */
  const askAi = async (content: string): Promise<void> => {
    const configured = await window.api.ai.configured()
    if (!configured) {
      setNeedConfig(true)
      return
    }
    const label = curVersion ? `v${curVersion.seq}-${curVersion.date}` : '当前版本'
    props.onOpenAi(
      `请对我写给自己的这个答案发起追问（较真地检验它，不要替我重写）：\n\n【问题】${viewQ?.title ?? ''}\n【当前版本】${label}\n【我的答案】\n${content}`,
      { auto: true }
    )
  }

  const doDiscard = async (): Promise<void> => {
    if (!discardTarget) return
    await window.api.zhijiji.discard(discardTarget.id)
    toast('已放入回收站')
    if (viewQ?.id === discardTarget.id) setViewQ(null)
    setDiscardTarget(null)
    await load()
  }

  return (
    <div className="module-page">
      <div className="module-header">
        <span className="material-symbols-outlined">self_improvement</span>
        <span className="module-title">致知己</span>
        <span className="module-sub">把属于自己的答案沉淀成版本</span>
        <div className="zone-actions" style={{ marginLeft: 'auto' }}>
          <button className="btn" onClick={() => setAdding(true)}>
            <span className="material-symbols-outlined">add</span>
            新问题
          </button>
        </div>
      </div>

      <section className="zone">
        <div className="zone-body">
          {questions.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">self_improvement</span>
              还没有问题，点右上角「新问题」开始写下属于自己的答案
            </div>
          )}
          {questions.map((q) => (
            <div className="row-item" key={q.id} onClick={() => void open(q, false)} title="点击打开答案版本">
              <div className="row-main">
                <div className="row-title">{q.title}</div>
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

      {/* 答案版本弹窗：MdDialog + 版本切换条 + 保存即版本 + 让 AI 追问 */}
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
      />

      {/* 新问题弹窗 */}
      {adding && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAdding(false)}>
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
              <div className="module-sub">创建后会直接打开空白 v1，双击即可开始写属于你的答案</div>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAdding(false)}>取消</button>
              <button className="btn btn-primary" onClick={() => void createQuestion()}>创建</button>
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
    </div>
  )
}
