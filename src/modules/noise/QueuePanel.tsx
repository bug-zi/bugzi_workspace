// 播放队列面板（播放队列轮 §4）：以音效（出厂预设 + 自定义混音）为单位的定时轮换播放。
// 队列配置以引擎为唯一状态源（getQueue 快照 + setQueueConfig 写入），本面板不做本地镜像；
// 每次变更同步落 settings.noise_play_queue；运行态（当前项/倒计时）由引擎每秒 emit 驱动刷新。
import { useMemo, useState, useSyncExternalStore } from 'react'
import { SCENES } from '../../services/noiseScenes'
import { noiseEngine, type NoiseQueueItem, type NoiseQueueMode } from '../../services/noiseEngine'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { QUEUE_DEFAULT_MINUTES, genQueueItemId, saveQueueConfig } from './queueStore'
import type { CustomMix } from './NoisePage'
import './noise.css'

const MODES: { key: NoiseQueueMode; label: string }[] = [
  { key: 'sequence', label: '顺序播完即停' },
  { key: 'list-loop', label: '列表循环' },
  { key: 'single-loop', label: '单曲循环' },
  { key: 'random', label: '列表随机' }
]
const PRESET_MINUTES = [1, 5, 10, 15, 20, 30, 45, 60]

/** 添加弹窗的备选音效（预设 + 自定义混音，展平带场景标签） */
interface SoundOption {
  key: string
  kind: 'preset' | 'custom'
  sceneId: string
  presetId?: string
  mixId?: string
  label: string
  sceneLabel: string
}

export default function QueuePanel({ mixes }: { mixes: CustomMix[] }) {
  const { toast } = useToast()
  useSyncExternalStore(noiseEngine.subscribe, noiseEngine.getSnapshot)
  const q = noiseEngine.getQueue()
  const [addOpen, setAddOpen] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [addMinutes, setAddMinutes] = useState(QUEUE_DEFAULT_MINUTES)
  const [delTarget, setDelTarget] = useState<NoiseQueueItem | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  // 备选音效（按场景分组供弹窗渲染；展平序供提交遍历）
  const groups = useMemo(() => {
    return SCENES.map((scene) => ({
      scene,
      opts: [
        ...scene.presets.map<SoundOption>((p) => ({
          key: `preset:${scene.id}:${p.id}`,
          kind: 'preset' as const,
          sceneId: scene.id,
          presetId: p.id,
          label: p.label,
          sceneLabel: scene.label
        })),
        ...mixes
          .filter((m) => m.sceneId === scene.id)
          .map<SoundOption>((m) => ({
            key: `custom:${m.id}`,
            kind: 'custom' as const,
            sceneId: scene.id,
            mixId: m.id,
            label: m.name,
            sceneLabel: scene.label
          }))
      ]
    }))
  }, [mixes])
  const options = useMemo(() => groups.flatMap((g) => g.opts), [groups])

  /** 队列项显示名 + 失效判定（引用的自定义混音/预设被删 → 灰显「已删除」、播放跳过） */
  const describe = (it: NoiseQueueItem): { text: string; valid: boolean } => {
    const scene = SCENES.find((s) => s.id === it.sceneId)
    if (it.kind === 'preset') {
      const p = scene?.presets.find((x) => x.id === it.presetId)
      return p && scene ? { text: `${scene.label} · ${p.label}`, valid: true } : { text: '已删除', valid: false }
    }
    const m = mixes.find((x) => x.id === it.mixId)
    return m && scene ? { text: `${scene.label} · ${m.name}`, valid: true } : { text: '已删除', valid: false }
  }

  // —— 配置变更：写引擎（唯一状态源）+ 落 settings；运行中编辑允许（activeId 按行 id 跟踪不乱），
  //    改运行中行的时长不重置当前倒计时、换模式于下一次推进生效 ——
  const update = (items: NoiseQueueItem[], mode: NoiseQueueMode = q.mode): void => {
    saveQueueConfig(items, mode)
  }

  const setMinutes = (id: string, minutes: number): void => {
    update(q.items.map((it) => (it.id === id ? { ...it, minutes: Math.min(480, Math.max(1, Math.round(minutes))) } : it)))
  }

  const move = (idx: number, delta: -1 | 1): void => {
    const to = idx + delta
    if (to < 0 || to >= q.items.length) return
    const items = [...q.items]
    ;[items[idx], items[to]] = [items[to], items[idx]]
    update(items)
  }

  const activeIdx = q.activeId != null ? q.items.findIndex((it) => it.id === q.activeId) : -1
  const activeItem = activeIdx >= 0 ? q.items[activeIdx] : null
  const remainSec = Math.max(0, Math.ceil(q.remainMs / 1000))
  const remainText = `${String(Math.floor(remainSec / 60)).padStart(2, '0')}:${String(remainSec % 60).padStart(2, '0')}`

  const onStart = (): void => {
    if (q.items.length === 0) {
      toast('队列为空，先添加音效')
      return
    }
    noiseEngine
      .startQueue()
      .then((ok) => {
        if (!ok) toast('队列中的音效均已删除')
      })
      .catch(() => toast('音频初始化失败'))
  }

  const commitAdd = (): void => {
    if (picked.size === 0) {
      toast('请先勾选音效')
      return
    }
    const items = [...q.items]
    for (const opt of options) {
      if (!picked.has(opt.key)) continue
      items.push({
        id: genQueueItemId(),
        kind: opt.kind,
        sceneId: opt.sceneId,
        ...(opt.kind === 'preset' ? { presetId: opt.presetId } : { mixId: opt.mixId }),
        minutes: addMinutes
      })
    }
    update(items)
    setAddOpen(false)
  }

  return (
    <div className="noise-queue">
      {/* 运行态状态行 */}
      {activeItem != null && (
        <div className="noise-queue-status">
          <span className="material-symbols-outlined">queue_music</span>
          <span className="q-now">
            正在播放 {activeIdx + 1}. {describe(activeItem).text}
          </span>
          <span className="q-remain">还剩 {remainText}</span>
          <button className="btn" onClick={() => noiseEngine.stopQueue()}>
            停止队列
          </button>
        </div>
      )}

      {/* 工具行 */}
      <div className="noise-queue-toolbar">
        <button
          className="btn"
          onClick={() => {
            setPicked(new Set())
            setAddMinutes(QUEUE_DEFAULT_MINUTES)
            setAddOpen(true)
          }}
        >
          ＋ 添加音效
        </button>
        {activeItem == null && (
          <button className="btn btn-primary" onClick={onStart}>
            <span className="material-symbols-outlined">play_arrow</span>开始队列播放
          </button>
        )}
      </div>

      {/* 播放模式（运行中切换于下一次推进生效） */}
      <div className="zone">
        <div className="zone-header">
          <span className="material-symbols-outlined">repeat</span>
          <span>播放模式</span>
        </div>
        <div className="zone-body">
          <div className="recycle-tabs">
            {MODES.map((m) => (
              <button
                key={m.key}
                className={`recycle-tab${q.mode === m.key ? ' active' : ''}`}
                onClick={() => update(q.items, m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 队列列表 */}
      <div className="zone">
        <div className="zone-header">
          <span className="material-symbols-outlined">queue_music</span>
          <span>队列（{q.items.length} 项）</span>
        </div>
        <div className="zone-body">
          {q.items.length === 0 ? (
            <div className="empty-state">
              队列为空。点「＋ 添加音效」把出厂预设或「我的混音」排进来，每项播够设定时长自动切下一个。
            </div>
          ) : (
            <div className="noise-queue-rows">
              {q.items.map((it, idx) => {
                const d = describe(it)
                const showInput = editingId === it.id || !PRESET_MINUTES.includes(it.minutes)
                return (
                  <div key={it.id} className={`noise-queue-row${idx === activeIdx ? ' active' : ''}${d.valid ? '' : ' invalid'}`}>
                    <span className="q-idx">{idx + 1}.</span>
                    <span className="q-name" title={d.valid ? d.text : '引用的音效已删除，播放时将跳过'}>
                      {d.text}
                    </span>
                    {showInput ? (
                      <input
                        className="q-min-input"
                        type="number"
                        min={1}
                        max={480}
                        key={`${it.id}-${it.minutes}`}
                        defaultValue={it.minutes}
                        onBlur={(e) => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v) && v >= 1) setMinutes(it.id, v)
                          setEditingId(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        }}
                        aria-label="自定义分钟数"
                      />
                    ) : (
                      <select
                        className="q-min-select"
                        value={String(it.minutes)}
                        onChange={(e) => {
                          if (e.target.value === 'custom') setEditingId(it.id)
                          else setMinutes(it.id, Number(e.target.value))
                        }}
                        aria-label="播放时长"
                      >
                        {PRESET_MINUTES.map((m) => (
                          <option key={m} value={m}>
                            {m} 分钟
                          </option>
                        ))}
                        <option value="custom">自定义…</option>
                      </select>
                    )}
                    <button className="q-icon-btn" onClick={() => move(idx, -1)} disabled={idx === 0} title="上移">
                      <span className="material-symbols-outlined">arrow_upward</span>
                    </button>
                    <button className="q-icon-btn" onClick={() => move(idx, 1)} disabled={idx === q.items.length - 1} title="下移">
                      <span className="material-symbols-outlined">arrow_downward</span>
                    </button>
                    <button className="q-icon-btn" onClick={() => setDelTarget(it)} title="从队列移除">
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* 添加音效弹窗（按场景分组：预设 + 自定义混音，多选） */}
      {addOpen && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAddOpen(false)}>
          <div className="dialog q-add-dialog">
            <div className="dialog-header">添加音效到队列</div>
            <div className="dialog-body">
              <div className="q-add-list">
                {groups.map((g) => (
                  <div key={g.scene.id}>
                    <div className="q-add-scene">
                      <span className="material-symbols-outlined">{g.scene.icon}</span>
                      {g.scene.label}
                    </div>
                    {g.opts.map((opt) => (
                      <label key={opt.key} className="q-add-item">
                        <input
                          type="checkbox"
                          checked={picked.has(opt.key)}
                          onChange={(e) => {
                            const next = new Set(picked)
                            if (e.target.checked) next.add(opt.key)
                            else next.delete(opt.key)
                            setPicked(next)
                          }}
                        />
                        <span className="q-add-kind">{opt.kind === 'preset' ? '预设' : '混音'}</span>
                        <span className="q-add-name">{opt.label}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
              <div className="q-add-minutes">
                统一时长：
                <select value={String(addMinutes)} onChange={(e) => setAddMinutes(Number(e.target.value))}>
                  {PRESET_MINUTES.map((m) => (
                    <option key={m} value={m}>
                      {m} 分钟
                    </option>
                  ))}
                </select>
                （加入后可逐行改）
              </div>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAddOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={commitAdd}>
                添加{picked.size > 0 ? `（${picked.size} 项）` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 移除二次确认（全局硬性规则：删除操作二次确认；仅从队列移除，不动音效本身） */}
      <ConfirmDialog
        open={!!delTarget}
        title="从队列移除"
        danger
        confirmText="移除"
        onConfirm={() => {
          if (delTarget) update(q.items.filter((it) => it.id !== delTarget.id))
          setDelTarget(null)
        }}
        onCancel={() => setDelTarget(null)}
      >
        确定把「{delTarget ? describe(delTarget).text : ''}」从播放队列移除吗？（音效本身不受影响）
      </ConfirmDialog>
    </div>
  )
}
