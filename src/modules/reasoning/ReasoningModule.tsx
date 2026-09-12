// 推理角模块（推理角 specs §2）：双板块——海龟汤 / 思维墙（默认海龟汤，选择不持久化）。
// 板块容器照 App 层 keep-alive 模式：仅隐藏不卸载——切板块不打断生成中的任务（出汤/出题）。
import { useState } from 'react'
import TurtlePanel from './TurtlePanel'
import WallPanel from './WallPanel'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { useModuleNavigate } from '../../hooks/useModuleNavigate'

export default function ReasoningModule() {
  const [board, setBoard] = useState<'turtle' | 'wall'>('turtle')
  // v1.3 题库预生成：进入推理角模块触发补充泵（存量达标即 no-op；覆盖「LLM 事后才配置好」场景）
  useModuleActivated('reasoning', () => void window.api.reasoning.stockCheck())
  // 总导览深链（260912）：切到思维墙（每日一题在板块顶部，无子页签）
  useModuleNavigate('reasoning', (target) => {
    if (target === 'daily') setBoard('wall')
  })
  return (
    <div className="module-page">
      <div className="module-header">
        <span className="material-symbols-outlined">psychology</span>
        <span className="module-title">推理角</span>
        <span className="module-sub">把 AI 当陪练的推理健身房</span>
      </div>

      <div className="recycle-tabs">
        <button
          className={`recycle-tab${board === 'turtle' ? ' active' : ''}`}
          onClick={() => setBoard('turtle')}
        >
          海龟汤
        </button>
        <button
          className={`recycle-tab${board === 'wall' ? ' active' : ''}`}
          onClick={() => setBoard('wall')}
        >
          思维墙
        </button>
      </div>

      {/* 双板块 keep-alive（照 App.tsx 模块容器模式）：常驻挂载 + display 隐藏。
          WallPanel 传 active 惰性触发出题——常驻不等于提前进入思维墙，「打开现出」
          仍以真正进入板块为准（specs §2）。 */}
      <div
        className={board === 'turtle' ? 'module-live' : 'module-live module-hidden'}
        aria-hidden={board !== 'turtle'}
      >
        <TurtlePanel />
      </div>
      <div
        className={board === 'wall' ? 'module-live' : 'module-live module-hidden'}
        aria-hidden={board !== 'wall'}
      >
        <WallPanel active={board === 'wall'} />
      </div>
    </div>
  )
}
