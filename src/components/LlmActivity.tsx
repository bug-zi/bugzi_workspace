// AI 实时活动指示（260910 推理角效率优化）：主进程 llm:activity 广播驱动，空闲（items 空）不渲染。
// 竖排图标范式（冒烟反馈修订：左栏仅 76px，横排文字必截断）——学 nav-item 竖排：
// 旋转 progress_activity 图标在上 + 「AI ×N」小字在下，悬停 title 看逐场景明细。纯指示不可点。
import { useEffect, useState } from 'react'
import { LLM_SCENE_LABELS } from '../shared/types'

interface ActivityItem {
  scene: string
  configName: string
}

export default function LlmActivity() {
  const [items, setItems] = useState<ActivityItem[]>([])
  useEffect(() => {
    return window.api.llmUsage.onActivity((payload) => setItems(payload.items))
  }, [])
  if (items.length === 0) return null
  const counts = new Map<string, number>()
  for (const it of items) counts.set(it.scene, (counts.get(it.scene) ?? 0) + 1)
  const title = [...counts.entries()]
    .map(([scene, n]) => `${LLM_SCENE_LABELS[scene] ?? scene}${n > 1 ? ` ×${n}` : ''}`)
    .join(' · ')
  return (
    <div className="llm-activity" title={title}>
      <span className="material-symbols-outlined llm-activity-icon">progress_activity</span>
      <span className="llm-activity-label">AI{items.length > 1 ? ` ×${items.length}` : ''}</span>
    </div>
  )
}
