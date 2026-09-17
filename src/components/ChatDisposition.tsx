// AI 会话三选（优化建议区第47轮）：每轮 AI 回复后的「继续对话/保存对话/归档对话」处置条 +
// 保存落点小窗（按频道变体：learn→知识点卡 / wiki→词条卡 / zhijiji→问题版本）。
// AiSidebar 与 ChannelChatPanel 两承载面共用；终结式——保存/归档后由调用方切新会话。
import { useEffect, useState } from 'react'
import type { AiMessageRow } from '../renderer/api'
import { AI_NAME } from '../shared/types'
import { useToast } from './Toast'
import './ChatDisposition.css'

export type DispositionChannel = 'learn' | 'wiki' | 'zhijiji'

const DISPOSITION_CHANNELS: readonly string[] = ['learn', 'wiki', 'zhijiji']

export const isDispositionChannel = (ch: string): boolean => DISPOSITION_CHANNELS.includes(ch)

const CHANNEL_LABEL: Record<DispositionChannel, string> = {
  learn: '学习·问答',
  wiki: '万象·问答',
  zhijiji: '致知己·追问'
}

/** 保存成功 toast 用的模块名 */
const MODULE_LABEL: Record<DispositionChannel, string> = {
  learn: '学习库',
  wiki: '万象库',
  zhijiji: '致知己'
}

/** 会话消息 → md 封装（原样完整对话，双击可再编辑；system 行剔除） */
export function buildChatTranscriptMd(
  title: string,
  channel: DispositionChannel,
  messages: AiMessageRow[]
): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const parts: string[] = [`# ${title}`, '', `> 保存于 ${stamp} · 来自「${CHANNEL_LABEL[channel]}」对话`, '']
  for (const m of messages) {
    if (m.role === 'system') continue
    parts.push(`## ${m.role === 'user' ? '用户' : AI_NAME}`, '', m.content.trim(), '')
  }
  return parts.join('\n')
}

/** 三选条（仅挂在最新一条 AI 回复下方；由调用方控制显隐条件） */
export function ChatDispositionBar(props: {
  onContinue: () => void
  onSave: () => void
  onArchive: () => void
}) {
  return (
    <div className="chat-disposition-bar">
      <button className="chat-disposition-btn" onClick={props.onContinue} title="收起选择，保留上下文继续对话">
        <span className="material-symbols-outlined">forum</span>
        继续对话
      </button>
      <button className="chat-disposition-btn primary" onClick={props.onSave} title="封装为 md 卡片存入对应模块">
        <span className="material-symbols-outlined">save</span>
        保存对话
      </button>
      <button className="chat-disposition-btn" onClick={props.onArchive} title="会话移入回收站「AI 会话」（3 天后自动清理）">
        <span className="material-symbols-outlined">archive</span>
        归档对话
      </button>
    </div>
  )
}

/** 最小结构行：领域/板块用 name，主题/问题用 title */
interface IdNameRow {
  id: number
  name: string
}
interface IdTitleRow {
  id: number
  title: string
}

export interface SaveChatDialogProps {
  open: boolean
  channel: DispositionChannel
  defaultTitle: string
  md: string
  onCancel: () => void
  /** 保存成功（target = 模块名，供 toast） */
  onSaved: (target: string) => void
}

export function SaveChatDialog(props: SaveChatDialogProps) {
  const { open, channel, defaultTitle, md, onCancel, onSaved } = props
  const { toast } = useToast()
  const [title, setTitle] = useState(defaultTitle)
  const [busy, setBusy] = useState(false)
  // learn：领域›主题 两级（主题含「＋ 新建主题…」）
  const [domains, setDomains] = useState<IdNameRow[]>([])
  const [domainId, setDomainId] = useState<number | null>(null)
  const [topics, setTopics] = useState<IdTitleRow[]>([])
  const [topicId, setTopicId] = useState<number | 'new' | null>(null)
  const [newTopic, setNewTopic] = useState('')
  // wiki：板块
  const [sections, setSections] = useState<IdNameRow[]>([])
  const [sectionId, setSectionId] = useState<number | null>(null)
  // zhijiji：新建问题 / 附加既有
  const [mode, setMode] = useState<'new' | 'append'>('new')
  const [questions, setQuestions] = useState<IdTitleRow[]>([])
  const [questionId, setQuestionId] = useState<number | null>(null)

  // 打开时重置表单 + 预载落点候选
  useEffect(() => {
    if (!open) return
    setTitle(defaultTitle)
    setBusy(false)
    setDomainId(null)
    setTopics([])
    setTopicId(null)
    setNewTopic('')
    setSectionId(null)
    setMode('new')
    setQuestionId(null)
    void (async () => {
      try {
        if (channel === 'learn') {
          const ds = (await window.api.learn.domains()) as IdNameRow[]
          setDomains(ds)
          if (ds.length > 0) setDomainId(ds[0].id)
        } else if (channel === 'wiki') {
          const ss = (await window.api.wiki.sections()) as IdNameRow[]
          setSections(ss)
          if (ss.length > 0) setSectionId(ss[0].id)
        } else {
          const qs = (await window.api.zhijiji.list()) as IdTitleRow[]
          setQuestions(qs)
        }
      } catch {
        /* 候选载入失败：提交时按空态拦截 */
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, channel])

  // 选领域 → 载其主题
  useEffect(() => {
    if (channel !== 'learn' || domainId == null) {
      setTopics([])
      setTopicId(null)
      return
    }
    void (async () => {
      try {
        const ts = (await window.api.learn.tree(domainId)) as IdTitleRow[]
        setTopics(ts)
        setTopicId(ts.length > 0 ? ts[0].id : 'new')
      } catch {
        setTopics([])
        setTopicId('new')
      }
    })()
  }, [channel, domainId])

  if (!open) return null

  const canSubmit = (): boolean => {
    if (!title.trim()) return false
    if (channel === 'learn') {
      if (domainId == null) return false
      if (topicId === 'new') return !!newTopic.trim()
      return topicId != null
    }
    if (channel === 'wiki') return sectionId != null
    return mode === 'append' ? questionId != null : true
  }

  const submit = async (): Promise<void> => {
    if (busy || !canSubmit()) return
    setBusy(true)
    try {
      if (channel === 'learn') {
        let tid = topicId
        if (tid === 'new') tid = await window.api.learn.topicCreate(domainId as number, newTopic.trim())
        await window.api.learn.saveChatCard(tid as number, title.trim(), md)
      } else if (channel === 'wiki') {
        if (sectionId == null) {
          toast('暂无板块，请先在万象库创建板块')
          setBusy(false)
          return
        }
        await window.api.wiki.saveChatCard(sectionId, title.trim(), md)
      } else if (mode === 'append') {
        if (questionId == null) {
          toast('请选择要附加到的问题')
          setBusy(false)
          return
        }
        await window.api.zhijiji.saveNewVersion(questionId, md)
      } else {
        const r = await window.api.zhijiji.createQuestion(crypto.randomUUID(), title.trim())
        await window.api.zhijiji.overwriteVersion(r.versionId, md)
      }
      onSaved(MODULE_LABEL[channel])
    } catch (e) {
      const msg = String((e as Error).message)
      toast(msg.startsWith('CONFLICT:') ? `「${msg.slice(9)}」已存在，换个标题` : `保存失败：${msg.slice(0, 80)}`)
      setBusy(false)
    }
  }

  return (
    <div className="scd-overlay" onMouseDown={onCancel}>
      <div className="scd-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="scd-head">
          <span className="material-symbols-outlined">save</span>
          <span>保存对话到{MODULE_LABEL[channel]}</span>
          <button className="icon-btn" onClick={onCancel} title="取消">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="scd-body">
          <label className="scd-field">
            <span className="scd-label">卡片标题</span>
            <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>

          {channel === 'learn' && (
            <>
              <label className="scd-field">
                <span className="scd-label">领域</span>
                {domains.length === 0 ? (
                  <span className="scd-hint">知识树还没有领域，请先到学习库·知识树创建</span>
                ) : (
                  <select value={domainId ?? ''} onChange={(e) => setDomainId(Number(e.target.value))}>
                    {domains.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
              {domains.length > 0 && (
                <label className="scd-field">
                  <span className="scd-label">主题</span>
                  <select
                    value={topicId == null ? '' : String(topicId)}
                    onChange={(e) => setTopicId(e.target.value === 'new' ? 'new' : Number(e.target.value))}
                  >
                    {topics.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                    <option value="new">＋ 新建主题…</option>
                  </select>
                </label>
              )}
              {topicId === 'new' && (
                <label className="scd-field">
                  <span className="scd-label">新主题名</span>
                  <input
                    value={newTopic}
                    maxLength={40}
                    placeholder="输入主题名"
                    onChange={(e) => setNewTopic(e.target.value)}
                  />
                </label>
              )}
              <div className="scd-hint">卡片以「待学习」进入该主题，由你点「学会了」计入每日新学。</div>
            </>
          )}

          {channel === 'wiki' && (
            <>
              <label className="scd-field">
                <span className="scd-label">落点板块</span>
                {sections.length === 0 ? (
                  <span className="scd-hint">万象库还没有板块，请先创建板块</span>
                ) : (
                  <select value={sectionId ?? ''} onChange={(e) => setSectionId(Number(e.target.value))}>
                    {sections.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
              <div className="scd-hint">卡片以「已学」直接进入板块，不占用每日待学习批次。</div>
            </>
          )}

          {channel === 'zhijiji' && (
            <>
              <div className="scd-modes">
                <button className={`scd-mode${mode === 'new' ? ' active' : ''}`} onClick={() => setMode('new')}>
                  新建问题
                </button>
                <button
                  className={`scd-mode${mode === 'append' ? ' active' : ''}`}
                  onClick={() => setMode('append')}
                >
                  附加到既有问题
                </button>
              </div>
              {mode === 'new' ? (
                <div className="scd-hint">以标题新建一个沉淀区问题，对话封装为它的首个版本。</div>
              ) : questions.length === 0 ? (
                <div className="scd-hint">沉淀区还没有问题，请改选「新建问题」</div>
              ) : (
                <label className="scd-field">
                  <span className="scd-label">选择问题</span>
                  <select value={questionId ?? ''} onChange={(e) => setQuestionId(Number(e.target.value))}>
                    <option value="" disabled>
                      选择要附加到的问题…
                    </option>
                    {questions.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="scd-hint">对话将作为一个「对话存档」版本追加，原有版本不受影响。</div>
            </>
          )}
        </div>
        <div className="scd-foot">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!canSubmit() || busy} onClick={() => void submit()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
