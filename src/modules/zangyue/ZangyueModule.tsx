// 图书馆（260916 由藏阅阁更名）：书架单视图。260924 收藏页签拆出为独立常驻模块「收藏夹」，
// 页签条随之删除；进阅读器（early-return）时经 onReadingChange 隐藏头部，阅读器满栏。
import { useCallback, useState } from 'react'
import BookshelfModule from '../bookshelf/BookshelfModule'
import './zangyue.css'

export default function ZangyueModule() {
  const [readerActive, setReaderActive] = useState(false)
  const onReadingChange = useCallback((v: boolean) => setReaderActive(v), [])
  return (
    <div className="module-page zy-page" style={{ maxWidth: 1200 }}>
      {!readerActive && (
        <div className="module-header">
          <span className="material-symbols-outlined">menu_book</span>
          <span className="module-title">图书馆</span>
          <span className="module-sub">书架</span>
        </div>
      )}
      <BookshelfModule onReadingChange={onReadingChange} />
    </div>
  )
}
