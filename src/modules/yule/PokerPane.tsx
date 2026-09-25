// 德扑板块（娱乐城 specs §2）：大厅（开局/续局/记录）+ 牌桌（SNG 4 人局，本地引擎推进）
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PokerGameView } from '../../renderer/api'
import * as engine from './poker/engine'
import type { PokerState, PokerAction } from './poker/engine'
import MdDialog from '../../components/MdDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import GoConfigDialog from '../../components/GoConfigDialog'
import HelpDialog from './HelpDialog'
import { POKER_HELP_MD } from './help'
import { useToast } from '../../components/Toast'

const RANK_ZH = ['', '冠军', '亚军', '季军', '第四名']

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  return iso.slice(0, 10)
}

/** 旧版本快照缺新字段（lastAction/actionLog/notice），恢复时补默认值 */
function normalizeState(raw: string): PokerState {
  const st = JSON.parse(raw) as PokerState
  st.actionLog ??= []
  st.notice ??= null
  for (const p of st.players) p.lastAction ??= null
  return st
}

export default function PokerPane({ onWalletChanged }: { onWalletChanged: () => void }) {
  const { toast } = useToast()
  const [gameId, setGameId] = useState<number | null>(null)
  const [st, setSt] = useState<PokerState | null>(null)
  const [finished, setFinished] = useState<{ rank: number; prize: number } | null>(null)
  const [records, setRecords] = useState<PokerGameView[]>([])
  const [resumeRow, setResumeRow] = useState<PokerGameView | null>(null)
  const [raiseTo, setRaiseTo] = useState(0)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [recordDoc, setRecordDoc] = useState<{ title: string; subtitle: string; path: string } | null>(null)
  const [removeTarget, setRemoveTarget] = useState<PokerGameView | null>(null)
  const [abandonOpen, setAbandonOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [goConfig, setGoConfig] = useState(false)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const gameIdRef = useRef<number | null>(null)
  const saveTimer = useRef<number | null>(null)
  const finishedRef = useRef(false)

  const loadRecords = useCallback(async () => {
    try {
      setRecords(await window.api.yule.pokerList())
    } catch (e) {
      toast(`记录加载失败：${(e as Error).message}`)
    }
  }, [toast])

  // 进板块：有进行中对局则恢复（specs 中断续玩）
  useEffect(() => {
    void (async () => {
      try {
        const playing = await window.api.yule.pokerState()
        if (playing?.state) {
          const restored = normalizeState(playing.state)
          gameIdRef.current = playing.id
          finishedRef.current = false
          setGameId(playing.id)
          setSt(restored)
          setFinished(null)
        } else if (playing) {
          setResumeRow(playing) // 有局无快照（异常残留）——大厅提示弃赛入口
        }
      } catch {
        /* 无局 */
      }
      void loadRecords()
    })()
  }, [loadRecords])

  const persist = useCallback((s: PokerState, immediate = false): void => {
    const id = gameIdRef.current
    if (!id) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    const run = (): void => {
      void window.api.yule.pokerSaveState(id, JSON.stringify(s), s.handsLog.length, JSON.stringify(s.handsLog))
    }
    if (immediate) run()
    else saveTimer.current = window.setTimeout(run, 1200)
  }, [])

  // 引擎推进节拍：ai 思考 800ms，settle 快速收尾（specs §2）
  useEffect(() => {
    if (!st || (st.awaiting !== 'ai' && st.awaiting !== 'settle')) return
    const t = window.setTimeout(() => {
      const next = engine.advance(st)
      setSt(next)
      if (next.awaiting === 'handover') persist(next, true)
      else persist(next)
    }, st.awaiting === 'ai' ? engine.AI_THINK_MS : 160)
    return () => window.clearTimeout(t)
  }, [st, persist])

  // 终局结算（一次）：发奖入钱包 + 列表刷新
  useEffect(() => {
    if (!st || st.awaiting !== 'gameover' || finishedRef.current || gameId == null) return
    finishedRef.current = true
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    void (async () => {
      try {
        const row = await window.api.yule.pokerFinish(gameId, st.gameRank ?? 4, JSON.stringify(st.handsLog), engine.elapsedMs(st))
        setFinished({ rank: st.gameRank ?? 4, prize: row.prize })
        onWalletChanged()
        void loadRecords()
      } catch (e) {
        toast(`结算失败：${(e as Error).message}`)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.awaiting])

  const start = (): void => {
    const fresh = engine.createInitialState()
    void (async () => {
      try {
        const row = await window.api.yule.pokerStart(JSON.stringify(fresh))
        gameIdRef.current = row.id
        finishedRef.current = false
        setGameId(row.id)
        setSt(fresh)
        setFinished(null)
        setResumeRow(null)
        persist(fresh, true)
        onWalletChanged()
      } catch (e) {
        toast((e as Error).message)
      }
    })()
  }

  const act = (a: PokerAction): void => {
    if (!st || st.awaiting !== 'human') return
    if (a.type === 'raise') {
      // 滑条值可能是上一手/上一街遗留或初始 0，提交前钳制进本街合法区间
      const legal = engine.legalActions(st)
      a = { type: 'raise', amount: Math.min(Math.max(a.amount ?? legal.minRaiseTo, legal.minRaiseTo), legal.maxRaiseTo) }
    }
    const next = engine.humanAct(st, a)
    setSt(next)
    persist(next, next.awaiting === 'handover' || next.awaiting === 'gameover')
  }

  const nextHand = (): void => {
    if (!st) return
    const next = engine.continueHand(st)
    setSt(next)
    persist(next, true)
  }

  const doAbandon = async (): Promise<void> => {
    if (gameId == null) return
    try {
      await window.api.yule.pokerAbandon(gameId)
      toast('已弃赛（记第 4 名）')
      gameIdRef.current = null
      setGameId(null)
      setSt(null)
      onWalletChanged()
      void loadRecords()
    } catch (e) {
      toast(`弃赛失败：${(e as Error).message}`)
    } finally {
      setAbandonOpen(false)
    }
  }

  const backToLobby = (): void => {
    setSt(null)
    setFinished(null)
    setResumeRow(null)
    void loadRecords()
  }

  const resume = (): void => {
    if (!resumeRow?.state) return
    gameIdRef.current = resumeRow.id
    finishedRef.current = false
    setGameId(resumeRow.id)
    setSt(normalizeState(resumeRow.state))
    setResumeRow(null)
  }

  const doReview = async (row: PokerGameView): Promise<void> => {
    if (reviewBusy) return
    if (row.review_md_path) {
      setRecordDoc({ title: '德扑 AI 复盘', subtitle: `${fmtDate(row.created_at)} · ${RANK_ZH[row.my_rank ?? 4]}`, path: row.review_md_path })
      return
    }
    const jobId = `poker-review-${row.id}-${Date.now()}`
    setReviewBusy(true)
    setFailMsg(null)
    try {
      const { mdPath } = await window.api.yule.pokerReview(jobId, row.id)
      toast('复盘已生成')
      void loadRecords()
      setRecordDoc({ title: '德扑 AI 复盘', subtitle: `${fmtDate(row.created_at)} · ${RANK_ZH[row.my_rank ?? 4]}`, path: mdPath })
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
      else setFailMsg(msg)
    } finally {
      setReviewBusy(false)
    }
  }

  const doRemove = async (): Promise<void> => {
    if (!removeTarget) return
    try {
      await window.api.yule.pokerRemove(removeTarget.id)
      toast('已移入回收站')
      void loadRecords()
    } catch (e) {
      toast(`删除失败：${(e as Error).message}`)
    } finally {
      setRemoveTarget(null)
    }
  }

  // ---------- 牌桌视图 ----------
  if (st && gameId != null) {
    const hero = st.players[0]
    const pot = st.players.reduce((n, p) => n + p.bet, 0)
    const heroTurn = st.awaiting === 'human'
    const actingId = st.toAct >= 0 ? st.players[st.toAct].id : -1
    const legal = heroTurn ? engine.legalActions(st) : null
    const showdownReveal = st.handOver != null && st.handOver.rows.length > 0

    return (
      <div className="yule-pane">
        <div className="yule-poker-topbar">
          <span className="yule-poker-meta">
            第 {st.handNo} 手 · {engine.STREET_ZH[st.street]} · 盲注 {st.sb}/{st.bb}
          </span>
          <span className="yule-poker-meta">底池 {pot}</span>
          <span className="yule-action-spacer" />
          <button className="yule-mini-btn" onClick={() => setHelpOpen(true)}>
            玩法
          </button>
          <button className="yule-mini-btn danger" onClick={() => setAbandonOpen(true)}>
            弃赛
          </button>
        </div>

        <div className="yule-poker-table">
          <div className="yule-poker-seats-top">
            {st.players.slice(1).map((p) => (
              <div key={p.id} className={`yule-seat${p.folded ? ' folded' : ''}${p.out ? ' out' : ''}${p.id === actingId ? ' acting' : ''}`}>
                <div className="yule-seat-head">
                  <span className="yule-seat-name">{p.name}</span>
                  {st.dealerId === p.id && <span className="yule-dealer-btn">D</span>}
                  {p.allin && <span className="yule-allin-badge">全下</span>}
                </div>
                <div className="yule-seat-stack">
                  {p.out ? '出局' : `${p.stack}`}
                  {!p.out && p.bet > 0 ? ` · 注 ${p.bet}` : ''}
                </div>
                {p.lastAction && !p.out ? <div className="yule-seat-act">{p.lastAction}</div> : null}
                <div className="yule-seat-cards">
                  {showdownReveal && !p.folded && !p.out
                    ? p.cards.map((c, i) => (
                        <span key={i} className={`yule-pcard red-${c.s === 1 || c.s === 2}`}>
                          {engine.cardText(c)}
                        </span>
                      ))
                    : !p.out && p.cards.length > 0
                      ? (
                        <>
                          <span className="yule-pcard back">✦</span>
                          <span className="yule-pcard back">✦</span>
                        </>
                      )
                      : null}
                </div>
              </div>
            ))}
          </div>

          <div className="yule-poker-board">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className={`yule-board-slot${st.board[i] ? ' filled' : ''}`}>
                {st.board[i] ? (
                  <span className={`yule-pcard red-${st.board[i]!.s === 1 || st.board[i]!.s === 2}`}>{engine.cardText(st.board[i]!)}</span>
                ) : (
                  ''
                )}
              </span>
            ))}
          </div>

          {st.notice && st.awaiting !== 'gameover' && <p className="yule-poker-notice">{st.notice}</p>}

          <div className="yule-poker-hero">
            <div className={`yule-seat${hero.folded ? ' folded' : ''}${hero.id === actingId ? ' acting' : ''}`}>
              <div className="yule-seat-head">
                <span className="yule-seat-name">我</span>
                {st.dealerId === hero.id && <span className="yule-dealer-btn">D</span>}
                {hero.allin && <span className="yule-allin-badge">全下</span>}
              </div>
              <div className="yule-seat-stack">
                筹码 {hero.stack}
                {hero.bet > 0 ? ` · 注 ${hero.bet}` : ''}
              </div>
              {hero.lastAction && <div className="yule-seat-act">{hero.lastAction}</div>}
              <div className="yule-hero-cards">
                {hero.cards.map((c, i) => (
                  <span key={i} className={`yule-pcard big red-${c.s === 1 || c.s === 2}`}>
                    {engine.cardText(c)}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {st.actionLog.length > 0 && (
            <div className="yule-poker-feed">
              {[...st.actionLog].reverse().map((line, i) => (
                <div key={i} className={`yule-feed-line${line.startsWith('——') ? ' mark' : ''}`}>
                  {line}
                </div>
              ))}
            </div>
          )}

          {st.handOver && st.awaiting === 'handover' && (
            <div className="yule-handover">
              <p>{st.handOver.text}</p>
              {st.handOver.rows.length > 0 && (
                <ul>
                  {st.handOver.rows.map((r) => (
                    <li key={r.id}>
                      {r.name}：{r.desc} +{r.win}
                    </li>
                  ))}
                </ul>
              )}
              <button className="yule-btn primary" onClick={nextHand}>
                下一手
              </button>
            </div>
          )}

          {st.awaiting === 'gameover' && (
            <div className="yule-handover gameover">
              <h3>{finished ? RANK_ZH[finished.rank] : '局终'}</h3>
              <p>
                名次第 {st.gameRank} · 奖励 {finished?.prize ?? 0} 筹码已入钱包
              </p>
              <div className="yule-action-row">
                <button className="yule-btn" onClick={backToLobby}>
                  返回大厅
                </button>
                {finished && (
                  <button
                    className="yule-btn primary"
                    disabled={reviewBusy}
                    onClick={() =>
                      void (async () => {
                        if (reviewBusy) return
                        const jobId = `poker-review-${gameId}-${Date.now()}`
                        setReviewBusy(true)
                        try {
                          const { mdPath } = await window.api.yule.pokerReview(jobId, gameId!)
                          toast('复盘已生成')
                          setRecordDoc({ title: '德扑 AI 复盘', subtitle: RANK_ZH[finished.rank], path: mdPath })
                          void loadRecords()
                        } catch (e) {
                          const msg = String((e as Error).message)
                          if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)
                          else setFailMsg(msg)
                        } finally {
                          setReviewBusy(false)
                        }
                      })()
                    }
                  >
                    {reviewBusy ? '复盘生成中…' : 'AI 复盘'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {heroTurn && legal && (
          <div className="yule-poker-actions">
            <button className="yule-btn danger" onClick={() => act({ type: 'fold' })}>
              弃牌
            </button>
            {legal.canCheck ? (
              <button className="yule-btn" onClick={() => act({ type: 'check' })}>
                过牌
              </button>
            ) : (
              <button className="yule-btn" onClick={() => act({ type: 'call' })}>
                跟注 {legal.callAmount}
              </button>
            )}
            <div className="yule-raise-box">
              <div className="yule-raise-quick">
                <button
                  className="yule-mini-btn"
                  onClick={() => setRaiseTo(Math.min(legal.maxRaiseTo, Math.round((pot + legal.callAmount) * 0.5) + st.currentBet))}
                >
                  ½池
                </button>
                <button className="yule-mini-btn" onClick={() => setRaiseTo(Math.min(legal.maxRaiseTo, pot + st.currentBet + legal.callAmount))}>
                  满池
                </button>
                <button className="yule-mini-btn" onClick={() => setRaiseTo(legal.maxRaiseTo)}>
                  全下
                </button>
                <span className="yule-raise-val">到 {raiseTo}</span>
              </div>
              <input
                type="range"
                min={legal.minRaiseTo}
                max={legal.maxRaiseTo}
                step={10}
                value={Math.min(Math.max(raiseTo, legal.minRaiseTo), legal.maxRaiseTo)}
                onChange={(e) => setRaiseTo(Number(e.target.value))}
              />
              <button className="yule-btn primary" onClick={() => act({ type: 'raise', amount: raiseTo })}>
                加注
              </button>
            </div>
          </div>
        )}
        {!heroTurn && st.awaiting === 'ai' && <p className="yule-poker-wait">等待 {st.players[st.toAct]?.name ?? '对手'} 行动…</p>}
        {heroTurn && (
          <p className="yule-poker-wait turn">
            轮到你行动 · 底池 {pot} · 需跟注 {legal?.callAmount ?? 0}
          </p>
        )}
        {failMsg && <p className="yule-fail">{failMsg}</p>}

        <ConfirmDialog open={abandonOpen} title="弃赛确认" confirmText="弃赛" danger onConfirm={() => void doAbandon()} onCancel={() => setAbandonOpen(false)}>
          弃赛将按第 4 名结算（无奖励，买入不退）。确定放弃本局？
        </ConfirmDialog>
        <MdDialog key={recordDoc?.path ?? 'none'} open={recordDoc != null} title={recordDoc?.title ?? ''} subtitle={recordDoc?.subtitle} filePath={recordDoc?.path ?? ''} onClose={() => setRecordDoc(null)} />
        <GoConfigDialog open={goConfig} kind="llm" onGoConfig={() => setGoConfig(false)} onCancel={() => setGoConfig(false)} />
        <HelpDialog open={helpOpen} md={POKER_HELP_MD} onClose={() => setHelpOpen(false)} />
      </div>
    )
  }

  // ---------- 大厅视图 ----------
  return (
    <div className="yule-pane">
      <div className="yule-poker-lobby">
        <div className="yule-lobby-card">
          <div className="yule-lobby-head">
            <h4 className="yule-section-title">SNG 锦标赛 · 4 人桌</h4>
            <button className="yule-mini-btn" onClick={() => setHelpOpen(true)}>
              玩法
            </button>
          </div>
          <ul className="yule-lobby-info">
            <li>买入 1,000（开局从钱包扣除）· 每人起始 1,000 筹码</li>
            <li>盲注 10/20 起，每 8 手翻倍</li>
            <li>奖励：冠军 2,000 / 亚军 1,200 / 季军 800 / 第四 0</li>
            <li>三位 AI 对手：老K（紧凶）、半仙（松凶）、铁跟（跟注站）</li>
          </ul>
          {resumeRow && (
            <div className="yule-resume-row">
              <span>有一局进行中对局</span>
              <button className="yule-btn primary" onClick={resume}>
                回到牌桌
              </button>
              <button className="yule-mini-btn danger" onClick={() => setAbandonOpen(true)}>
                弃赛
              </button>
            </div>
          )}
          <button className="yule-btn primary big" onClick={start}>
            开局（扣 1,000）
          </button>
        </div>

        <div className="yule-records">
          <h4 className="yule-section-title">对局记录（{records.length}）</h4>
          {records.length === 0 && <p className="yule-empty">还没有打完的局</p>}
          {records.map((r) => (
            <div key={r.id} className="yule-record-row">
              <span className="yule-record-date">{fmtDate(r.created_at)}</span>
              <span className="yule-record-main">
                {RANK_ZH[r.my_rank ?? 4]}
                <em className="yule-record-sub">
                  {r.prize > 0 ? `奖励 +${r.prize}` : '无奖励'} · {r.hands_count} 手{r.status === 'abandoned' ? ' · 弃赛' : ''}
                  {r.duration_ms != null ? ` · ${fmtDuration(r.duration_ms)}` : ''}
                </em>
              </span>
              <button className="yule-mini-btn" disabled={reviewBusy} onClick={() => void doReview(r)}>
                {r.review_md_path ? '看复盘' : 'AI 复盘'}
              </button>
              <button className="yule-mini-btn danger" onClick={() => setRemoveTarget(r)}>
                删除
              </button>
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog open={abandonOpen} title="弃赛确认" confirmText="弃赛" danger onConfirm={() => void doAbandon()} onCancel={() => setAbandonOpen(false)}>
        弃赛将按第 4 名结算（无奖励，买入不退）。确定？
      </ConfirmDialog>
      <MdDialog key={recordDoc?.path ?? 'none'} open={recordDoc != null} title={recordDoc?.title ?? ''} subtitle={recordDoc?.subtitle} filePath={recordDoc?.path ?? ''} onClose={() => setRecordDoc(null)} />
      <GoConfigDialog open={goConfig} kind="llm" onGoConfig={() => setGoConfig(false)} onCancel={() => setGoConfig(false)} />
      <HelpDialog open={helpOpen} md={POKER_HELP_MD} onClose={() => setHelpOpen(false)} />
    </div>
  )
}
