// 论文库（260924 自信息源拆出为独立模块，学习区）：深读线壳——头部与阅读视图切换在 LiteraturePanel 内
// （260927 长文阅读视图化：阅读态整页切换不渲染模块头部，播客台同款）；批次F 相关内容深链随模块迁入
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
    <LiteraturePanel
      onOpenAi={(prefill) => props.onOpenAi?.(prefill ?? '', { channel: 'literature' })}
      openPaperId={openPaperId}
      onOpenPaperConsumed={() => setOpenPaperId(null)}
    />
  )
}
