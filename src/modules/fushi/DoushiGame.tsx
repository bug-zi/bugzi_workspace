// 斗诗对局视图（designs-specs §2.3）：题面卡 + 我方写作框（无 Copilot）→ 提交后 AI 作品 +
// 四维评分条 + 总评 + 胜负 + 存入诗集。
import type { DoushiSubmitResult, FushiGenre } from '../../shared/types'
import { GENRE_ZH } from '../../shared/types'

interface Props {
  topic: string
  genre: FushiGenre
  busy: boolean
  myPoem: string
  onMyPoem: (v: string) => void
  onSubmit: () => void
  result: DoushiSubmitResult | null
  saved: boolean
  onSaveToPoems: () => void
  onExit: () => void
}

const SCORE_ROWS: { key: keyof DoushiSubmitResult['scores']; label: string }[] = [
  { key: 'cut', label: '切题' },
  { key: 'meter', label: '格律' },
  { key: 'imagery', label: '意象' },
  { key: 'mood', label: '意境' }
]

export default function DoushiGame(props: Props) {
  const { topic, genre, busy, myPoem, result } = props
  return (
    <div className="card fushi-game-card">
      <div className="fushi-result-head">
        <span className="fushi-kw-pill">同题斗诗 · {topic}</span>
        <span className="module-sub">{GENRE_ZH[genre]}</span>
      </div>

      <div className="fushi-duoshi-grid">
        {/* 我方写作框 */}
        <div className="fushi-duoshi-col">
          <div className="module-sub fushi-col-label">我的诗</div>
          {result ? (
            <div className="fushi-poem-view">{myPoem}</div>
          ) : (
            <textarea
              className="field fushi-poem-input"
              rows={8}
              placeholder={`以「${topic}」为题，按${GENRE_ZH[genre]}写一首…（斗诗现场，不带 AI 协笔）`}
              value={myPoem}
              onChange={(e) => props.onMyPoem(e.target.value)}
              disabled={busy}
            />
          )}
        </div>
        {/* AI 作品区 */}
        <div className="fushi-duoshi-col">
          <div className="module-sub fushi-col-label">AI 的诗（我提交后亮出）</div>
          {result ? (
            <div className="fushi-poem-view">{result.aiPoem}</div>
          ) : (
            <div className="fushi-poem-view fushi-poem-wait">
              {busy ? 'AI 正在酝酿…（提交后亮出它的诗）' : '虚位以待'}
            </div>
          )}
        </div>
      </div>

      {/* 点评区 */}
      {result && (
        <div className="fushi-judge">
          <div className="fushi-score-rows">
            {SCORE_ROWS.map((r) => (
              <div className="fushi-score-row" key={r.key}>
                <span className="module-sub fushi-score-label">{r.label}</span>
                <div className="fushi-score-bar">
                  <div className="fushi-score-fill" style={{ width: `${result.scores[r.key] * 10}%` }} />
                </div>
                <span className="module-sub fushi-score-num">{result.scores[r.key]}/10</span>
              </div>
            ))}
          </div>
          <div className="fushi-comment">{result.totalComment}</div>
          <div className="fushi-result-head">
            <span
              className={`fushi-verdict ${result.verdict === 'win' ? 'win' : result.verdict === 'lose' ? 'lose' : 'draw'}`}
            >
              {result.verdict === 'win' ? '我胜' : result.verdict === 'lose' ? 'AI 胜' : '平局'}
            </span>
          </div>
        </div>
      )}

      <div className="fushi-game-actions">
        {!result && (
          <button className="btn btn-primary" disabled={busy || !myPoem.trim()} onClick={props.onSubmit}>
            {busy ? '提交中…' : '提交亮诗'}
          </button>
        )}
        {result && !props.saved && (
          <button className="btn" onClick={props.onSaveToPoems}>
            <span className="material-symbols-outlined">collections_bookmark</span>
            存入诗集
          </button>
        )}
        {result && props.saved && <span className="module-sub" style={{ alignSelf: 'center' }}>已入诗集</span>}
        <button className="btn btn-primary" onClick={props.onExit}>
          {result ? '返回' : '弃局返回'}
        </button>
      </div>
    </div>
  )
}
