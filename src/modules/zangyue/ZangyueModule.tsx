// 藏阅阁（收藏夹 + 藏书架合并壳，260912 新功能开发区）：头部 + 页签「书架｜收藏」+ 双面板保活。
// 两面板常驻挂载、module-live/module-hidden 显隐（同 WenbiModule 合并先例）——阅读计时经
// rect 高度=0 天然暂停；书架进入阅读器（early-return）时经 onReadingChange 上报，壳隐藏
// 头部与页签条，阅读器满栏（与合并前行为一致）。tab 会话内保留、重启回默认书架。
import { useCallback, useState } from 'react'
import BookshelfModule from '../bookshelf/BookshelfModule'
import FavoritesModule from '../favorites/FavoritesModule'
import { useModuleNavigate } from '../../hooks/useModuleNavigate'
import './zangyue.css'

export default function ZangyueModule() {
  const [tab, setTab] = useState<'bookshelf' | 'favorites'>('bookshelf')
  const [readerActive, setReaderActive] = useState(false)
  const onReadingChange = useCallback((v: boolean) => setReaderActive(v), [])
  // 总导览深链（260912）：续读直达——先落书架页签（阅读器打开后页签条本就隐藏，返回时已在书架）
  useModuleNavigate('zangyue', (target) => {
    if (target === 'read') setTab('bookshelf')
  })
  return (
    <div className="module-page zy-page" style={{ maxWidth: 1200 }}>
      {!readerActive && (
        <>
          <div className="module-header">
            <span className="material-symbols-outlined">collections_bookmark</span>
            <span className="module-title">藏阅阁</span>
            <span className="module-sub">书架 · 收藏</span>
          </div>
          <div className="recycle-tabs">
            <button
              className={`recycle-tab${tab === 'bookshelf' ? ' active' : ''}`}
              onClick={() => setTab('bookshelf')}
            >
              书架
            </button>
            <button
              className={`recycle-tab${tab === 'favorites' ? ' active' : ''}`}
              onClick={() => setTab('favorites')}
            >
              收藏
            </button>
          </div>
        </>
      )}
      <div
        className={tab === 'bookshelf' ? 'module-live' : 'module-live module-hidden'}
        aria-hidden={tab !== 'bookshelf'}
      >
        <BookshelfModule onReadingChange={onReadingChange} />
      </div>
      <div
        className={tab === 'favorites' ? 'module-live' : 'module-live module-hidden'}
        aria-hidden={tab !== 'favorites'}
      >
        <FavoritesModule />
      </div>
    </div>
  )
}
