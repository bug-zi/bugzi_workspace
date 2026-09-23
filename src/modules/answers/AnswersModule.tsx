// 答疑店（260924 新模块壳，学习区）：问答｜辩真｜预言家 三页签——面板自万象库/致知己原样搬入，
// AI 频道键不变（问答→wiki / 辩真→verify / 预言家→prophet），右侧边栏会话徽章与历史天然兼容。
// 三面板 keep-alive 显隐（原 WikiModule 同款），切页签不中断生成中的 AI 任务
import { useState } from 'react'
import QaPanel from './QaPanel'
import VerifyPanel from './VerifyPanel'
import ProphetPanel from './ProphetPanel'
import type { AiChannel } from '../../shared/types'

export default function AnswersModule(props: {
  onOpenAi: (prefill?: string, opts?: { auto?: boolean; channel?: AiChannel }) => void
  bumpAi: () => void
  onNavigateToProfile: () => void
}) {
  const [tab, setTab] = useState<'qa' | 'verify' | 'prophet'>('qa')
  return (
    <div className="module-page" style={{ maxWidth: 1200 }}>
      <div className="module-header">
        <span className="material-symbols-outlined">forum</span>
        <span className="module-title">答疑店</span>
        <span className="module-sub">问答 · 辩真 · 预言家</span>
      </div>
      <div className="recycle-tabs">
        <button className={`recycle-tab${tab === 'qa' ? ' active' : ''}`} onClick={() => setTab('qa')}>
          问答
        </button>
        <button
          className={`recycle-tab${tab === 'verify' ? ' active' : ''}`}
          onClick={() => setTab('verify')}
        >
          辩真
        </button>
        <button
          className={`recycle-tab${tab === 'prophet' ? ' active' : ''}`}
          onClick={() => setTab('prophet')}
        >
          预言家
        </button>
      </div>
      <div className={tab === 'qa' ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== 'qa'}>
        <QaPanel onOpenAi={(p) => props.onOpenAi?.(p, { channel: 'wiki' })} />
      </div>
      <div
        className={tab === 'verify' ? 'module-live' : 'module-live module-hidden'}
        aria-hidden={tab !== 'verify'}
      >
        <VerifyPanel onOpenAi={(p) => props.onOpenAi?.(p, { channel: 'verify' })} bumpAi={props.bumpAi} />
      </div>
      <div
        className={tab === 'prophet' ? 'module-live' : 'module-live module-hidden'}
        aria-hidden={tab !== 'prophet'}
      >
        <ProphetPanel
          onOpenAi={props.onOpenAi}
          bumpAi={props.bumpAi}
          onNavigateToProfile={props.onNavigateToProfile}
        />
      </div>
    </div>
  )
}
