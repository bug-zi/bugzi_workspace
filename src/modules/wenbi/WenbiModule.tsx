// 文笔坊模块（文笔坊 specs §0）：双板块——浮生记 / 写作台（默认浮生记，选择不持久化）
import { useState } from 'react'
import JournalPanel from './JournalPanel'
import WritingPanel from './WritingPanel'

export default function WenbiModule() {
  const [board, setBoard] = useState<'journal' | 'writing'>('journal')
  return (
    <div className="module-page" style={{ maxWidth: 1200 }}>
      <div className="module-header">
        <span className="material-symbols-outlined">history_edu</span>
        <span className="module-title">文笔坊</span>
        <span className="module-sub">浮生记 · 写作台</span>
      </div>
      <div className="recycle-tabs">
        <button
          className={`recycle-tab${board === 'journal' ? ' active' : ''}`}
          onClick={() => setBoard('journal')}
        >
          浮生记
        </button>
        <button
          className={`recycle-tab${board === 'writing' ? ' active' : ''}`}
          onClick={() => setBoard('writing')}
        >
          写作台
        </button>
      </div>
      <div
        className={board === 'journal' ? 'module-live' : 'module-live module-hidden'}
        aria-hidden={board !== 'journal'}
      >
        <JournalPanel active={board === 'journal'} />
      </div>
      <div
        className={board === 'writing' ? 'module-live' : 'module-live module-hidden'}
        aria-hidden={board !== 'writing'}
      >
        <WritingPanel active={board === 'writing'} />
      </div>
    </div>
  )
}
