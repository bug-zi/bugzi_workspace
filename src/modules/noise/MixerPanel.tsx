// 混音器面板（原 NoisePage 主体搬运，播放队列轮 §4 拆分）：场景条 + 分层滑杆 + 主音量 + 出厂预设 + 自定义混音。
// 混音参数持久化（noise_state）随本面板；自定义混音的加载/落库上提到 NoisePage（队列面板共用）。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { SCENES } from '../../services/noiseScenes'
import { noiseEngine } from '../../services/noiseEngine'
import { SettingsKeys } from '../../shared/types'
import ConfirmDialog from '../../components/ConfirmDialog'
import type { QueueSoundRef } from './queueStore'
import type { CustomMix } from './NoisePage'
import './noise.css'

export default function MixerPanel({
  mixes,
  persistMixes,
  onAddToQueue,
  onViewQueue
}: {
  mixes: CustomMix[]
  persistMixes: (next: CustomMix[]) => void
  onAddToQueue: (ref: QueueSoundRef) => void
  onViewQueue: () => void
}) {
  useSyncExternalStore(noiseEngine.subscribe, noiseEngine.getSnapshot)
  const st = noiseEngine.getState()
  const scene = SCENES.find((s) => s.id === st.sceneId) ?? SCENES[0]
  const queue = noiseEngine.getQueue()
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [delTarget, setDelTarget] = useState<CustomMix | null>(null)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
    }
  }, [])

  // —— 落库：滑杆/主音量防抖 500ms；场景切换/预设/召回即刻 ——
  const persistStateNow = (): void => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current)
      persistTimer.current = null
    }
    const s = noiseEngine.getState()
    void window.api.settings.set(
      SettingsKeys.NoiseState,
      JSON.stringify({ sceneId: s.sceneId, layers: s.layers, master: s.master })
    )
  }
  const schedulePersist = (): void => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(persistStateNow, 500)
  }

  /** 整组应用层配比（出厂预设 / 召回自定义共用） */
  const applyLayers = (layers: Record<string, number>): void => {
    for (const def of scene.layers) noiseEngine.setLayer(def.id, layers[def.id] ?? 0)
    persistStateNow()
  }

  const commitSave = (): void => {
    const name = saveName.trim()
    if (!name) return
    const s = noiseEngine.getState()
    persistMixes([
      ...mixes,
      {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        name,
        sceneId: s.sceneId,
        layers: { ...s.layers },
        createdAt: new Date().toISOString()
      }
    ])
    setSaveOpen(false)
  }

  const sceneMixes = mixes.filter((m) => m.sceneId === scene.id)
  const activeIdx = queue.activeId != null ? queue.items.findIndex((it) => it.id === queue.activeId) : -1

  return (
    <>
      {/* 队列运行提示条：点击跳队列 tab；本面板任何混音操作会自动退出队列（引擎打断规则） */}
      {activeIdx >= 0 && (
        <div className="noise-queue-banner" onClick={onViewQueue}>
          <span className="material-symbols-outlined">queue_music</span>
          队列播放中 · 第 {activeIdx + 1} 项 · 点击查看
        </div>
      )}

      {/* 场景条 */}
      <div className="noise-scenes">
        {SCENES.map((s) => (
          <button
            key={s.id}
            className={`noise-scene-card${s.id === scene.id ? ' active' : ''}`}
            onClick={() => {
              noiseEngine.setScene(s.id)
              persistStateNow()
            }}
          >
            <span className="material-symbols-outlined">{s.icon}</span>
            <span>{s.label}</span>
          </button>
        ))}
      </div>

      {/* 滑杆区：分层竖滑杆 + 主音量 */}
      <div className="zone">
        <div className="zone-header">
          <span className="material-symbols-outlined">tune</span>
          <span>分层混音</span>
        </div>
        <div className="zone-body noise-mixer">
          <div className="noise-faders">
            {scene.layers.map((def) => (
              <div key={def.id} className="noise-fader">
                <span className="noise-fader-value">{st.layers[def.id] ?? 0}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={st.layers[def.id] ?? 0}
                  onChange={(e) => {
                    noiseEngine.setLayer(def.id, Number(e.target.value))
                    schedulePersist()
                  }}
                  aria-label={def.label}
                />
                <span className="noise-fader-label" title={def.label}>
                  {def.label}
                </span>
              </div>
            ))}
          </div>
          <div className="noise-master">
            <span className="material-symbols-outlined">volume_up</span>
            <input
              type="range"
              min={0}
              max={100}
              value={st.master}
              onChange={(e) => {
                noiseEngine.setMaster(Number(e.target.value))
                schedulePersist()
              }}
              aria-label="主音量"
            />
            <span className="noise-fader-value">{st.master}</span>
          </div>
        </div>
      </div>

      {/* 出厂预设 */}
      <div className="zone">
        <div className="zone-header">
          <span className="material-symbols-outlined">auto_awesome</span>
          <span>出厂预设</span>
        </div>
        <div className="zone-body">
          <div className="noise-sound-rows">
            {scene.presets.map((p) => (
              <div
                key={p.id}
                className="noise-queue-row noise-sound-row"
                onClick={() => applyLayers(p.layers)}
                title="点击应用此预设"
              >
                <span className="q-name">{p.label}</span>
                <button
                  className="q-icon-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    onAddToQueue({ kind: 'preset', sceneId: scene.id, presetId: p.id, label: `${scene.label} · ${p.label}` })
                  }}
                  title="添加到播放队列"
                >
                  <span className="material-symbols-outlined">playlist_add</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 自定义混音（按场景归属过滤） */}
      <div className="zone">
        <div className="zone-header">
          <span className="material-symbols-outlined">bookmark</span>
          <span>我的混音（{scene.label}）</span>
          <span className="zone-actions">
            <button
              className="btn"
              onClick={() => {
                setSaveName('')
                setSaveOpen(true)
              }}
            >
              保存当前配比
            </button>
          </span>
        </div>
        <div className="zone-body">
          {sceneMixes.length === 0 ? (
            <div className="empty-state">还没有保存过混音，调好滑杆点「保存当前配比」</div>
          ) : (
            <div className="noise-sound-rows">
              {sceneMixes.map((m) => (
                <div
                  key={m.id}
                  className="noise-queue-row noise-sound-row"
                  onClick={() => applyLayers(m.layers)}
                  title="点击召回此混音"
                >
                  <span className="q-name">{m.name}</span>
                  <button
                    className="q-icon-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      onAddToQueue({ kind: 'custom', sceneId: m.sceneId, mixId: m.id, label: `${scene.label} · ${m.name}` })
                    }}
                    title="添加到播放队列"
                  >
                    <span className="material-symbols-outlined">playlist_add</span>
                  </button>
                  <button
                    className="q-icon-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDelTarget(m)
                    }}
                    title="删除此混音"
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 命名保存弹窗 */}
      {saveOpen && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setSaveOpen(false)}>
          <div className="dialog" style={{ width: 360 }}>
            <div className="dialog-header">保存混音</div>
            <div className="dialog-body">
              <input
                className="field"
                autoFocus
                value={saveName}
                placeholder="混音名称（如：写作用雨）"
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && commitSave()}
              />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setSaveOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={commitSave}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除二次确认（全局规则：彻底删不入回收站） */}
      <ConfirmDialog
        open={!!delTarget}
        title="删除混音"
        danger
        confirmText="删除"
        onConfirm={() => {
          if (delTarget) persistMixes(mixes.filter((m) => m.id !== delTarget.id))
          setDelTarget(null)
        }}
        onCancel={() => setDelTarget(null)}
      >
        确定删除混音「{delTarget?.name}」吗？此操作彻底删除，不入回收站。
      </ConfirmDialog>
    </>
  )
}
