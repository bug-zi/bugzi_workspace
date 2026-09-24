// 阅读视图（specs §2 CopyReader）：满栏正文 + 阶段导航 + 进度记忆（3 秒节流）+ 读毕打卡。
// 三入口共用：每日选定 / 收藏库点行 / DIY 完成。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ConfirmDialog from '../../components/ConfirmDialog'
import MdDialog from '../../components/MdDialog'
import { useToast } from '../../components/Toast'
import type { CopyDetail } from '../../shared/types'

interface Stage {
  title: string
  body: string
}

/** 正文解析：## 阶段切分（生成与内置种子同构：# 标题 + > 副标题 + ## 阶段 × N） */
function parseStages(md: string): { intro: string; stages: Stage[] } {
  const lines = md.split('\n')
  const introLines: string[] = []
  const stages: Stage[] = []
  let cur: Stage | null = null
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/)
    if (m) {
      cur = { title: m[1].trim(), body: '' }
      stages.push(cur)
    } else if (cur) {
      cur.body += line + '\n'
    } else {
      introLines.push(line)
    }
  }
  return { intro: introLines.join('\n').trim(), stages }
}

const SAVE_INTERVAL_MS = 3000

export default function CopyReader(props: { id: number; onBack: () => void }) {
  const { id, onBack } = props
  const { toast } = useToast()
  const [detail, setDetail] = useState<CopyDetail | null>(null)
  const [md, setMd] = useState('')
  const [loadFail, setLoadFail] = useState<string | null>(null)
  const [curStage, setCurStage] = useState(0)
  const [showFinish, setShowFinish] = useState(false)
  const [confirmFinish, setConfirmFinish] = useState(false)
  const [docOpen, setDocOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stageRefs = useRef<(HTMLDivElement | null)[]>([])
  const lastSaveRef = useRef(0)

  const parsed = useMemo(() => parseStages(md), [md])
  const stages = parsed.stages

  useEffect(() => {
    let alive = true
    void window.api.copy
      .read(id)
      .then((r) => {
        if (!alive) return
        setDetail(r.detail)
        setMd(r.md)
        // 恢复进度：滚到上次所在章（ratio 精度不用于恢复，章级足够）
        const stage = r.detail.progress?.stage ?? 0
        requestAnimationFrame(() => {
          stageRefs.current[stage]?.scrollIntoView({ block: 'start' })
        })
      })
      .catch((e) => setLoadFail((e as Error).message))
    return () => {
      alive = false
    }
  }, [id])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || stages.length === 0) return
    // 当前章：最后一个顶边已越过视口上缘 1/3 的阶段
    let idx = 0
    stageRefs.current.forEach((node, i) => {
      if (node && node.getBoundingClientRect().top < window.innerHeight / 3) idx = i
    })
    setCurStage(idx)
    const nearEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - el.clientHeight * 0.08
    setShowFinish(nearEnd)
    // 3 秒节流落库
    const now = Date.now()
    if (now - lastSaveRef.current >= SAVE_INTERVAL_MS) {
      lastSaveRef.current = now
      const ratio = el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 1
      void window.api.copy.saveProgress(id, { stage: idx, ratio })
    }
  }, [id, stages.length])

  const jumpTo = (i: number): void => {
    stageRefs.current[i]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const finish = async (keep: boolean): Promise<void> => {
    try {
      await window.api.copy.finish(id, keep)
      const isDaily = detail?.source !== 'official'
      if (keep) toast(isDaily ? '已存档，今日打卡完成' : '已存档')
      else toast(isDaily ? '已读毕并丢弃，今日打卡完成' : '已读毕并丢弃')
      onBack()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setConfirmFinish(false)
    }
  }

  if (loadFail) {
    return (
      <div className="fuben-reader">
        <div className="fuben-reader-top">
          <button className="fuben-btn-ghost" onClick={onBack}>
            <span className="material-symbols-outlined">arrow_back</span> 返回
          </button>
        </div>
        <div className="fuben-empty">打开失败：{loadFail}</div>
      </div>
    )
  }

  return (
    <div className="fuben-reader">
      <div className="fuben-reader-top">
        <button className="fuben-btn-ghost" onClick={onBack}>
          <span className="material-symbols-outlined">arrow_back</span> 返回
        </button>
        <div className="fuben-reader-headline">
          <span className="fuben-reader-title">{detail?.title ?? '…'}</span>
          {detail?.subtitle && <span className="fuben-reader-sub">{detail.subtitle}</span>}
        </div>
        <span className="fuben-reader-progress">
          第 {curStage + 1}/{stages.length || detail?.stageCount || '?'} 章
        </span>
        <button className="fuben-btn-ghost" title="在弹窗中打开" onClick={() => setDocOpen(true)}>
          <span className="material-symbols-outlined">description</span>
        </button>
      </div>

      <div className="fuben-reader-body">
        {stages.length > 0 && (
          <aside className="fuben-toc">
            {stages.map((s, i) => (
              <button key={i} className={`fuben-toc-item${i === curStage ? ' active' : ''}`} onClick={() => jumpTo(i)}>
                {s.title}
              </button>
            ))}
          </aside>
        )}
        <div className="fuben-reader-scroll" ref={scrollRef} onScroll={onScroll}>
          <h1 className="fuben-doc-title">{detail?.title}</h1>
          {detail?.subtitle && <div className="fuben-doc-sub">{detail.subtitle}</div>}
          {stages.map((s, i) => (
            <div key={i} ref={(node) => {
              stageRefs.current[i] = node
            }} className="fuben-stage">
              <h2>{s.title}</h2>
              <p>{s.body.trim()}</p>
            </div>
          ))}
        </div>
      </div>

      {showFinish && (
        <button className="fuben-finish-btn" onClick={() => setConfirmFinish(true)}>
          <span className="material-symbols-outlined">done_all</span> 读毕
        </button>
      )}

      <ConfirmDialog
        open={confirmFinish}
        title="读完这段人生"
        confirmText="存档入库"
        onConfirm={() => void finish(true)}
        onCancel={() => setConfirmFinish(false)}
      >
        确定读毕《{detail?.title ?? ''}》了吗？读毕后这段人生：存档进收藏库，或直接丢弃（3 天内可在回收站反悔）。
        {detail?.source !== 'official' && ' 无论存档还是丢弃，都算完成今日副本打卡。'}
        <div className="fuben-discard-row">
          <button className="fuben-btn-ghost" onClick={() => void finish(false)}>
            <span className="material-symbols-outlined">delete_sweep</span> 不要了，直接丢弃
          </button>
        </div>
      </ConfirmDialog>

      <MdDialog
        key={detail?.mdPath ?? 'none'}
        open={docOpen}
        title={detail?.title ?? ''}
        subtitle={detail?.subtitle}
        filePath={detail?.mdPath ?? ''}
        onClose={() => setDocOpen(false)}
      />
    </div>
  )
}
