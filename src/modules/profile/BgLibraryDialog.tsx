// 背景素材库管理弹窗（优化建议区第36轮）：浅色/深色两组独立，上传/切换/删除
import { useCallback, useEffect, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useAppSettings } from '../../theme/ThemeProvider'
import './BgLibraryDialog.css'

export interface BgLibraryDialogProps {
  open: boolean
  onClose: () => void
}

export default function BgLibraryDialog(props: BgLibraryDialogProps) {
  const { toast } = useToast()
  // settings 由 refreshBg 全量刷新——use/delete 后 using 值随之更新
  const { settings, refreshBg, theme } = useAppSettings()
  // 打开时默认选中当前主题对应的组
  const [group, setGroup] = useState<'light' | 'dark'>(theme)
  const [files, setFiles] = useState<string[]>([])
  const [delTarget, setDelTarget] = useState<string | null>(null)
  const using = settings[`bg_bg-${group}`] ?? ''

  const load = useCallback(async () => {
    try {
      setFiles(await window.api.image.bgList(group))
    } catch {
      setFiles([]) // 扫描异常 → 空态
    }
  }, [group])

  useEffect(() => {
    if (props.open) void load()
  }, [props.open, load])

  if (!props.open) return null

  const doUpload = async (): Promise<void> => {
    try {
      const r = await window.api.image.bgUpload(group)
      if (!r) return // 用户取消系统对话框
      setFiles(r.list)
      if (r.applied) {
        await refreshBg()
        toast('已上传并设为当前背景')
      } else {
        toast('已加入素材库')
      }
    } catch (e) {
      toast((e as Error).message || '上传失败')
    }
  }

  const doUse = async (file: string): Promise<void> => {
    const ok = await window.api.image.bgUse(group, file)
    if (ok) {
      await refreshBg()
      toast('已设为当前背景')
    } else {
      toast('设置失败')
      void load()
    }
  }

  const doDelete = async (): Promise<void> => {
    if (!delTarget) return
    try {
      const r = await window.api.image.bgDelete(group, delTarget)
      setFiles(r.list)
      if (r.wasUsing) {
        await refreshBg()
        toast('已删除，回退纯色背景')
      } else {
        toast('已删除')
      }
    } catch {
      toast('删除失败')
    }
    setDelTarget(null)
  }

  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog bg-lib-dialog" style={{ width: 640 }}>
        <div className="dialog-header">背景素材库</div>
        <div className="dialog-body">
          <div className="recycle-tabs">
            <button
              className={`recycle-tab${group === 'light' ? ' active' : ''}`}
              onClick={() => setGroup('light')}
            >
              浅色模式
            </button>
            <button
              className={`recycle-tab${group === 'dark' ? ' active' : ''}`}
              onClick={() => setGroup('dark')}
            >
              深色模式
            </button>
          </div>
          {files.length === 0 ? (
            <div className="bg-lib-empty">
              <span>还没有背景素材，上传一张试试</span>
              <button className="btn btn-primary" onClick={() => void doUpload()}>
                <span className="material-symbols-outlined">upload</span>
                上传
              </button>
            </div>
          ) : (
            <div className="bg-lib-grid">
              {files.map((f) => (
                <div key={f} className={`bg-lib-item${using === f ? ' using' : ''}`}>
                  <img src={`bzres://bg/${group}/${f}`} alt={f} onClick={() => void doUse(f)} />
                  {using === f && <span className="bg-lib-using">使用中</span>}
                  <button className="bg-lib-del" title="删除" onClick={() => setDelTarget(f)}>
                    <span className="material-symbols-outlined">delete</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={props.onClose}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={() => void doUpload()}>
            <span className="material-symbols-outlined">upload</span>
            上传
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={delTarget != null}
        title="删除背景素材"
        danger
        confirmText="删除"
        onCancel={() => setDelTarget(null)}
        onConfirm={() => void doDelete()}
      >
        {delTarget != null && using === delTarget
          ? '该图正在使用，删除后回退纯色背景。确定删除？'
          : '确定删除这张背景素材？'}
      </ConfirmDialog>
    </div>
  )
}
