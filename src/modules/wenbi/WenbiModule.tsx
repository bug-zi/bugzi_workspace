// 文笔坊模块（格言库并入——优化建议区第36轮：三 tab「格言库｜写作台｜浮生记」，默认格言库）
import { useState } from 'react'
import type { AiChannel } from '../../shared/types'
import MottosModule from '../mottos/MottosModule'
import JournalPanel from './JournalPanel'
import WritingPanel from './WritingPanel'

export interface WenbiModuleProps {
  /** 透传 App.openAiWith 给格言面板（AI 解读显式带 channel: 'motto'） */
  onOpenAi: (prefill?: string, opts?: { auto?: boolean; channel?: AiChannel }) => void
  bumpAi: () => void
}

export default function WenbiModule(props: WenbiModuleProps) {
  // 默认格言库（承袭其曾是启动首页的地位）；module-hidden 保活，tab 状态会话内保留、重启回默认
  const [board, setBoard] = useState<'mottos' | 'writing' | 'journal'>('mottos')
  return (
    <div className="module-page" style={{ maxWidth: 1200 }}>
      <div className="module-header">
        <span className="material-symbols-outlined">history_edu</span>
        <span className="module-title">文笔坊</span>
        <span className="module-sub">格言库 · 写作台 · 浮生记</span>
      </div>
      <div className="recycle-tabs">
        <button
          className={`recycle-tab${board === 'mottos' ? ' active' : ''}`}
          onClick={() => setBoard('mottos')}
        >
          格言库
        </button>
        <button
          className={`recycle-tab${board === 'writing' ? ' active' : ''}`}
          onClick={() => setBoard('writing')}
        >
          写作台
        </button>
        <button
          className={`recycle-tab${board === 'journal' ? ' active' : ''}`}
          onClick={() => setBoard('journal')}
        >
          浮生记
        </button>
      </div>
      <div
        className={board === 'mottos' ? 'module-live' : 'module-live module-hidden'}
        aria-hidden={board !== 'mottos'}
      >
        <MottosModule active={board === 'mottos'} onOpenAi={props.onOpenAi} bumpAi={props.bumpAi} />
      </div>
      <div
        className={board === 'writing' ? 'module-live' : 'module-live module-hidden'}
        aria-hidden={board !== 'writing'}
      >
        <WritingPanel active={board === 'writing'} />
      </div>
      <div
        className={board === 'journal' ? 'module-live' : 'module-live module-hidden'}
        aria-hidden={board !== 'journal'}
      >
        <JournalPanel active={board === 'journal'} />
      </div>
    </div>
  )
}
