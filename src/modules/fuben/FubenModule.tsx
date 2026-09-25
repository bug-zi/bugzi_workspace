// 副本库模块（docs/project/左侧边栏/生活模块/副本库/designs-specs.md §2，v2.2）：
// 四页签——进行中（默认，读到一半的）｜待读区｜收藏库｜DIY 定制。「每日副本」三选一独占
// 总导览（260925 开发者指令）。板块容器照 App 层 keep-alive 模式：仅隐藏不卸载——切页签不打断进行中的 DIY 生成。
import { useCallback, useState } from 'react'
import ReadingPanel from './ReadingPanel'
import PoolPanel from './PoolPanel'
import DiyPanel from './DiyPanel'
import LibraryPanel from './LibraryPanel'
import CopyReader from './CopyReader'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { useModuleNavigate } from '../../hooks/useModuleNavigate'

export default function FubenModule() {
  const [tab, setTab] = useState<'reading' | 'pool' | 'library' | 'diy'>('reading')
  const [readingId, setReadingId] = useState<number | null>(null)
  // 补库泵渐进刷新信号：copies:stockChanged 时递增，PoolPanel 据此重拉库存
  const [stockVersion, setStockVersion] = useState(0)

  useModuleActivated('fuben', () => void window.api.copy.stockCheck())
  window.api.copy.onStockChanged(() => setStockVersion((v) => v + 1))

  const openReader = useCallback((id: number) => setReadingId(id), [])
  const closeReader = useCallback(() => setReadingId(null), [])

  // 深链：reader（payload.id 直达阅读；总导览「今日副本」块续读/回看用）
  useModuleNavigate('fuben', (_target, payload) => {
    if (typeof payload?.id === 'number') setReadingId(payload.id)
  })

  return (
    <div className={readingId != null ? 'fuben-reader-page' : 'module-page'}>
      {readingId != null ? (
        <CopyReader id={readingId} onBack={closeReader} />
      ) : (
        <>
          <div className="module-header">
            <span className="material-symbols-outlined">collections_bookmark</span>
            <span className="module-title">副本库</span>
            <span className="module-sub">每天抽一段别样人生，或定制一段属于自己的</span>
          </div>

          <div className="recycle-tabs">
            <button className={`recycle-tab${tab === 'pool' ? ' active' : ''}`} onClick={() => setTab('pool')}>
              待读区
            </button>
            <button className={`recycle-tab${tab === 'reading' ? ' active' : ''}`} onClick={() => setTab('reading')}>
              进行中
            </button>
            <button className={`recycle-tab${tab === 'library' ? ' active' : ''}`} onClick={() => setTab('library')}>
              收藏库
            </button>
            <button className={`recycle-tab${tab === 'diy' ? ' active' : ''}`} onClick={() => setTab('diy')}>
              DIY 定制
            </button>
          </div>

          <div className={tab === 'reading' ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== 'reading'}>
            <ReadingPanel onRead={openReader} />
          </div>
          <div className={tab === 'pool' ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== 'pool'}>
            <PoolPanel onRead={openReader} stockVersion={stockVersion} />
          </div>
          <div className={tab === 'library' ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== 'library'}>
            <LibraryPanel onRead={openReader} />
          </div>
          <div className={tab === 'diy' ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== 'diy'}>
            <DiyPanel onRead={openReader} />
          </div>
        </>
      )}
    </div>
  )
}
