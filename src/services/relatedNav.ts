// 相关内容点击跳转（超级工作台 2.0 批次F）：五类实体 → 目标模块深链
// （App 切模块/模式，模块内 useModuleNavigate 开对应详情）。
import { MODULE_NAVIGATE_EVENT } from '../App'

export interface RelatedPeer {
  peer_type: string
  peer_id: number
}

export function openRelated(peer: RelatedPeer): void {
  switch (peer.peer_type) {
    case 'paper':
      window.dispatchEvent(
        new CustomEvent(MODULE_NAVIGATE_EVENT, {
          detail: { module: 'feed', target: 'literature-paper', payload: { paperId: peer.peer_id } }
        })
      )
      break
    case 'science_article':
      window.dispatchEvent(
        new CustomEvent(MODULE_NAVIGATE_EVENT, {
          detail: { module: 'wiki', target: 'science-article', payload: { articleId: peer.peer_id } }
        })
      )
      break
    case 'wiki':
      window.dispatchEvent(
        new CustomEvent(MODULE_NAVIGATE_EVENT, {
          detail: { module: 'wiki', target: 'wiki-entry', payload: { entryId: peer.peer_id } }
        })
      )
      break
    case 'book':
      window.dispatchEvent(
        new CustomEvent(MODULE_NAVIGATE_EVENT, {
          detail: { module: 'zangyue', target: 'open-digest', payload: { bookId: peer.peer_id } }
        })
      )
      break
    case 'learn_node':
      window.dispatchEvent(
        new CustomEvent(MODULE_NAVIGATE_EVENT, {
          detail: { module: 'learn', target: 'open-card', payload: { nodeId: peer.peer_id } }
        })
      )
      break
  }
}

/** 相关内容行类型图标（Material Symbols） */
export function relatedIcon(peerType: string): string {
  switch (peerType) {
    case 'paper':
      return 'description'
    case 'science_article':
      return 'science'
    case 'wiki':
      return 'menu_book'
    case 'book':
      return 'auto_stories'
    case 'learn_node':
      return 'school'
    default:
      return 'link'
  }
}
