// 论文库（260924 自信息源拆出为独立模块，学习区）：深读线壳——头部 + LiteraturePanel；
// 批次F 相关内容深链（relatedNav 'literature-paper'）随模块迁入
import { useState } from 'react'
import LiteraturePanel from './LiteraturePanel'
import { useModuleNavigate } from '../../hooks/useModuleNavigate'
import type { AiChannel } from '../../shared/types'

export default function LiteratureModule(props: {
  onOpenAi?: (prefill?: string, opts?: { auto?: boolean; channel?: AiChannel }) => void
}) {
  // 跨模块深链：待自动打开的文献详情 id（消费后复位）
  const [openPaperId, setOpenPaperId] = useState<number | null>(null)
  useModuleNavigate('literature', (target, payload) => {
    if (target === 'literature-paper') {
      const pid = Number(payload?.paperId)
      if (!Number.isFinite(pid)) return
      setOpenPaperId(pid)
    }
  })
  return (
    <div className="module-page" style={{ maxWidth: 1200 }}>
      <div className="module-header">
        <span className="material-symbols-outlined">library_books</span>
        <span className="module-title">论文库</span>
        <span className="module-sub">发现箱 · 正式文献</span>
      </div>
      <LiteraturePanel
        onOpenAi={() => props.onOpenAi?.('', { channel: 'literature' })}
        openPaperId={openPaperId}
        onOpenPaperConsumed={() => setOpenPaperId(null)}
      />
    </div>
  )
}
