// 轻音乐面板（音乐吧设计 §四）：歌单条（全部+歌单+新建/改名/删除）+ 曲目列表 + 底部控制条。
// 播放上下文 = 当前视图曲目序（按加入时间）；互斥/恢复/持久化等全局行为全在 musicEngine。
import { useCallback, useEffect, useSyncExternalStore, useState } from 'react'
import { musicEngine } from '../../services/musicEngine'
import { useToast } from '../../components/Toast'
import ConfirmDialog from '../../components/ConfirmDialog'
import type { MusicLoopMode, MusicPlaylistRow, MusicTrackRow } from '../../shared/types'

function fmtSec(s: number | null): string {
  if (s == null || !Number.isFinite(s)) return '--:--'
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

const LOOP_NEXT: Record<MusicLoopMode, MusicLoopMode> = {
  'list-loop': 'single-loop',
  'single-loop': 'random',
  random: 'list-loop'
}
const LOOP_ICON: Record<MusicLoopMode, string> = {
  'list-loop': 'repeat',
  'single-loop': 'repeat_one',
  random: 'shuffle'
}
const LOOP_LABEL: Record<MusicLoopMode, string> = {
  'list-loop': '列表循环',
  'single-loop': '单曲循环',
  random: '随机播放'
}

export default function MusicPanel() {
  const { toast } = useToast()
  useSyncExternalStore(musicEngine.subscribe, musicEngine.getSnapshot)
  const st = musicEngine.getState()

  const [playlists, setPlaylists] = useState<MusicPlaylistRow[]>([])
  const [tracks, setTracks] = useState<MusicTrackRow[]>([])
  const [view, setView] = useState<number | 'all'>('all')
  const [loaded, setLoaded] = useState(false)
  // 弹窗/菜单
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [renameTarget, setRenameTarget] = useState<MusicPlaylistRow | null>(null)
  const [renameName, setRenameName] = useState('')
  const [delPlaylist, setDelPlaylist] = useState<MusicPlaylistRow | null>(null)
  const [delTrack, setDelTrack] = useState<MusicTrackRow | null>(null)
  const [moveMenu, setMoveMenu] = useState<{ track: MusicTrackRow; left: number; top: number } | null>(null)
  // 进度拖拽中不与 timeupdate 抢值
  const [dragging, setDragging] = useState(false)
  const [dragVal, setDragVal] = useState(0)

  const load = useCallback(async (): Promise<void> => {
    const r = await window.api.music.list()
    setPlaylists(r.playlists)
    setTracks(r.tracks)
    musicEngine.setCatalog(r.tracks.map((t) => ({ id: t.id, title: t.title })))
  }, [])

  useEffect(() => {
    void load()
      .catch(() => toast('轻音乐曲库加载失败'))
      .finally(() => setLoaded(true))
    musicEngine.onNotice = (msg) => toast(msg)
    return () => {
      musicEngine.onNotice = null
    }
  }, [load, toast])

  const curViewTracks = view === 'all' ? tracks : tracks.filter((t) => t.playlist_id === view)
  const viewIds = curViewTracks.map((t) => t.id)

  const onPlayTrack = (t: MusicTrackRow): void => {
    if (st.trackId === t.id) {
      void musicEngine.toggle()
      return
    }
    void musicEngine.playContext(viewIds, t.id)
  }

  const doImport = async (): Promise<void> => {
    const s = await window.api.music.importDialog()
    if (s.imported + s.skipped + s.failed === 0) return // 用户取消
    const parts = [`导入 ${s.imported}`]
    if (s.skipped) parts.push(`重复跳过 ${s.skipped}`)
    if (s.failed) parts.push(`失败 ${s.failed}`)
    toast(parts.join(' · '))
    await load()
  }

  const doAddPlaylist = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    try {
      await window.api.music.playlistCreate(name)
      setAddOpen(false)
      setNewName('')
      await load()
      toast('歌单已创建')
    } catch {
      toast('该歌单名已存在')
    }
  }

  const doRename = async (): Promise<void> => {
    if (!renameTarget) return
    const name = renameName.trim()
    if (!name) return
    try {
      await window.api.music.playlistRename(renameTarget.id, name)
      setRenameTarget(null)
      await load()
    } catch {
      toast('该歌单名已存在')
    }
  }

  const doDelPlaylist = async (): Promise<void> => {
    if (!delPlaylist) return
    await window.api.music.playlistDelete(delPlaylist.id)
    setDelPlaylist(null)
    if (view === delPlaylist.id) setView('all')
    await load()
    toast('歌单已删除，曲目移入未分组')
  }

  const doDelTrack = async (): Promise<void> => {
    if (!delTrack) return
    await window.api.music.trackDelete(delTrack.id)
    setDelTrack(null)
    await load()
    toast('已彻底删除（含音频文件）')
  }

  const doMove = async (trackId: number, playlistId: number | null): Promise<void> => {
    await window.api.music.trackMove(trackId, playlistId)
    setMoveMenu(null)
    await load()
  }

  const cur = st.trackId
  const playingTrack = cur != null ? tracks.find((t) => t.id === cur) : null

  return (
    <div className="music-panel">
      {/* 工具行：导入 + 歌单条 */}
      <div className="card" style={{ padding: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={() => void doImport()}>
          <span className="material-symbols-outlined">playlist_add</span>
          导入 mp3
        </button>
        <div className="recycle-tabs" style={{ flex: 1, flexWrap: 'wrap' }}>
          <button className={`recycle-tab${view === 'all' ? ' active' : ''}`} onClick={() => setView('all')}>
            全部
            <span className="zone-count">{tracks.length}</span>
          </button>
          {playlists.map((p) => (
            <button key={p.id} className={`recycle-tab${view === p.id ? ' active' : ''}`} onClick={() => setView(p.id)}>
              {p.name}
              <span className="zone-count">{tracks.filter((t) => t.playlist_id === p.id).length}</span>
            </button>
          ))}
          {typeof view === 'number' && (
            <>
              <button
                className="icon-btn"
                title="歌单改名"
                onClick={() => {
                  const p = playlists.find((x) => x.id === view)
                  if (p) {
                    setRenameTarget(p)
                    setRenameName(p.name)
                  }
                }}
              >
                <span className="material-symbols-outlined">edit</span>
              </button>
              <button
                className="icon-btn danger"
                title="删除歌单（曲目移入未分组）"
                onClick={() => setDelPlaylist(playlists.find((x) => x.id === view) ?? null)}
              >
                <span className="material-symbols-outlined">delete</span>
              </button>
            </>
          )}
          <button className="recycle-tab" title="新建歌单" onClick={() => setAddOpen(true)}>
            <span className="material-symbols-outlined">add</span>
          </button>
        </div>
      </div>

      {/* 曲目列表 */}
      <div className="zone">
        <div className="zone-header" style={{ cursor: 'default' }}>
          <span className="material-symbols-outlined">library_music</span>
          <span>{view === 'all' ? '全部曲目' : playlists.find((p) => p.id === view)?.name ?? '歌单'}</span>
          <span className="zone-count">{curViewTracks.length}</span>
        </div>
        <div className="zone-body">
          {!loaded && <div className="empty-state">加载中…</div>}
          {loaded && curViewTracks.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">music_note</span>
              {view === 'all' ? '还没有曲目，点「导入 mp3」添加轻音乐' : '歌单还是空的，从曲目行「加入歌单」归入'}
            </div>
          )}
          {curViewTracks.map((t) => (
            <div className="row-item" key={t.id} onClick={() => onPlayTrack(t)}>
              <span
                className={`material-symbols-outlined${st.trackId === t.id && st.playing ? ' noise-playing' : ''}`}
              >
                {st.trackId === t.id ? (st.playing ? 'pause_circle' : 'play_circle') : 'play_arrow'}
              </span>
              <div className="row-main">
                <div className="row-title">{t.title}</div>
                <div className="row-sub">
                  {fmtSec(t.duration_sec)}
                  {t.playlist_id != null && ` · ${playlists.find((p) => p.id === t.playlist_id)?.name ?? ''}`}
                </div>
              </div>
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-btn"
                  title="加入歌单"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setMoveMenu({ track: t, left: r.right, top: r.bottom + 4 })
                  }}
                >
                  <span className="material-symbols-outlined">playlist_add</span>
                </button>
                <button className="icon-btn danger" title="彻底删除（含文件）" onClick={() => setDelTrack(t)}>
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 底部控制条 */}
      <div className="card music-controls" style={{ padding: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="icon-btn" title="上一首" onClick={() => void musicEngine.prev()}>
          <span className="material-symbols-outlined">skip_previous</span>
        </button>
        <button
          className="btn btn-primary"
          title={st.playing ? '暂停' : '播放'}
          disabled={st.trackId == null}
          onClick={() => void musicEngine.toggle()}
        >
          <span className="material-symbols-outlined">{st.playing ? 'pause' : 'play_arrow'}</span>
        </button>
        <button className="icon-btn" title="下一首" onClick={() => void musicEngine.next()}>
          <span className="material-symbols-outlined">skip_next</span>
        </button>
        <span className="module-sub" style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {fmtSec(dragging ? dragVal : st.positionSec)}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(Math.floor(st.durationSec), 1)}
          value={Math.floor(dragging ? dragVal : st.positionSec)}
          disabled={st.trackId == null}
          style={{ flex: 1, minWidth: 120 }}
          title="播放进度"
          onChange={(e) => {
            setDragging(true)
            setDragVal(Number(e.target.value))
          }}
          onPointerUp={() => {
            musicEngine.seek(dragVal)
            setDragging(false)
          }}
          onKeyUp={() => {
            musicEngine.seek(dragVal)
            setDragging(false)
          }}
        />
        <span className="module-sub" style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {fmtSec(st.durationSec)}
        </span>
        <button
          className="icon-btn"
          title={LOOP_LABEL[st.loopMode]}
          onClick={() => musicEngine.setLoopMode(LOOP_NEXT[st.loopMode])}
        >
          <span className="material-symbols-outlined">{LOOP_ICON[st.loopMode]}</span>
        </button>
        <span className="material-symbols-outlined" title="音量">
          {st.volume === 0 ? 'volume_off' : st.volume < 50 ? 'volume_down' : 'volume_up'}
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={st.volume}
          style={{ width: 90 }}
          title={`音量 ${st.volume}%`}
          onChange={(e) => musicEngine.setVolume(Number(e.target.value))}
        />
      </div>
      {playingTrack && (
        <div className="module-sub" style={{ marginTop: 6, textAlign: 'center' }}>
          正在播放：{playingTrack.title}
        </div>
      )}

      {/* 新建歌单 */}
      {addOpen && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAddOpen(false)}>
          <div className="dialog" style={{ width: 360 }}>
            <div className="dialog-header">新建歌单</div>
            <div className="dialog-body">
              <input
                className="field"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="歌单名"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) void doAddPlaylist()
                }}
              />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAddOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" disabled={!newName.trim()} onClick={() => void doAddPlaylist()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 歌单改名 */}
      {renameTarget && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setRenameTarget(null)}>
          <div className="dialog" style={{ width: 360 }}>
            <div className="dialog-header">歌单改名</div>
            <div className="dialog-body">
              <input className="field" value={renameName} onChange={(e) => setRenameName(e.target.value)} />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setRenameTarget(null)}>
                取消
              </button>
              <button className="btn btn-primary" disabled={!renameName.trim()} onClick={() => void doRename()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删歌单（曲回未分组） */}
      {delPlaylist && (
        <ConfirmDialog
          open
          title="删除歌单"
          confirmText="删除"
          danger
          onConfirm={() => void doDelPlaylist()}
          onCancel={() => setDelPlaylist(null)}
        >
          歌单「{delPlaylist.name}」将被删除，曲目会移入未分组（不删曲、不删文件）。
        </ConfirmDialog>
      )}

      {/* 删曲目（彻底删连文件） */}
      {delTrack && (
        <ConfirmDialog
          open
          title="彻底删除曲目"
          confirmText="删除"
          danger
          onConfirm={() => void doDelTrack()}
          onCancel={() => setDelTrack(null)}
        >
          「{delTrack.title}」将连音频文件一起彻底删除，不入回收站，确定？
        </ConfirmDialog>
      )}

      {/* 加入歌单菜单 */}
      {moveMenu && (
        <>
          <div className="dialog-overlay" style={{ background: 'transparent' }} onMouseDown={() => setMoveMenu(null)} />
          <div
            className="ctx-menu"
            style={{ position: 'fixed', top: moveMenu.top, left: Math.max(8, moveMenu.left - 150), zIndex: 300 }}
          >
            {playlists.length === 0 && <div className="module-sub" style={{ padding: '5px 8px' }}>还没有歌单</div>}
            {playlists.map((p) => (
              <button key={p.id} className="btn btn-ghost" onClick={() => void doMove(moveMenu.track.id, p.id)}>
                <span className="material-symbols-outlined">queue_music</span>
                {p.name}
              </button>
            ))}
            {moveMenu.track.playlist_id != null && (
              <button className="btn btn-ghost" onClick={() => void doMove(moveMenu.track.id, null)}>
                <span className="material-symbols-outlined">playlist_remove</span>
                移出歌单（回未分组）
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
