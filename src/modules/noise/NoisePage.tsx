// 白噪音混音器页（specs §3）：场景卡 + 分层竖滑杆 + 主音量 + 出厂预设 + 自定义混音。
// UI 全部从引擎单例取值（useSyncExternalStore 版本号驱动重渲染），页面卸载不影响播放。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { SCENES } from '../../services/noiseScenes'
import { noiseEngine } from '../../services/noiseEngine'
import { SettingsKeys } from '../../shared/types'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import './noise.css'

/** 自定义混音（noise_custom_mixes JSON 条目；不含主音量） */
interface CustomMix {
  id: string
  name: string
  sceneId: string
  layers: Record<string, number>
  createdAt: string
}

/** settings JSON 容错解析：非数组/缺关键字段的条目丢弃，坏数据不炸页面 */
function parseMixes(raw: string | null): CustomMix[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (m): m is CustomMix =>
        !!m &&
        typeof m === 'object' &&
        typeof (m as CustomMix).id === 'string' &&
        typeof (m as CustomMix).name === 'string' &&
        typeof (m as CustomMix).sceneId === 'string' &&
        typeof (m as CustomMix).layers === 'object'
    )
  } catch {
    return []
  }
}

export default function NoisePage() {
  const { toast } = useToast()
  useSyncExternalStore(noiseEngine.subscribe, noiseEngine.getSnapshot)
  const st = noiseEngine.getState()
  const scene = SCENES.find((s) => s.id === st.sceneId) ?? SCENES[0]
  const [mixes, setMixes] = useState<CustomMix[]>([])
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [delTarget, setDelTarget] = useState<CustomMix | null>(null)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void window.api.settings.get(SettingsKeys.NoiseCustomMixes).then((raw) => setMixes(parseMixes(raw)))
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

  const persistMixes = (next: CustomMix[]): void => {
    setMixes(next)
    void window.api.settings.set(SettingsKeys.NoiseCustomMixes, JSON.stringify(next))
  }

  const onToggle = (): void => {
    noiseEngine.toggle().catch(() => toast('音频初始化失败'))
  }

  /** 整组应用层配比（出厂预设 / 召回自定义共用） */
  const applyLayers = (layers: Record<string, number>): void => {
    for (const def of scene.layers) noiseEngine.setLayer(def.id, layers[def.id] ?? 0)
    persistStateNow()
  }

  const commitSave = (): void => {
    const name = saveName.trim()
    if (!name) {
      toast('请输入混音名称')
      return
    }
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

  return (
    <div className="module-page noise-page">
      <div className="module-header">
        <span className="module-title">白噪音</span>
        <span className="module-sub">全局背景音 · 切换模块不打断</span>
        <button className="btn btn-primary noise-play" style={{ marginLeft: 'auto' }} onClick={onToggle}>
          <span className="material-symbols-outlined">{st.playing ? 'pause' : 'play_arrow'}</span>
          {st.playing ? '暂停' : '播放'}
        </button>
      </div>

      {/* 场景条（多场景架构的体现，首版仅「雨」） */}
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
          <div className="noise-chips">
            {scene.presets.map((p) => (
              <button key={p.id} className="tag-chip" onClick={() => applyLayers(p.layers)}>
                {p.label}
              </button>
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
            <div className="noise-chips">
              {sceneMixes.map((m) => (
                <span key={m.id} className="tag-chip removable">
                  <button onClick={() => applyLayers(m.layers)} title="召回此混音">
                    {m.name}
                  </button>
                  <button onClick={() => setDelTarget(m)} title="删除此混音">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </span>
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
    </div>
  )
}
