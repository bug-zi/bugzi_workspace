// 飞花令页签（designs-specs §2.2）：每日一令卡（打卡锚点）+ 自由练 + 对局 + 历史对局列表。
// 判字与查重走本地规则（fushiNorm），AI 只出句不当裁判；终局两条路径：我认负 / AI giveUp。
import { useCallback, useEffect, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import MdDialog from '../../components/MdDialog'
import { useToast } from '../../components/Toast'
import FeihuaGame, { type FeihuaFinished } from './FeihuaGame'
import { fushiNorm, FEIHUA_KEYWORDS } from '../../shared/types'
import type { FeihuaLine, FushiDailyView, FushiGameRow } from '../../shared/types'

interface Props {
  onNeedConfig: () => void
}

export default function FeihuaPanel({ onNeedConfig }: Props) {
  const { toast } = useToast()
  const [daily, setDaily] = useState<FushiDailyView | null>(null)
  const [history, setHistory] = useState<FushiGameRow[]>([])
  const [playing, setPlaying] = useState<{ keyword: string; daily: boolean } | null>(null)
  const [lines, setLines] = useState<FeihuaLine[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [finished, setFinished] = useState<FeihuaFinished | null>(null)
  const [freeOpen, setFreeOpen] = useState(false)
  const [giveUpOpen, setGiveUpOpen] = useState(false)
  const [delQ, setDelQ] = useState<FushiGameRow | null>(null)
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setDaily(await window.api.fushi.daily())
      setHistory(await window.api.fushi.games('feihua'))
    } catch (e) {
      toast(`加载失败：${(e as Error).message}`)
    }
  }, [toast])
  useEffect(() => {
    void load()
  }, [load])

  const usedNorms = (): Set<string> => new Set(lines.map((l) => fushiNorm(l.line)))

  const startGame = (keyword: string, isDaily: boolean): void => {
    setLines([])
    setError('')
    setFinished(null)
    setPlaying({ keyword, daily: isDaily })
  }

  const endGame = async (result: 'win' | 'lose'): Promise<void> => {
    if (!playing) return
    try {
      const gameId = await window.api.fushi.feihuaEnd(playing.keyword, playing.daily, result, lines)
      setFinished({ result, gameId })
      setPlaying(null)
      await load()
    } catch (e) {
      toast(`留档失败：${(e as Error).message}`)
    }
  }

  const submit = (raw: string): void => {
    if (!playing || busy) return
    const norm = fushiNorm(raw)
    if (!norm.includes(fushiNorm(playing.keyword))) {
      setError(`这句里没有「${playing.keyword}」，不算数——再想一句`)
      return
    }
    if (usedNorms().has(norm)) {
      setError('这句本局说过了，换一句')
      return
    }
    setError('')
    const mine: FeihuaLine = { side: 'me', line: raw }
    const next = [...lines, mine]
    setLines(next)
    setBusy(true)
    const usedLines = next.map((l) => l.line)
    const jobId = crypto.randomUUID()
    window.api.fushi
      .feihuaTurn(jobId, playing.keyword, usedLines)
      .then(async (r) => {
        if ('giveUp' in r) {
          setLines([...next, { side: 'ai', line: '（AI 想不出含这句的新句了）' }])
          await endGame('win')
          return
        }
        setLines([...next, { side: 'ai', line: r.line, note: r.note }])
      })
      .catch((e: unknown) => {
        const msg = String((e as Error).message)
        if (msg.includes('LLM_NOT_CONFIGURED')) onNeedConfig()
        else if (msg === '已取消') toast('已取消')
        else setError(`AI 出句失败：${msg}`)
      })
      .finally(() => setBusy(false))
  }

  const openArchive = async (gameId: number, title: string): Promise<void> => {
    const row = history.find((g) => g.id === gameId)
    if (!row) return
    try {
      setPreview({ title, content: await window.api.md.read(row.md_path) })
    } catch {
      setPreview({ title, content: '（留档读取失败）' })
    }
  }

  const fmtDate = (iso: string): string => iso.slice(0, 16).replace('T', ' ')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 每日一令卡 */}
      {daily && !playing && !finished && (
        <div className="card fushi-daily">
          <div className="fushi-daily-kw">
            <span className="fushi-kw-char">{daily.keyword}</span>
            <div className="fushi-daily-meta">
              <div className="fushi-row-title">今日一令</div>
              <div className="module-sub">连胜 {daily.streak} 天{daily.done ? ' · 今日已打卡' : ''}</div>
            </div>
          </div>
          {daily.done ? (
            <button
              className="btn"
              disabled={daily.todayGameId == null}
              onClick={() => daily.todayGameId != null && void openArchive(daily.todayGameId, `飞花令 ·「${daily.keyword}」`)}
            >
              <span className="material-symbols-outlined">history_edu</span>
              回看今日对局
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => startGame(daily.keyword, true)}>
              开始今日飞花令
            </button>
          )}
        </div>
      )}

      {/* 对局视图 */}
      {playing && (
        <FeihuaGame
          keyword={playing.keyword}
          daily={playing.daily}
          lines={lines}
          busy={busy}
          error={error}
          finished={finished}
          onSubmit={submit}
          onGiveUp={() => setGiveUpOpen(true)}
          onReviewArchive={(gid) => void openArchive(gid, `飞花令 ·「${playing.keyword}」`)}
          onExit={() => {
            setFinished(null)
            setPlaying(null)
          }}
        />
      )}

      {/* 自由练入口 */}
      {!playing && (
        <div>
          <button className="btn" onClick={() => setFreeOpen((v) => !v)}>
            <span className="material-symbols-outlined">{freeOpen ? 'expand_less' : 'expand_more'}</span>
            自由练（不计打卡）
          </button>
          {freeOpen && (
            <div className="fushi-free-row">
              {FEIHUA_KEYWORDS.map((k) => (
                <button key={k} className="recycle-tab fushi-free-kw" onClick={() => startGame(k, false)}>
                  {k}
                </button>
              ))}
              <button
                className="recycle-tab fushi-free-kw"
                title="随机关键字"
                onClick={() => startGame(FEIHUA_KEYWORDS[Math.floor(Math.random() * FEIHUA_KEYWORDS.length)], false)}
              >
                <span className="material-symbols-outlined">shuffle</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* 历史对局列表 */}
      <div className="zone-body">
        {history.length === 0 && (
          <div className="empty-state">
            <span className="material-symbols-outlined">local_florist</span>
            还没有对局记录——先来一局飞花令
          </div>
        )}
        {history.map((g) => (
          <div className="row-item" key={g.id} onClick={() => void openArchive(g.id, `飞花令 ·「${g.topic}」`)}>
            <span className={`fushi-verdict ${g.result === 'win' ? 'win' : 'lose'}`}>
              {g.result === 'win' ? '胜' : '负'}
            </span>
            <div className="row-main">
              <div className="row-title">「{g.topic}」</div>
              <div className="row-sub">
                {g.daily ? '每日一令' : '自由练'} · {g.rounds} 句 · {fmtDate(g.created_at)}
              </div>
            </div>
            <div className="row-actions" onClick={(e) => e.stopPropagation()}>
              <button className="icon-btn" title="删除（入回收站）" onClick={() => setDelQ(g)}>
                <span className="material-symbols-outlined">delete</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={giveUpOpen}
        title="认负"
        confirmText="认负"
        onConfirm={() => {
          setGiveUpOpen(false)
          void endGame('lose')
        }}
        onCancel={() => setGiveUpOpen(false)}
      >
        确定认负？本局将判负并留档{playing?.daily ? '，今日打卡记为未胜' : ''}。
      </ConfirmDialog>
      <ConfirmDialog
        open={delQ != null}
        title="删除对局记录"
        danger
        confirmText="删除"
        onConfirm={() => {
          if (delQ)
            void window.api.fushi.gameDelete(delQ.id).then(() => {
              void load()
              toast('已移入回收站')
            })
          setDelQ(null)
        }}
        onCancel={() => setDelQ(null)}
      >
        确定删除「{delQ?.topic}」这局记录？将移入回收站。
      </ConfirmDialog>
      {preview && (
        <MdDialog open title={preview.title} content={preview.content} readOnly onClose={() => setPreview(null)} />
      )}
    </div>
  )
}
