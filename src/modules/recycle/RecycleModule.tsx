// 回收站模块（回收站 specs 全量）：恢复/彻底删除、剩余存活时间。
// 260926 优化建议区第58轮：15 个来源页签行删除，改「全部」时间倒序混排 + 头部来源筛选下拉（每项带计数）。
// 260927 模式视图：再叠学习/生活两档（常驻来源双视图都显示），默认跟随左栏模式、页内分段可切换。
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RecycleRow } from '../../renderer/api'
import type { ModuleMode } from '../../shared/types'
import ActionMenu from '../../components/ActionMenu'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'

// 筛选 key：单一来源用 source 值；「推理角」为组筛选（reasoning_soup 汤 + reasoning_game
// 对局记录混排一页，specs §5）。260908 辩真阁并入万象库：verify 来源聚合进「万象库」块，页签九块变八块；
// 其后画布（canvases）加入回九块；260911 学习库接入：learn 块居首（位次随左栏），页签九块变十块；
// 260917 AI 会话归档（优化建议区第47轮）：跨模块块置末位。
const TABS: { key: string; label: string }[] = [
  { key: 'learn', label: '学习库' },
  { key: 'interview', label: '面试题库' },
  { key: 'mottos', label: '格言库' },
  { key: 'wiki', label: '万象库' },
  { key: 'inspirations', label: '灵感泉' },
  { key: 'zhijiji', label: '致知己' },
  { key: 'reasoning', label: '推理角' },
  { key: 'fuben', label: '副本库' },
  { key: 'yule', label: '娱乐城' },
  { key: 'drafts', label: '草稿本' },
  { key: 'canvases', label: '画布' },
  { key: 'wenbi', label: '文笔坊' },
  { key: 'ledger', label: '记账本' },
  { key: 'fushi', label: '赋诗苑' },
  { key: 'duiyi', label: '对弈社' },
  { key: 'ai', label: 'AI 会话' }
]

/** 行属于哪个页签（推理角两来源同组；文笔坊两来源同组；记账本三来源同组；辩真并入万象库块；预言家/十二问题并入致知己块） */
function tabOf(source: RecycleRow['source']): string {
  if (source === 'reasoning_soup' || source === 'reasoning_game') return 'reasoning'
  if (source === 'interview_q') return 'interview'
  if (source === 'fushi_poem' || source === 'fushi_game') return 'fushi'
  if (source === 'yule_taro' || source === 'yule_poker') return 'yule'
  if (source === 'wenbi_journal' || source === 'wenbi_article' || source === 'wenbi_exp') return 'wenbi'
  if (source === 'ledger_tx' || source === 'ledger_account' || source === 'ledger_category') return 'ledger'
  if (source === 'verify') return 'wiki'
  if (source === 'qa') return 'wiki'
  if (source === 'prophet' || source === 'twelve_question') return 'zhijiji'
  if (source === 'ai_session') return 'ai'
  return source
}

/** 来源组 → 模式归属（260927 模式视图）：'both' = 常驻来源（上固定/右栏模块产物，学习/生活两档视图都显示） */
const GROUP_MODE: Record<string, 'learn' | 'life' | 'both'> = {
  learn: 'learn',
  interview: 'learn',
  wiki: 'learn',
  inspirations: 'learn',
  zhijiji: 'learn',
  reasoning: 'life',
  fuben: 'life',
  yule: 'life',
  ledger: 'life',
  fushi: 'life',
  duiyi: 'life',
  mottos: 'both',
  wenbi: 'both',
  drafts: 'both',
  canvases: 'both',
  ai: 'both'
}

/** 恢复去向文案（specs §5：汤回汤库、对局记录回记录列表） */
function backToOf(source: RecycleRow['source']): string {
  switch (source) {
    case 'learn':
      return '原主题'
    case 'interview_q':
      return '题库原分类'
    case 'mottos':
      return '格言库草稿区'
    case 'wiki':
      return '原板块'
    case 'inspirations':
      return '灵感泉草稿区'
    case 'verify':
      return '万象库·辩真历史记录'
    case 'qa':
      return '万象库·问答历史'
    case 'ai_session':
      return 'AI 边栏原频道会话列表'
    case 'zhijiji':
      return '致知己主列表'
    case 'prophet':
      return '致知己·预言家列表'
    case 'twelve_question':
      return '致知己·十二问题列表'
    case 'reasoning_soup':
      return '推理角汤库'
    case 'fuben':
      return '副本库收藏库'
    case 'drafts':
      return '草稿本原频道'
    case 'canvases':
      return '画布面板'
    case 'wenbi_journal':
      return '浮生记时间线'
    case 'wenbi_article':
      return '写作台构思区'
    case 'wenbi_exp':
      return '经验书列表'
    case 'ledger_tx':
      return '记账本月度列表'
    case 'ledger_account':
      return '记账本账户列表'
    case 'ledger_category':
      return '记账本分类列表'
    case 'fushi_poem':
      return '赋诗苑诗集'
    case 'fushi_game':
      return '赋诗苑对局历史'
    case 'yule_taro':
      return '娱乐城塔罗记录列表'
    case 'yule_poker':
      return '娱乐城对局记录列表'
    case 'duiyi':
      return '对弈社记录列表'
    default:
      return '推理角对局记录列表'
  }
}

/** 来源板块小字（文笔坊页签内区分两板块；记账本页签内区分流水/账户/分类；辩真并入万象库块后区分词条/记录） */
function srcTag(source: RecycleRow['source']): string {
  if (source === 'learn') return '知识点 · '
  if (source === 'interview_q') return '面试题 · '
  if (source === 'wenbi_journal') return '浮生记 · '
  if (source === 'wenbi_article') return '文章 · '
  if (source === 'wenbi_exp') return '经验书 · '
  if (source === 'ledger_tx') return '流水 · '
  if (source === 'ledger_account') return '账户 · '
  if (source === 'ledger_category') return '分类 · '
  if (source === 'verify') return '辩真 · '
  if (source === 'qa') return '问答 · '
  if (source === 'prophet') return '预言 · '
  if (source === 'twelve_question') return '十二问题 · '
  if (source === 'ai_session') return 'AI 会话 · '
  if (source === 'fushi_poem') return '诗作 · '
  if (source === 'fushi_game') return '对局 · '
  if (source === 'yule_taro') return '塔罗解读 · '
  if (source === 'yule_poker') return '德扑对局 · '
  if (source === 'duiyi') return '对局 · '
  return ''
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 对弈社棋种中文名（回收站摘要用） */
const DUIYI_GAME_ZH: Record<string, string> = {
  xiangqi: '中国象棋',
  chess: '国际象棋',
  shogi: '日本将棋',
  gomoku: '五子棋',
  go: '围棋'
}

/** 彻底删除时间点 = 入站时间 + 3 天（与 recycle.cleanupExpired 的清理口径一致） */
function purgeTime(createdAt: string): string {
  return fmtTime(new Date(new Date(createdAt).getTime() + 3 * DAY_MS).toISOString())
}

/** 摘要（各来源 payload 快照提取） */
function summaryOf(row: RecycleRow): string {
  try {
    const p = JSON.parse(row.payload) as Record<string, unknown>
    if (row.source === 'learn') return `${p.title ?? ''}｜${p.summary ?? ''}`
    if (row.source === 'interview_q') return String(p.question ?? '')
    if (row.source === 'mottos') return String(p.content ?? '')
    if (row.source === 'wiki') return `${p.term ?? ''}｜${p.summary ?? ''}`
    if (row.source === 'inspirations') return String(p.title ?? '')
    if (row.source === 'zhijiji') return String(p.title ?? '')
    if (row.source === 'prophet') return String(p.claim ?? '')
    if (row.source === 'qa') return String(p.question ?? '')
    if (row.source === 'twelve_question') return String(p.title ?? '')
    if (row.source === 'ai_session') {
      const ch = String(p.channel ?? '')
      const chLabel =
        ch === 'learn'
          ? '学习'
          : ch === 'wiki'
            ? '万象'
            : ch === 'zhijiji'
              ? '致知己'
              : ch === 'assistant'
                ? '助手'
                : ch || 'AI'
      return `${p.title ?? ''}（${chLabel}频道）`
    }
    if (row.source === 'reasoning_soup') return `《${p.title ?? ''}》（汤）`
    if (row.source === 'reasoning_game') return `《${p.title ?? ''}》· 对局记录`
    if (row.source === 'fushi_poem') return String(p.title ?? '')
    if (row.source === 'fushi_game') return `「${p.topic ?? ''}」${p.type === 'doushi' ? '斗诗' : '飞花令'}记录`
    if (row.source === 'yule_taro') {
      const q = String(p.question ?? '')
      return q || `${p.spread === 'three' ? '三张 · 过去现在未来' : '单张 · 每日指引'} · ${String(p.created_at ?? '').slice(0, 10)}`
    }
    if (row.source === 'yule_poker') {
      const rank = ['冠军', '亚军', '季军', '第四名'][Number(p.my_rank ?? 4) - 1] ?? '第四名'
      return `${rank} · 奖励 ${Number(p.prize ?? 0)} · ${Number(p.hands_count ?? 0)} 手`
    }
    if (row.source === 'duiyi') {
      const gameZh = DUIYI_GAME_ZH[String(p.game ?? '')] ?? String(p.game ?? '')
      const res = p.result === 'win' ? '胜' : p.result === 'loss' ? '负' : p.result === 'draw' ? '和' : ''
      return `${gameZh} · ${res}${p.reason ? ` · ${String(p.reason)}` : ''} · ${Number(p.move_count ?? 0)} 手`
    }
    if (row.source === 'drafts') return String(p.title ?? '')
    if (row.source === 'canvases') return String(p.title ?? '')
    if (row.source === 'wenbi_journal') {
      const d = new Date(String(p.created_at ?? ''))
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} 的记录`
    }
    if (row.source === 'wenbi_article') return String(p.title ?? '')
    if (row.source === 'wenbi_exp') return String(p.content ?? '')
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

export default function RecycleModule({ appMode }: { appMode: ModuleMode }) {
  const { toast } = useToast()
  const [rows, setRows] = useState<RecycleRow[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [viewMode, setViewMode] = useState<ModuleMode>('learn')
  const [filterMenuAnchor, setFilterMenuAnchor] = useState<HTMLElement | null>(null)
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

  // 视图跟随左栏当前模式（keep-alive 下 prop 变化即跟随，启动恢复 life 也走这里）；页内分段切换只改本页显示、不动全局
  useEffect(() => {
    setViewMode(appMode)
  }, [appMode])

  // 当前视图可见行：按模式归属过滤，常驻组双视图都显示（260927 模式视图）
  const viewRows = useMemo(
    () =>
      rows.filter((r) => {
        const g = tabOf(r.source)
        return GROUP_MODE[g] === 'both' || GROUP_MODE[g] === viewMode
      }),
    [rows, viewMode]
  )

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of viewRows) {
      const k = tabOf(r.source)
      c[k] = (c[k] ?? 0) + 1
    }
    return c
  }, [viewRows])

  // 残留筛选容错：切视图后原筛选组不在当前视图时按「全部」处理（切回原视图时该选择自动恢复）
  const effFilter =
    filter === 'all' || GROUP_MODE[filter] === 'both' || GROUP_MODE[filter] === viewMode
      ? filter
      : 'all'

  const filteredRows = effFilter === 'all' ? viewRows : viewRows.filter((r) => tabOf(r.source) === effFilter)
  const activeFilterLabel = effFilter === 'all' ? '全部来源' : (TABS.find((t) => t.key === effFilter)?.label ?? '全部来源')

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
      </div>

      {/* 工具条：视图范围计数 + 模式分段切换（260927 模式视图）+ 来源筛选下拉（260926 第58轮） */}
      <div className="recycle-toolbar">
        <span className="module-sub">共 {viewRows.length} 条 · 存放 3 天后自动彻底删除</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="recycle-tabs">
            <button
              className={`recycle-tab${viewMode === 'learn' ? ' active' : ''}`}
              onClick={() => setViewMode('learn')}
              title="学习模式相关来源"
            >
              学习
            </button>
            <button
              className={`recycle-tab${viewMode === 'life' ? ' active' : ''}`}
              onClick={() => setViewMode('life')}
              title="生活模式相关来源"
            >
              生活
            </button>
          </div>
          <button className="btn" onClick={(e) => setFilterMenuAnchor(e.currentTarget)} title="按来源筛选">
            <span className="material-symbols-outlined">filter_list</span>
            {activeFilterLabel}
            <span className="material-symbols-outlined">expand_more</span>
          </button>
        </div>
      </div>

      {filterMenuAnchor && (
        <ActionMenu
          anchorEl={filterMenuAnchor}
          onClose={() => setFilterMenuAnchor(null)}
          items={[
            {
              key: 'all',
              icon: effFilter === 'all' ? 'check' : undefined,
              label: `全部来源（${viewRows.length}）`,
              onClick: () => setFilter('all')
            },
            ...TABS.filter((t) => GROUP_MODE[t.key] === 'both' || GROUP_MODE[t.key] === viewMode).map((t) => ({
              key: t.key,
              icon: effFilter === t.key ? 'check' : undefined,
              label: `${t.label}（${counts[t.key] ?? 0}）`,
              onClick: () => setFilter(t.key)
            }))
          ]}
        />
      )}

      <section className="zone">
        <div className="zone-body">
          {filteredRows.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">delete</span>
              {effFilter === 'all' ? '回收站是空的' : '该来源暂无内容'}
            </div>
          )}
          {filteredRows.map((r) => (
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
