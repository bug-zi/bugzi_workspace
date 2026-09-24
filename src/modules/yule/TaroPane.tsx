// 塔罗板块（娱乐城 specs §2）：选阵 → 抽牌翻牌（本地随机）→ AI 解读 → 自动存档 + 记录列表
import { useCallback, useEffect, useState } from 'react'
import type { TaroCardPick, TaroRecordView } from '../../renderer/api'
import { TARO_SPREADS, TARO_CARDS, drawCards } from './taro/cards'
import type { DrawnCard, TaroSpreadKey } from './taro/cards'
import MdDialog from '../../components/MdDialog'
import MdView from '../../components/MdView'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import HelpDialog from './HelpDialog'
import { TARO_HELP_MD } from './help'
import { useToast } from '../../components/Toast'

const SPREAD_NAME: Record<string, string> = Object.fromEntries(
  Object.values(TARO_SPREADS).map((s) => [s.key, s.name])
)

function cardLabel(c: TaroCardPick): string {
  return `${c.name}（${c.upright ? '正位' : '逆位'}）`
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function TaroPane() {
  const { toast } = useToast()
  const [spread, setSpread] = useState<TaroSpreadKey>('single')
  const [question, setQuestion] = useState('')
  const [drawn, setDrawn] = useState<DrawnCard[] | null>(null)
  const [flipped, setFlipped] = useState<boolean[]>([])
  const [interpretJob, setInterpretJob] = useState<string | null>(null)
  const [interpretation, setInterpretation] = useState('')
  const [records, setRecords] = useState<TaroRecordView[]>([])
  const [recordDoc, setRecordDoc] = useState<{ title: string; subtitle: string; path: string } | null>(null)
  const [removeTarget, setRemoveTarget] = useState<TaroRecordView | null>(null)
  const [goConfig, setGoConfig] = useState(false)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  const loadRecords = useCallback(async () => {
    try {
      setRecords(await window.api.yule.taroList())
    } catch (e) {
      toast(`记录加载失败：${(e as Error).message}`)
    }
  }, [toast])

  useEffect(() => {
    void loadRecords()
  }, [loadRecords])

  const allFlipped = drawn != null && flipped.length === drawn.length && flipped.every(Boolean)

  const doDraw = (): void => {
    const cards = drawCards(spread)
    setDrawn(cards)
    setFlipped([])
    setInterpretation('')
    setFailMsg(null)
  }

  const reset = (): void => {
    setDrawn(null)
    setFlipped([])
    setInterpretation('')
    setQuestion('')
  }

  const handleErr = (e: unknown): void => {
    const msg = String((e as Error).message)
    if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
    else setFailMsg(msg)
  }

  const doInterpret = async (): Promise<void> => {
    if (!drawn || !allFlipped) return
    const jobId = `taro-${Date.now()}`
    setInterpretJob(jobId)
    setFailMsg(null)
    try {
      const picks: TaroCardPick[] = drawn.map((c) => ({ position: c.position, name: c.def.name, upright: c.upright }))
      const aiMd = await window.api.yule.taroInterpret(jobId, {
        spreadName: SPREAD_NAME[spread],
        question,
        cards: picks
      })
      const md = `# 塔罗解读 · ${todayStr()}\n\n> ${SPREAD_NAME[spread]} ｜ 所问：${question.trim() || '—'}\n\n## 牌面\n\n${picks
        .map((p) => `- **${p.position}**：${cardLabel(p)}`)
        .join('\n')}\n\n## 解读\n\n${aiMd}\n`
      setInterpretation(md)
      await window.api.yule.taroSave({ spread, question: question.trim(), cards: picks, md })
      toast('解读已存档')
      void loadRecords()
    } catch (e) {
      handleErr(e)
    } finally {
      setInterpretJob(null)
    }
  }

  const doRemove = async (): Promise<void> => {
    if (!removeTarget) return
    try {
      await window.api.yule.taroRemove(removeTarget.id)
      toast('已移入回收站')
      void loadRecords()
    } catch (e) {
      toast(`删除失败：${(e as Error).message}`)
    } finally {
      setRemoveTarget(null)
    }
  }

  return (
    <div className="yule-pane">
      <div className="yule-taro-setup">
        <div className="yule-spread-row">
          {Object.values(TARO_SPREADS).map((s) => (
            <button
              key={s.key}
              className={`yule-spread-card${spread === s.key ? ' active' : ''}`}
              onClick={() => {
                if (interpretJob || drawn) return
                setSpread(s.key)
              }}
            >
              <span className="yule-spread-name">{s.name}</span>
              <span className="yule-spread-desc">{s.desc}</span>
            </button>
          ))}
        </div>
        <input
          className="yule-question-input"
          placeholder="所问之事（可选）：感情、工作、抉择……"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={drawn != null || interpretJob != null}
        />
        <div className="yule-action-row">
          <button className="yule-btn" onClick={doDraw} disabled={interpretJob != null}>
            {drawn ? '重新洗牌' : '洗牌抽牌'}
          </button>
          {drawn && (
            <button className="yule-btn" onClick={reset} disabled={interpretJob != null}>
              收牌
            </button>
          )}
          <span className="yule-action-spacer" />
          <button className="yule-mini-btn" onClick={() => setHelpOpen(true)}>
            玩法
          </button>
        </div>
      </div>

      {drawn && (
        <div className="yule-taro-table">
          <div className={`yule-taro-row${drawn.length > 1 ? ' multi' : ''}`}>
            {drawn.map((c, i) => (
              <div
                key={i}
                className={`yule-taro-card${flipped[i] ? ' flipped' : ''}${c.upright ? '' : ' reversed'}`}
                onClick={() => {
                  if (flipped[i] || interpretJob) return
                  setFlipped((f) => {
                    const n = [...f]
                    n[i] = true
                    return n
                  })
                }}
                title={flipped[i] ? `${c.def.name}（${c.upright ? '正位' : '逆位'}）· ${c.position}` : '点击翻开'}
              >
                <div className="yule-taro-card-inner">
                  <div className="yule-taro-card-back">
                    <span className="material-symbols-outlined">auto_awesome</span>
                  </div>
                  <div className="yule-taro-card-face">
                    <span className="yule-taro-card-pos">{c.position}</span>
                    <span className="yule-taro-card-name">{c.def.name}</span>
                    <span className="yule-taro-card-ori">{c.upright ? '正位' : '逆位'}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="yule-taro-hint">
            {allFlipped ? '牌面已齐，可开始解读' : '点击牌背逐张翻开'}
            {` · 共 ${TARO_CARDS.length} 张牌池`}
          </p>
          <button className="yule-btn primary" onClick={() => void doInterpret()} disabled={!allFlipped || interpretJob != null}>
            {interpretJob ? '解读中…' : 'AI 解读'}
          </button>
          {failMsg && <p className="yule-fail">解读失败：{failMsg}</p>}
        </div>
      )}

      {interpretation && (
        <div className="yule-interpret-result">
          <h4 className="yule-section-title">本次解读</h4>
          <div className="yule-interpret-md">
            <MdView md={interpretation} />
          </div>
        </div>
      )}

      <div className="yule-records">
        <h4 className="yule-section-title">解读记录（{records.length}）</h4>
        {records.length === 0 && <p className="yule-empty">还没有解读记录</p>}
        {records.map((r) => {
          let cards: TaroCardPick[] = []
          try {
            cards = JSON.parse(r.cards) as TaroCardPick[]
          } catch {
            /* 坏数据忽略 */
          }
          return (
            <div key={r.id} className="yule-record-row">
              <span className="yule-record-date">{r.created_at.slice(0, 10)}</span>
              <span className="yule-record-main">
                {r.question ? r.question : cards.map(cardLabel).join(' / ')}
                <em className="yule-record-sub">{r.question ? cards.map(cardLabel).join(' / ') : SPREAD_NAME[r.spread] ?? r.spread}</em>
              </span>
              <button className="yule-mini-btn" onClick={() => setRecordDoc({ title: '塔罗解读', subtitle: r.created_at.slice(0, 10), path: r.md_path })}>
                查看
              </button>
              <button className="yule-mini-btn danger" onClick={() => setRemoveTarget(r)}>
                删除
              </button>
            </div>
          )
        })}
      </div>

      <ConfirmDialog
        open={removeTarget != null}
        title="放入回收站"
        confirmText="丢弃"
        danger
        onConfirm={() => void doRemove()}
        onCancel={() => setRemoveTarget(null)}
      />
      <MdDialog
        key={recordDoc?.path ?? 'none'}
        open={recordDoc != null}
        title={recordDoc?.title ?? ''}
        subtitle={recordDoc?.subtitle}
        filePath={recordDoc?.path ?? ''}
        onClose={() => setRecordDoc(null)}
      />
      <GoConfigDialog open={goConfig} kind="llm" onGoConfig={() => setGoConfig(false)} onCancel={() => setGoConfig(false)} />
      <HelpDialog open={helpOpen} md={TARO_HELP_MD} onClose={() => setHelpOpen(false)} />
    </div>
  )
}
