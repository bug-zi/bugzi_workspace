// 引擎管道装配（超级工作台 2.0 批次B + 批次D）：side-effect import 触发各任务类型自注册 +
// 注册引擎每日巡检的收集器（按 domain.track 路由：deep→collect_deep、science→collect_science，
// 错峰巡检/预算/负载暂停对两线同口径生效）。
// main.ts / ipc.ts 任一 import 本模块即完成注册，先于任何 enqueue。
import { enqueue } from './queue'
import { registerCollector } from './engine'
import type { AgentDomainRow } from '../../../src/shared/types'
import './collectDeep'
import './collectScience'
import './interpret'
import './interpretScience'
import './embedIndex'

registerCollector((domain: AgentDomainRow): void => {
  if (domain.track === 'science') {
    enqueue('collect_science', { refId: domain.id, trigger: 'scheduled' })
    return
  }
  enqueue('collect_deep', { refId: domain.id, trigger: 'scheduled' })
})
