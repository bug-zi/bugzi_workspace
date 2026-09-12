// 回收站模块（回收站 specs 全量）：五板块页签、恢复/彻底删除、剩余存活时间
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RecycleRow } from '../../renderer/api'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

// 页签 key：单一来源用 source 值；「推理角」为组页签（reasoning_soup 汤 + reasoning_game
// 对局记录混排一页，specs §5）。260908 辩真阁并入万象库：verify 来源聚合进「万象库」块，页签九块变八块；
// 其后画布（canvases）加入回九块；260911 学习库接入：learn 块居首（位次随左栏），页签九块变十块。
const TABS: { key: string; label: string }[] = [
  { key: 'learn', label: '学习库' },
  { key: 'mottos', label: '格言库' },
  { key: 'wiki', label: '万象库' },
  { key: 'inspirations', label: '灵感泉' },
  { key: 'zhijiji', label: '致知己' },
  { key: 'reasoning', label: '推理角' },
  { key: 'drafts', label: '草稿本' },
  { key: 'canvases', label: '画布' },
  { key: 'wenbi', label: '文笔坊' },
  { key: 'ledger', label: '记账本' }
]

/** 行属于哪个页签（推理角两来源同组；文笔坊两来源同组；记账本三来源同组；辩真并入万象库块；预言家/十二问题并入致知己块） */
function tabOf(source: RecycleRow['source']): string {
  if (source === 'reasoning_soup' || source === 'reasoning_game') return 'reasoning'
  if (source === 'wenbi_journal' || source === 'wenbi_article') return 'wenbi'
  if (source === 'ledger_tx' || source === 'ledger_account' || source === 'ledger_category') return 'ledger'
  if (source === 'verify') return 'wiki'
  if (source === 'prophet' || source === 'twelve_question') return 'zhijiji'
  return source
}

/** 恢复去向文案（specs §5：汤回汤库、对局记录回记录列表） */
function backToOf(source: RecycleRow['source']): string {
  switch (source) {
    case 'learn':
      return '原主题'
    case 'mottos':
      return '格言库草稿区'
    case 'wiki':
      return '原板块'
    case 'inspirations':
      return '灵感泉草稿区'
    case 'verify':
      return '万象库·辩真历史记录'
    case 'zhijiji':
      return '致知己主列表'
    case 'prophet':
      return '致知己·预言家列表'
    case 'twelve_question':
      return '致知己·十二问题列表'
    case 'reasoning_soup':
      return '推理角汤库'
    case 'drafts':
      return '草稿本原频道'
    case 'canvases':
      return '画布面板'
    case 'wenbi_journal':
      return '浮生记时间线'
    case 'wenbi_article':
      return '写作台构思区'
    case 'ledger_tx':
      return '记账本月度列表'
    case 'ledger_account':
      return '记账本账户列表'
    case 'ledger_category':
      return '记账本分类列表'
    default:
      return '推理角对局记录列表'
  }
}

/** 来源板块小字（文笔坊页签内区分两板块；记账本页签内区分流水/账户/分类；辩真并入万象库块后区分词条/记录） */
function srcTag(source: RecycleRow['source']): string {
  if (source === 'learn') return '知识点 · '
  if (source === 'wenbi_journal') return '浮生记 · '
  if (source === 'wenbi_article') return '文章 · '
  if (source === 'ledger_tx') return '流水 · '
  if (source === 'ledger_account') return '账户 · '
  if (source === 'ledger_category') return '分类 · '
  if (source === 'verify') return '辩真 · '
  if (source === 'prophet') return '预言 · '
  if (source === 'twelve_question') return '十二问题 · '
  return ''
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 彻底删除时间点 = 入站时间 + 3 天（与 recycle.cleanupExpired 的清理口径一致） */
function purgeTime(createdAt: string): string {
  return fmtTime(new Date(new Date(createdAt).getTime() + 3 * DAY_MS).toISOString())
}

/** 摘要（各来源 payload 快照提取） */
function summaryOf(row: RecycleRow): string {
  try {
    const p = JSON.parse(row.payload) as Record<string, unknown>
    if (row.source === 'learn') return `${p.title ?? ''}｜${p.summary ?? ''}`
    if (row.source === 'mottos') return String(p.content ?? '')
    if (row.source === 'wiki') return `${p.term ?? ''}｜${p.summary ?? ''}`
    if (row.source === 'inspirations') return String(p.title ?? '')
    if (row.source === 'zhijiji') return String(p.title ?? '')
    if (row.source === 'prophet') return String(p.claim ?? '')
    if (row.source === 'twelve_question') return String(p.title ?? '')
    if (row.source === 'reasoning_soup') return `《${p.title ?? ''}》（汤）`
    if (row.source === 'reasoning_game') return `《${p.title ?? ''}》· 对局记录`
    if (row.source === 'drafts') return String(p.title ?? '')
    if (row.source === 'canvases') return String(p.title ?? '')
    if (row.source === 'wenbi_journal') {
      const d = new Date(String(p.created_at ?? ''))
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} 的记录`
    }
    if (row.source === 'wenbi_article') return String(p.title ?? '')
    if (row.source === 'ledger_tx') {
      // 快照冗余显示名（账本 specs §5：入站前联表写入 payload）
      const cents = Number(p.amount_cents ?? 0) / 100
      const sign = p.type === 'expense' ? '-' : '+'
      return `${String(p.date ?? '')} ${String(p.category_name ?? '未分类')} ${sign}¥${cents.toFixed(2)}`
    }
    if (row.source === 'ledger_account') return `账户：${String(p.name ?? '')}`
    if (row.source === 'ledger_category') {
      return `${p.kind === 'expense' ? '支出' : '收入'}分类：${String(p.name ?? '')}`
    }
    return String(p.claim ?? '')
  } catch {
    return `#${row.item_id}`
  }
}

export default function RecycleModule() {
  const { toast } = useToast()
  const [rows, setRows] = useState<RecycleRow[]>([])
  const [tab, setTab] = useState<string>('mottos')
  const [delTarget, setDelTarget] = useState<RecycleRow | null>(null)
  // 刷新信号（其他模块丢弃时 recycle:changed 推送）
  const [version, setVersion] = useState(0)

  const load = useCallback(async () => {
    setRows(await window.api.recycle.list())
  }, [])

  useEffect(() => {
    void load()
    const off = window.api.item.onRecycleChanged(() => {
      setVersion((v) => v + 1)
    })
    return off
  }, [load])

  useEffect(() => {
    if (version > 0) void load()
  }, [version, load])

  // keep-alive：切回回收站时刷新（剩余天数文案需要随时间更新）
  useModuleActivated('recycle', () => void load())

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of rows) {
      const k = tabOf(r.source)
      c[k] = (c[k] ?? 0) + 1
    }
    return c
  }, [rows])

  const tabRows = rows.filter((r) => tabOf(r.source) === tab)

  const doRestore = async (row: RecycleRow): Promise<void> => {
    const backTo = backToOf(row.source)
    await window.api.recycle.restore(row.id)
    toast(`已恢复到${backTo}`)
    await load()
  }

  const doDelete = async (): Promise<void> => {
    if (!delTarget) return
    await window.api.recycle.delete(delTarget.id)
    toast('已彻底删除')
    setDelTarget(null)
    await load()
  }

  return (
    <div className="module-page">
      <div className="module-header">
        <span className="material-symbols-outlined">delete</span>
        <span className="module-title">回收站</span>
        <span className="module-sub">存放 3 天后自动彻底删除</span>
      </div>

      <div className="recycle-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`recycle-tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            <span className="zone-count">{counts[t.key] ?? 0}</span>
          </button>
        ))}
      </div>

      <section className="zone">
        <div className="zone-body">
          {tabRows.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">delete</span>
              暂无内容
            </div>
          )}
          {tabRows.map((r) => (
            <div className="row-item" key={r.id} style={{ cursor: 'default' }}>
              <div className="row-main">
                <div className="row-title" title={summaryOf(r)}>{summaryOf(r)}</div>
                <div className="row-sub" title="放入回收站时间 ｜ 彻底删除时间">
                  {srcTag(r.source)}
                  {fmtTime(r.created_at)} ｜ {purgeTime(r.created_at)}
                </div>
              </div>
              <div className="row-actions">
                <button
                  className="btn"
                  onClick={() => void doRestore(r)}
                  title={`恢复到${backToOf(r.source)}`}
                >
                  <span className="material-symbols-outlined">restore_from_trash</span>
                  恢复
                </button>
                <button className="btn btn-danger" onClick={() => setDelTarget(r)}>
                  <span className="material-symbols-outlined">delete_forever</span>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 彻底删除二次确认（specs §3） */}
      <ConfirmDialog
        open={delTarget != null}
        title="彻底删除"
        confirmText="彻底删除"
        danger
        onConfirm={() => void doDelete()}
        onCancel={() => setDelTarget(null)}
      >
        彻底删除后无法恢复，附属笔记/文档将一并删除。
      </ConfirmDialog>
    </div>
  )
}

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
