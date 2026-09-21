// 引擎管道装配（超级工作台 2.0 批次B）：side-effect import 触发各任务类型自注册 +
// 注册引擎每日巡检的收集器（仅 deep 领域入队；科普线二期）。
// main.ts / ipc.ts 任一 import 本模块即完成注册，先于任何 enqueue。
import { enqueue } from './queue'
import { registerCollector } from './engine'
import type { AgentDomainRow } from '../../../src/shared/types'
import './collectDeep'
import './interpret'
import './embedIndex'

registerCollector((domain: AgentDomainRow): void => {
  if (domain.track !== 'deep') {
    console.info(`[agent] 科普领域「${domain.name}」巡检跳过（科普线二期开通）`)
    return
  }
  enqueue('collect_deep', { refId: domain.id, trigger: 'scheduled' })
})
