// AI 实时活动指示（260910 推理角效率优化）：主进程 llm:activity 广播驱动，
// 空闲（items 空）不渲染；同场景聚合计数（如「推理角·出题 ×2」）。纯指示不可点。
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
  const text = [...counts.entries()]
    .map(([scene, n]) => `${LLM_SCENE_LABELS[scene] ?? scene}${n > 1 ? ` ×${n}` : ''}`)
    .join(' · ')
  return (
    <div className="llm-activity" title={text}>
      <span className="llm-activity-dot" />
      <span className="llm-activity-text">{text}</span>
    </div>
  )
}
