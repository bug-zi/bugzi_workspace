// 赋诗苑（2026-09-25-赋诗苑 design.md，designs-specs §2.1）：三页签「飞花令｜斗诗台｜诗集」。
// 面板常驻挂载仅显隐切换（对局态存面板 state，切页签不丢进行中对局）。
import { useState } from 'react'
import FeihuaPanel from './FeihuaPanel'
import DoushiPanel from './DoushiPanel'
import PoemsPanel from './PoemsPanel'
import GoConfigDialog from '../../components/GoConfigDialog'

type FushiTab = 'feihua' | 'doushi' | 'poems'

export default function FushiModule() {
  const [tab, setTab] = useState<FushiTab>('feihua')
  const [goConfig, setGoConfig] = useState<{ open: boolean; kind: 'llm' }>({ open: false, kind: 'llm' })
  const onNeedConfig = (): void => setGoConfig({ open: true, kind: 'llm' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="recycle-tabs">
        <button className={`recycle-tab${tab === 'feihua' ? ' active' : ''}`} onClick={() => setTab('feihua')}>
          飞花令
        </button>
        <button className={`recycle-tab${tab === 'doushi' ? ' active' : ''}`} onClick={() => setTab('doushi')}>
          斗诗台
        </button>
        <button className={`recycle-tab${tab === 'poems' ? ' active' : ''}`} onClick={() => setTab('poems')}>
          诗集
        </button>
      </div>
      <div style={{ display: tab === 'feihua' ? undefined : 'none' }}>
        <FeihuaPanel onNeedConfig={onNeedConfig} />
      </div>
      <div style={{ display: tab === 'doushi' ? undefined : 'none' }}>
        <DoushiPanel onNeedConfig={onNeedConfig} />
      </div>
      <div style={{ display: tab === 'poems' ? undefined : 'none' }}>
        <PoemsPanel onNeedConfig={onNeedConfig} />
      </div>
      <GoConfigDialog
        open={goConfig.open}
        kind={goConfig.kind}
        onGoConfig={() => setGoConfig({ open: false, kind: goConfig.kind })}
        onCancel={() => setGoConfig({ open: false, kind: goConfig.kind })}
      />
    </div>
  )
}
