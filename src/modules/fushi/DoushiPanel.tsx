// 斗诗台页签（designs-specs §2.3）：新斗诗（AI 出题）+ 对局 + 历史对局列表。提交即终局。
import { useCallback, useEffect, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import MdDialog from '../../components/MdDialog'
import { useToast } from '../../components/Toast'
import DoushiGame from './DoushiGame'
import type { DoushiSubmitResult, FushiGameRow, FushiGenre } from '../../shared/types'
import { GENRE_ZH } from '../../shared/types'

interface Props {
  onNeedConfig: () => void
}

interface ActiveGame {
  topic: string
  genre: FushiGenre
}

export default function DoushiPanel({ onNeedConfig }: Props) {
  const { toast } = useToast()
  const [history, setHistory] = useState<FushiGameRow[]>([])
  const [creating, setCreating] = useState(false)
  const [game, setGame] = useState<ActiveGame | null>(null)
  const [myPoem, setMyPoem] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DoushiSubmitResult | null>(null)
  const [saved, setSaved] = useState(false)
  const [abandonOpen, setAbandonOpen] = useState(false)
  const [delQ, setDelQ] = useState<FushiGameRow | null>(null)
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setHistory(await window.api.fushi.games('doushi'))
    } catch (e) {
      toast(`加载失败：${(e as Error).message}`)
    }
  }, [toast])
  useEffect(() => {
    void load()
  }, [load])

  const newGame = (): void => {
    if (creating) return
    setCreating(true)
    const jobId = crypto.randomUUID()
    window.api.fushi
      .doushiNew(jobId)
      .then((g) => {
        setGame(g)
        setMyPoem('')
        setResult(null)
        setSaved(false)
      })
      .catch((e: unknown) => {
        const msg = String((e as Error).message)
        if (msg.includes('LLM_NOT_CONFIGURED')) onNeedConfig()
        else if (msg === '已取消') toast('已取消')
        else toast(`出题失败：${msg}`)
      })
      .finally(() => setCreating(false))
  }

  const submit = (): void => {
    if (!game || busy || !myPoem.trim()) return
    setBusy(true)
    const jobId = crypto.randomUUID()
    window.api.fushi
      .doushiSubmit(jobId, game.topic, game.genre, myPoem)
      .then((r) => {
        setResult(r)
        void load()
      })
      .catch((e: unknown) => {
        const msg = String((e as Error).message)
        if (msg.includes('LLM_NOT_CONFIGURED')) onNeedConfig()
        else if (msg === '已取消') toast('已取消')
        else toast(`斗诗失败：${msg}`)
      })
      .finally(() => setBusy(false))
  }

  const saveToPoems = (): void => {
    if (!game || !result || saved) return
    window.api.fushi
      .poemAdd(game.topic, game.genre, myPoem)
      .then(() => setSaved(true))
      .then(() => toast('已入诗集'))
      .catch((e: unknown) => toast(`存入失败：${(e as Error).message}`))
  }

  const openArchive = async (row: FushiGameRow): Promise<void> => {
    try {
      setPreview({ title: `斗诗 · ${row.topic}`, content: await window.api.md.read(row.md_path) })
    } catch {
      setPreview({ title: `斗诗 · ${row.topic}`, content: '（留档读取失败）' })
    }
  }

  const exitGame = (): void => {
    if (game && !result && myPoem.trim()) {
      setAbandonOpen(true)
      return
    }
    setGame(null)
    setResult(null)
    setMyPoem('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {!game && (
        <div>
          <button className="btn btn-primary" disabled={creating} onClick={newGame}>
            <span className={`material-symbols-outlined${creating ? ' spin' : ''}`}>
              {creating ? 'progress_activity' : 'sports_kabaddi'}
            </span>
            {creating ? 'AI 出题中…' : '新斗诗'}
          </button>
        </div>
      )}

      {game && (
        <DoushiGame
          topic={game.topic}
          genre={game.genre}
          busy={busy}
          myPoem={myPoem}
          onMyPoem={setMyPoem}
          onSubmit={submit}
          result={result}
          saved={saved}
          onSaveToPoems={saveToPoems}
          onExit={exitGame}
        />
      )}

      {/* 历史对局列表 */}
      <div className="zone-body">
        {history.length === 0 && (
          <div className="empty-state">
            <span className="material-symbols-outlined">sports_kabaddi</span>
            还没有斗诗记录——点「新斗诗」与 AI 同题较量
          </div>
        )}
        {history.map((g) => (
          <div className="row-item" key={g.id} onClick={() => void openArchive(g)}>
            <span
              className={`fushi-verdict ${g.result === 'win' ? 'win' : g.result === 'lose' ? 'lose' : 'draw'}`}
            >
              {g.result === 'win' ? '胜' : g.result === 'lose' ? '负' : '平'}
            </span>
            <div className="row-main">
              <div className="row-title">{g.topic}</div>
              <div className="row-sub">
                {g.genre ? GENRE_ZH[g.genre] : ''} · {g.created_at.slice(0, 16).replace('T', ' ')}
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
        open={abandonOpen}
        title="弃局"
        confirmText="弃局"
        onConfirm={() => {
          setAbandonOpen(false)
          setGame(null)
          setResult(null)
          setMyPoem('')
        }}
        onCancel={() => setAbandonOpen(false)}
      >
        返回将放弃这首未提交的诗（不留档）。确定离开？
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
