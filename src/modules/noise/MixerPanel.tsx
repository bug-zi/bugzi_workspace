// 混音器面板（原 NoisePage 主体搬运，播放队列轮 §4 拆分）：场景条 + 分层滑杆 + 主音量 + 出厂预设 + 自定义混音。
// 混音参数持久化（noise_state）随本面板；自定义混音的加载/落库上提到 NoisePage（队列面板共用）。
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { SCENES, BUILTIN_TRIGGERS } from '../../services/noiseScenes'
import { noiseEngine, type TriggerState } from '../../services/noiseEngine'
import { SettingsKeys } from '../../shared/types'
import { useToast } from '../../components/Toast'
import ConfirmDialog from '../../components/ConfirmDialog'
import type { QueueSoundRef } from './queueStore'
import type { CustomMix, NoiseHiddenData } from './NoisePage'
import type { TriggerSoundRow } from '../../shared/types'
import './noise.css'

/** 触发音行：开关 + 名称 + 音量 + 声像（游移开时置灰）+ 游移开关；导入项另有改名/删除 */
function TriggerRow(props: {
  label: string
  st: TriggerState
  onPatch: (patch: Partial<TriggerState>) => void
  onRename?: () => void
  onDelete?: () => void
}) {
  return (
    <div className="noise-trigger-row">
      <button
        className={`icon-btn${props.st.on ? ' noise-playing' : ''}`}
        title={props.st.on ? '关闭' : '开启'}
        onClick={() => props.onPatch({ on: !props.st.on })}
      >
        <span className="material-symbols-outlined">{props.st.on ? 'pause_circle' : 'play_circle'}</span>
      </button>
      <span className="t-name" title={props.label}>
        {props.label}
      </span>
      <input
        className="t-vol"
        type="range"
        min={0}
        max={100}
        value={props.st.vol}
        onChange={(e) => props.onPatch({ vol: Number(e.target.value) })}
        title={`音量 ${props.st.vol}`}
        aria-label={`${props.label} 音量`}
      />
      <input
        className="t-pan"
        type="range"
        min={-100}
        max={100}
        step={10}
        value={props.st.pan}
        disabled={props.st.roam}
        onChange={(e) => props.onPatch({ pan: Number(e.target.value) })}
        title={props.st.roam ? '游移中（左右随机摆位）' : `声像 ${props.st.pan}`}
        aria-label={`${props.label} 声像`}
      />
      <button
        className={`icon-btn${props.st.roam ? ' noise-playing' : ''}`}
        title={props.st.roam ? '游移开（点击改手动声像）' : '游移关（每次发声随机左右，耳机体验）'}
        onClick={() => props.onPatch({ roam: !props.st.roam })}
      >
        <span className="material-symbols-outlined">swap_horiz</span>
      </button>
      {props.onRename && (
        <button className="icon-btn" title="改名" onClick={props.onRename}>
          <span className="material-symbols-outlined">edit</span>
        </button>
      )}
      {props.onDelete && (
        <button className="icon-btn danger" title="彻底删除（含文件）" onClick={props.onDelete}>
          <span className="material-symbols-outlined">delete</span>
        </button>
      )}
    </div>
  )
}

export default function MixerPanel({
  mixes,
  persistMixes,
  hidden,
  persistHidden,
  onAddToQueue,
  onViewQueue
}: {
  mixes: CustomMix[]
  persistMixes: (next: CustomMix[]) => void
  hidden: NoiseHiddenData
  persistHidden: (next: NoiseHiddenData) => void
  onAddToQueue: (ref: QueueSoundRef) => void
  onViewQueue: () => void
}) {
  useSyncExternalStore(noiseEngine.subscribe, noiseEngine.getSnapshot)
  const st = noiseEngine.getState()
  const visibleScenes = SCENES.filter((s) => !hidden.scenes.includes(s.id))
  const scene = SCENES.find((s) => s.id === st.sceneId) ?? visibleScenes[0] ?? SCENES[0]
  const queue = noiseEngine.getQueue()
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [delTarget, setDelTarget] = useState<CustomMix | null>(null)
  const [delScene, setDelScene] = useState<string | null>(null)
  const [delBuiltinTrg, setDelBuiltinTrg] = useState<string | null>(null)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { toast } = useToast()
  const [triggerRows, setTriggerRows] = useState<TriggerSoundRow[]>([])
  const [renameTrg, setRenameTrg] = useState<TriggerSoundRow | null>(null)
  const [renameTrgName, setRenameTrgName] = useState('')
  const [delTrg, setDelTrg] = useState<TriggerSoundRow | null>(null)

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
      JSON.stringify({ sceneId: s.sceneId, layers: s.layers, pans: s.pans, triggers: s.triggers, master: s.master })
    )
  }
  const schedulePersist = (): void => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(persistStateNow, 500)
  }

  const loadTriggers = useCallback(async (): Promise<void> => {
    const rows = await window.api.trigger.list()
    setTriggerRows(rows)
    void noiseEngine.decodeTriggers(rows.map((r) => r.id)) // 预解码缓存（已缓存的跳过）
  }, [])

  useEffect(() => {
    loadTriggers().catch(() => toast('触发音列表加载失败'))
  }, [loadTriggers, toast])

  const trigState = (key: string): TriggerState =>
    st.triggers[key] ?? { on: false, vol: 50, pan: 0, roam: false }

  const patchTrg = (key: string) => (patch: Partial<TriggerState>): void => {
    noiseEngine.setTrigger(key, patch)
    schedulePersist()
  }

  const doImportTriggers = async (): Promise<void> => {
    const s = await window.api.trigger.importDialog()
    if (s.imported + s.skipped + s.failed === 0) return // 用户取消
    const parts = [`导入 ${s.imported}`]
    if (s.skipped) parts.push(`重复跳过 ${s.skipped}`)
    if (s.failed) parts.push(`失败 ${s.failed}`)
    toast(parts.join(' · '))
    await loadTriggers()
  }

  const doRenameTrg = async (): Promise<void> => {
    if (!renameTrg) return
    const name = renameTrgName.trim()
    if (!name) return
    try {
      await window.api.trigger.rename(renameTrg.id, name)
      setRenameTrg(null)
      await loadTriggers()
    } catch {
      toast('该名称已存在')
    }
  }

  const doDeleteTrg = async (): Promise<void> => {
    if (!delTrg) return
    await window.api.trigger.delete(delTrg.id)
    noiseEngine.forgetTrigger(delTrg.id) // 清引擎缓存/状态/实例
    setDelTrg(null)
    await loadTriggers()
    toast('已彻底删除（含音频文件）')
  }

  /** 整组应用层配比（混音行召回共用）：带触发层快照则整组恢复（快照没有的一律关） */
  const applyLayers = (layers: Record<string, number>, triggers?: Record<string, TriggerState>): void => {
    for (const def of scene.layers) noiseEngine.setLayer(def.id, layers[def.id] ?? 0)
    if (triggers) {
      const cur = noiseEngine.getState().triggers
      for (const key of Object.keys(cur)) {
        if (!(key in triggers)) noiseEngine.setTrigger(key, { on: false }, { autoPlay: false })
      }
      for (const [k, v] of Object.entries(triggers)) noiseEngine.setTrigger(k, v, { autoPlay: false })
    }
    persistStateNow()
  }

  // 当前场景被删（隐藏）时逃逸到首个可见场景
  useEffect(() => {
    if (visibleScenes.length > 0 && !visibleScenes.some((s) => s.id === st.sceneId)) {
      noiseEngine.setScene(visibleScenes[0].id)
      persistStateNow()
    }
  }, [st.sceneId, visibleScenes])

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
        triggers: Object.fromEntries(Object.entries(s.triggers).map(([k, v]) => [k, { ...v }])),
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

      {/* 场景条（隐藏名单过滤） */}
      <div className="noise-scenes">
        {visibleScenes.map((s) => (
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
          <span className="zone-actions">
            <button
              className="icon-btn danger"
              title="删除该场景（隐藏不再显示；至少保留一个场景）"
              disabled={visibleScenes.length <= 1}
              onClick={() => setDelScene(scene.id)}
            >
              <span className="material-symbols-outlined">delete</span>
            </button>
          </span>
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
                <input
                  className="noise-fader-pan"
                  type="range"
                  min={-100}
                  max={100}
                  step={10}
                  value={st.pans[def.id] ?? 0}
                  onChange={(e) => {
                    noiseEngine.setLayerPan(def.id, Number(e.target.value))
                    schedulePersist()
                  }}
                  title={`声像 ${st.pans[def.id] ?? 0}`}
                  aria-label={`${def.label} 声像`}
                />
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

      {/* 触发音（260921 触发音轮）：跨场景叠加层——内置合成 + 导入统一行，随机间隔 2–8s 单发 */}
      <div className="zone">
        <div className="zone-header">
          <span className="material-symbols-outlined">graphic_eq</span>
          <span>触发音</span>
          <span className="zone-actions">
            <button className="btn" onClick={() => void doImportTriggers()}>
              导入音频
            </button>
          </span>
        </div>
        <div className="zone-body">
          <div className="noise-trigger-rows">
            {BUILTIN_TRIGGERS.filter((t) => !hidden.builtinTriggers.includes(t.id)).map((t) => (
              <TriggerRow
                key={t.id}
                label={t.label}
                st={trigState(`builtin:${t.id}`)}
                onPatch={patchTrg(`builtin:${t.id}`)}
                onDelete={() => setDelBuiltinTrg(t.id)}
              />
            ))}
            {triggerRows.map((r) => (
              <TriggerRow
                key={r.id}
                label={r.name}
                st={trigState(String(r.id))}
                onPatch={patchTrg(String(r.id))}
                onRename={() => {
                  setRenameTrg(r)
                  setRenameTrgName(r.name)
                }}
                onDelete={() => setDelTrg(r)}
              />
            ))}
          </div>
          {triggerRows.length === 0 && (
            <div className="empty-state">
              还没有导入的触发音——耳语、刷头这类真人录音可点「导入音频」添加（mp3/wav/ogg）
            </div>
          )}
        </div>
      </div>

      {/* 我的混音（出厂预设已并入本列表，可删；每场景可设一条默认混音） */}
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
                  onClick={() => applyLayers(m.layers, m.triggers)}
                  title="点击应用此混音（含触发层快照）"
                >
                  <button
                    className={`q-icon-btn noise-mix-star${m.isDefault ? ' active' : ''}`}
                    title={m.isDefault ? '取消默认混音' : '设为该场景默认混音（切到本场景时自动应用）'}
                    onClick={(e) => {
                      e.stopPropagation()
                      persistMixes(
                        mixes.map((x) =>
                          x.sceneId === m.sceneId ? { ...x, isDefault: x.id === m.id ? !(x.isDefault === true) : false } : x
                        )
                      )
                    }}
                  >
                    <span className="material-symbols-outlined">{m.isDefault ? 'star' : 'star_border'}</span>
                  </button>
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

      {/* 删除混音二次确认（全局规则：彻底删不入回收站；出厂混音行删后不再恢复） */}
      <ConfirmDialog
        open={!!delTarget}
        title="删除混音"
        danger
        confirmText="删除"
        onConfirm={() => {
          if (delTarget) {
            persistMixes(mixes.filter((m) => m.id !== delTarget.id))
            if (delTarget.factoryKey) {
              persistHidden({ ...hidden, factoryMixes: [...hidden.factoryMixes, delTarget.factoryKey] })
            }
          }
          setDelTarget(null)
        }}
        onCancel={() => setDelTarget(null)}
      >
        确定删除混音「{delTarget?.name}」吗？{delTarget?.factoryKey ? '出厂混音删除后不再恢复。' : ''}
        此操作彻底删除，不入回收站。
      </ConfirmDialog>

      {/* 删场景二次确认（隐藏名单；至少保留一个场景） */}
      <ConfirmDialog
        open={!!delScene}
        title="删除场景"
        danger
        confirmText="删除"
        onConfirm={() => {
          if (delScene) persistHidden({ ...hidden, scenes: [...hidden.scenes, delScene] })
          setDelScene(null)
        }}
        onCancel={() => setDelScene(null)}
      >
        确定删除场景「{SCENES.find((s) => s.id === delScene)?.label}」吗？该场景将从场景条隐藏（该场景的出厂混音行一并隐藏），不入回收站。
      </ConfirmDialog>

      {/* 删内置触发音二次确认（隐藏名单） */}
      <ConfirmDialog
        open={!!delBuiltinTrg}
        title="删除触发音"
        danger
        confirmText="删除"
        onConfirm={() => {
          if (delBuiltinTrg) {
            noiseEngine.forgetTriggerKey(`builtin:${delBuiltinTrg}`)
            persistHidden({ ...hidden, builtinTriggers: [...hidden.builtinTriggers, delBuiltinTrg] })
          }
          setDelBuiltinTrg(null)
        }}
        onCancel={() => setDelBuiltinTrg(null)}
      >
        确定删除触发音「{BUILTIN_TRIGGERS.find((t) => t.id === delBuiltinTrg)?.label}」吗？删除后不再显示，不入回收站。
      </ConfirmDialog>

      {/* 触发音改名 */}
      {renameTrg && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setRenameTrg(null)}>
          <div className="dialog" style={{ width: 360 }}>
            <div className="dialog-header">触发音改名</div>
            <div className="dialog-body">
              <input className="field" value={renameTrgName} onChange={(e) => setRenameTrgName(e.target.value)} />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setRenameTrg(null)}>
                取消
              </button>
              <button className="btn btn-primary" disabled={!renameTrgName.trim()} onClick={() => void doRenameTrg()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删触发音（全局规则：彻底删不入回收站） */}
      <ConfirmDialog
        open={!!delTrg}
        title="删除触发音"
        danger
        confirmText="删除"
        onConfirm={() => void doDeleteTrg()}
        onCancel={() => setDelTrg(null)}
      >
        「{delTrg?.name}」将连音频文件一起彻底删除，不入回收站，确定？
      </ConfirmDialog>
    </>
  )
}
