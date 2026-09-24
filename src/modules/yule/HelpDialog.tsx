// 玩法说明弹窗（娱乐城三馆共用）：遮罩 + 主题卡 + MdView 渲染静态玩法文案
import { useEffect } from 'react'
import MdView from '../../components/MdView'

export default function HelpDialog({ open, md, onClose }: { open: boolean; md: string; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="yule-help-mask" onClick={onClose}>
      <div className="yule-help-card" onClick={(e) => e.stopPropagation()}>
        <div className="yule-help-head">
          <span className="material-symbols-outlined">menu_book</span>
          <span>玩法说明</span>
          <button className="yule-mini-btn" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="yule-help-body">
          <MdView md={md} />
        </div>
      </div>
    </div>
  )
}
