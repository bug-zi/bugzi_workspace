// 快捷键配置（260929 新功能开发区）：个人档「快捷键」zone——展示应用内快捷键当前组合，
// 行内按键录入重设（须含 Ctrl/Alt 修饰、冲突拒绝）、恢复默认；即存即生效经
// bugzi:keybindings-changed 通知 App Shell 与各处 useShortcutLabel 重载
import { useCallback, useEffect, useState } from 'react'
import { useToast } from '../../components/Toast'
import {
  DEFAULT_BINDINGS,
  SHORTCUT_ACTIONS,
  acceleratorFromEvent,
  formatAccelerator,
  loadOverrides,
  resolveBindings,
  saveBindings,
  setCapturing,
  type BindingOverrides,
  type ShortcutActionId
} from '../../services/keybindings'
import './ShortcutZone.css'

export default function ShortcutZone() {
  const { toast } = useToast()
  const [overrides, setOverrides] = useState<BindingOverrides>({})
  const [bindings, setBindings] = useState(resolveBindings({}))
  const [capturingId, setCapturingId] = useState<ShortcutActionId | null>(null)

  useEffect(() => {
    void loadOverrides().then((ov) => {
      setOverrides(ov)
      setBindings(resolveBindings(ov))
    })
  }, [])

  const beginCapture = (id: ShortcutActionId): void => {
    setCapturingId(id)
    toast('按下新组合键，Esc 取消')
  }

  const commitOrReset = useCallback(
    (next: BindingOverrides, msg: string): void => {
      setOverrides(next)
      setBindings(resolveBindings(next))
      void saveBindings(next).then(() => toast(msg))
    },
    [toast]
  )

  // 录入态：capture 阶段监听（先于全局分发器）+ isCapturing 双保险；纯修饰键忽略继续等待
  useEffect(() => {
    if (!capturingId) return
    setCapturing(true)
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturingId(null)
        return
      }
      const acc = acceleratorFromEvent(e)
      if (!acc) return
      const clash = SHORTCUT_ACTIONS.find((m) => m.id !== capturingId && bindings[m.id] === acc)
      if (clash) {
        toast(`与「${clash.label}」冲突，请换一个组合`)
        return // 留在录入态，可直接再按
      }
      const next = { ...overrides, [capturingId]: acc }
      setCapturingId(null)
      commitOrReset(next, '快捷键已保存')
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      setCapturing(false)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [capturingId, bindings, overrides, commitOrReset, toast])

  const resetOne = (id: ShortcutActionId): void => {
    const next = { ...overrides }
    delete next[id]
    commitOrReset(next, '已恢复默认')
  }

  return (
    <section id="profile-zone-keys" className="zone">
      <div className="zone-header"><span>快捷键</span></div>
      <div className="zone-body">
        {SHORTCUT_ACTIONS.map((m) => (
          <div className="setting-row shortcut-row" key={m.id}>
            <span className="setting-label">{m.label}</span>
            <div className="shortcut-controls">
              {capturingId === m.id ? (
                <span className="shortcut-capture">按下新组合键…（Esc 取消）</span>
              ) : (
                <>
                  <kbd className="shortcut-kbd">{formatAccelerator(bindings[m.id])}</kbd>
                  <button className="icon-btn" title="重新设置" onClick={() => beginCapture(m.id)}>
                    <span className="material-symbols-outlined">edit</span>
                  </button>
                  {bindings[m.id] !== DEFAULT_BINDINGS[m.id] && (
                    <button className="icon-btn" title="恢复默认" onClick={() => resetOne(m.id)}>
                      <span className="material-symbols-outlined">restart_alt</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
        <div className="module-sub shortcut-note">
          快捷键仅应用内生效；焦点在输入框内不触发（保留全选等原生行为），终端面板内仅终端两条触发。
          固定快捷键：终端内 Ctrl + Shift + C / V 复制粘贴、信息源阅读 Ctrl + 滚轮缩放字号。
          Ctrl + Space 若无效，可能被系统输入法占用，需在输入法设置中解绑。
        </div>
      </div>
    </section>
  )
}
