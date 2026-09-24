// 娱乐城模块（娱乐城 specs §2）：三页签 塔罗|德扑|21点（板块 keep-alive，切页签不打断对局），
// 模块头钱包角标常驻三页签共用；破产救济按钮按 wallet.reliefAvailable 显隐。
import { useCallback, useState } from 'react'
import type { YuleWalletView } from '../../renderer/api'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { useToast } from '../../components/Toast'
import TaroPane from './TaroPane'
import PokerPane from './PokerPane'
import BlackjackPane from './BlackjackPane'
import './yule.css'

type Tab = 'taro' | 'poker' | 'blackjack'

export default function YuleModule() {
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('taro')
  const [wallet, setWallet] = useState<YuleWalletView | null>(null)

  const loadWallet = useCallback(async () => {
    try {
      setWallet(await window.api.yule.getWallet())
    } catch (e) {
      toast(`钱包加载失败：${(e as Error).message}`)
    }
  }, [toast])

  useModuleActivated('yule', () => void loadWallet())

  const claimRelief = useCallback(async () => {
    try {
      setWallet(await window.api.yule.claimRelief())
      toast(`已领取救济 ${wallet?.reliefAmount ?? 2000} 筹码，明天再来`)
    } catch (e) {
      toast((e as Error).message)
    }
  }, [toast, wallet])

  return (
    <div className="module-page">
      <div className="module-header">
        <span className="material-symbols-outlined">casino</span>
        <span className="module-title">娱乐城</span>
        <span className="module-sub">轻娱乐三馆 · 筹码共用</span>
        <span className="yule-wallet-badge" title="全娱乐城共用筹码钱包">
          <span className="material-symbols-outlined">toll</span>
          <span className="yule-wallet-num">{wallet?.balance ?? '…'}</span>
          {wallet?.reliefAvailable && (
            <button className="yule-relief-btn" onClick={() => void claimRelief()}>
              领救济 {wallet.reliefAmount}
            </button>
          )}
        </span>
      </div>

      <div className="recycle-tabs">
        <button className={`recycle-tab${tab === 'taro' ? ' active' : ''}`} onClick={() => setTab('taro')}>
          塔罗
        </button>
        <button className={`recycle-tab${tab === 'poker' ? ' active' : ''}`} onClick={() => setTab('poker')}>
          德扑
        </button>
        <button className={`recycle-tab${tab === 'blackjack' ? ' active' : ''}`} onClick={() => setTab('blackjack')}>
          21点
        </button>
      </div>

      {/* 三页签 keep-alive（照 ReasoningModule 板块容器模式）：常驻挂载 + display 隐藏，
          德扑进行中对局切走切回不丢（specs §2） */}
      <div className={tab === 'taro' ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== 'taro'}>
        <TaroPane />
      </div>
      <div className={tab === 'poker' ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== 'poker'}>
        <PokerPane onWalletChanged={() => void loadWallet()} />
      </div>
      <div className={tab === 'blackjack' ? 'module-live' : 'module-live module-hidden'} aria-hidden={tab !== 'blackjack'}>
        <BlackjackPane onWalletChanged={() => void loadWallet()} />
      </div>
    </div>
  )
}
