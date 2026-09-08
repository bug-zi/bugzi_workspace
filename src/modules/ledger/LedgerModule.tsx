// 账本（账本 specs §3）：单主视图一体页——卡片/占比条/流水列表 + 记一笔 + 管理
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LedgerAccountView, LedgerCategory, LedgerStats, LedgerTxView } from '../../shared/types'
import ConfirmDialog from '../../components/ConfirmDialog'
import ActionMenu from '../../components/ActionMenu'
import { useToast } from '../../components/Toast'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import TxDialog from './TxDialog'
import ManageDialog from './ManageDialog'
import './ledger.css'

/** 分转元展示（¥12,345.67） */
export function fmtCents(cents: number): string {
  return `¥${(cents / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

/** 今天 'YYYY-MM-DD' */
export function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function curMonth(): string {
  return todayStr().slice(0, 7)
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${y}年${m}月`
}

/** 组头日期称呼（今天/昨天/N月N日） */
function dayLabel(date: string): string {
  if (date === todayStr()) return '今天'
  const y = new Date()
  y.setDate(y.getDate() - 1)
  const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
  if (date === yesterday) return '昨天'
  const [, m, d] = date.split('-').map(Number)
  return `${m}月${d}日`
}

export default function LedgerModule() {
  const { toast } = useToast()
  const [month, setMonth] = useState(curMonth())
  /** 占比条下钻筛选：null=全部；-1=未分类哨兵（service 侧转 IS NULL） */
  const [filterCategoryId, setFilterCategoryId] = useState<number | null>(null)
  const [accounts, setAccounts] = useState<LedgerAccountView[]>([])
  const [cats, setCats] = useState<LedgerCategory[]>([])
  const [stats, setStats] = useState<LedgerStats | null>(null)
  const [txs, setTxs] = useState<LedgerTxView[]>([])
  const [txDialogOpen, setTxDialogOpen] = useState(false)
  const [editTx, setEditTx] = useState<LedgerTxView | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<LedgerTxView | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<{ row: LedgerTxView; el: HTMLElement } | null>(null)

  const load = useCallback(async () => {
    try {
      const [accs, cs, st, rows] = await Promise.all([
        window.api.ledger.listAccounts(),
        window.api.ledger.listCategories(),
        window.api.ledger.stats(month),
        window.api.ledger.listTx(month, filterCategoryId)
      ])
      setAccounts(accs)
      setCats(cs)
      setStats(st)
      setTxs(rows)
    } catch (e) {
      toast(`加载失败：${(e as Error).message}`)
    }
  }, [month, filterCategoryId, toast])

  useEffect(() => {
    void load()
  }, [load])
  // keep-alive：切回账本刷新（回收站恢复账本条目后回来即见）
  useModuleActivated('ledger', () => void load())

  const totalAssets = accounts.reduce((n, a) => n + a.balance_cents, 0)

  /** 按日分组（倒序）+ 当日支出小计 */
  const groups = useMemo(() => {
    const g: { date: string; rows: LedgerTxView[]; expenseCents: number }[] = []
    for (const t of txs) {
      let last = g[g.length - 1]
      if (!last || last.date !== t.date) {
        last = { date: t.date, rows: [], expenseCents: 0 }
        g.push(last)
      }
      last.rows.push(t)
      if (t.type === 'expense') last.expenseCents += t.amount_cents
    }
    return g
  }, [txs])

  const filterName =
    filterCategoryId == null
      ? ''
      : filterCategoryId === -1
        ? '未分类'
        : (cats.find((c) => c.id === filterCategoryId)?.name ?? '')

  const doRemove = async (): Promise<void> => {
    if (!removeTarget) return
    try {
      await window.api.ledger.removeTx(removeTarget.id)
      toast('已移入回收站')
    } catch (e) {
      toast(`删除失败：${(e as Error).message}`)
    }
    setRemoveTarget(null)
    await load()
  }

  return (
    <div className="module-page ledger-page">
      <div className="module-header">
        <div className="module-title">记账本</div>
        <div className="module-sub">{accounts.length} 个账户</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setManageOpen(true)}>
            <span className="material-symbols-outlined">settings</span>管理
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditTx(null)
              setTxDialogOpen(true)
            }}
          >
            <span className="material-symbols-outlined">add</span>记一笔
          </button>
        </div>
      </div>

      {/* 卡片区：总资产实时（不随月份）+ 月份切换 + 当月收支 */}
      <div className="ledger-cards">
        <div className="ledger-card asset">
          <div className="ledger-card-label">总资产</div>
          <div className="ledger-card-num">{fmtCents(totalAssets)}</div>
        </div>
        <div className="ledger-month-nav">
          <button className="icon-btn" title="上一月" onClick={() => setMonth(shiftMonth(month, -1))}>
            <span className="material-symbols-outlined">chevron_left</span>
          </button>
          <span className="ledger-month-label">{monthLabel(month)}</span>
          <button className="icon-btn" title="下一月" onClick={() => setMonth(shiftMonth(month, 1))}>
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        </div>
        <div className="ledger-card">
          <div className="ledger-card-label">当月收入</div>
          <div className="ledger-card-num">+{fmtCents(stats?.incomeCents ?? 0)}</div>
        </div>
        <div className="ledger-card">
          <div className="ledger-card-label">当月支出</div>
          <div className="ledger-card-num">-{fmtCents(stats?.expenseCents ?? 0)}</div>
        </div>
      </div>

      {/* 占比条：当月支出分类排行，点击下钻筛选流水 */}
      {stats && stats.breakdown.length > 0 && (
        <div className="ledger-breakdown">
          {stats.breakdown.map((b) => (
            <div
              key={`${b.categoryId ?? 'none'}`}
              className={`ledger-bar-row${filterCategoryId === (b.categoryId ?? -1) ? ' active' : ''}${
                filterCategoryId != null && filterCategoryId !== (b.categoryId ?? -1) ? ' dim' : ''
              }`}
              title={filterCategoryId === (b.categoryId ?? -1) ? '点击取消筛选' : '点击筛选该分类流水'}
              onClick={() =>
                setFilterCategoryId(filterCategoryId === (b.categoryId ?? -1) ? null : (b.categoryId ?? -1))
              }
            >
              <span className="ledger-bar-name">{b.name}</span>
              <span className="ledger-bar-track">
                <span className="ledger-bar-fill" style={{ width: `${b.pct}%` }} />
              </span>
              <span className="ledger-bar-amount">{fmtCents(b.cents)}</span>
              <span className="ledger-bar-pct">{b.pct}%</span>
            </div>
          ))}
        </div>
      )}

      {/* 流水列表：按日分组倒序 */}
      <section className="zone ledger-list">
        <div className="zone-body">
          {filterCategoryId != null && (
            <div className="ledger-filter-line">
              筛选中：{filterName}
              <button className="btn" onClick={() => setFilterCategoryId(null)}>
                全部
              </button>
            </div>
          )}
          {groups.length === 0 ? (
            <div className="empty-state">
              <span className="material-symbols-outlined">account_balance_wallet</span>
              这个月还没有流水，点「记一笔」开始
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.date} className="ledger-day">
                <div className="ledger-day-head">
                  <span>{dayLabel(g.date)}</span>
                  <span>{g.date}</span>
                  {g.expenseCents > 0 && (
                    <span className="ledger-day-sum">支出 {fmtCents(g.expenseCents)}</span>
                  )}
                </div>
                {g.rows.map((t) => (
                  <div
                    key={t.id}
                    className="row-item ledger-tx-row"
                    title="点击编辑"
                    onClick={() => {
                      setEditTx(t)
                      setTxDialogOpen(true)
                    }}
                  >
                    <div className="row-main">
                      <div className="row-title">
                        {t.category_name ?? '未分类'} · {t.account_name ?? ''}
                        {t.note ? ` · ${t.note}` : ''}
                      </div>
                    </div>
                    <div className={`ledger-tx-amount ${t.type}`}>
                      {t.type === 'expense' ? '-' : '+'}
                      {fmtCents(t.amount_cents)}
                    </div>
                    <div className="row-actions">
                      <button
                        className="icon-btn"
                        title="更多操作"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuAnchor({ row: t, el: e.currentTarget })
                        }}
                      >
                        <span className="material-symbols-outlined">more_horiz</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </section>

      {/* 行尾操作菜单 */}
      {menuAnchor && (
        <ActionMenu
          anchorEl={menuAnchor.el}
          items={[
            {
              key: 'edit',
              icon: 'edit',
              label: '编辑',
              onClick: () => {
                setEditTx(menuAnchor.row)
                setTxDialogOpen(true)
              }
            },
            {
              key: 'del',
              icon: 'delete',
              label: '删除',
              danger: true,
              onClick: () => setRemoveTarget(menuAnchor.row)
            }
          ]}
          onClose={() => setMenuAnchor(null)}
        />
      )}

      {/* 删流水二次确认（全局规则） */}
      <ConfirmDialog
        open={!!removeTarget}
        title="删除流水"
        danger
        confirmText="移入回收站"
        onConfirm={() => void doRemove()}
        onCancel={() => setRemoveTarget(null)}
      >
        将这笔流水（{fmtCents(removeTarget?.amount_cents ?? 0)}
        {removeTarget?.category_name ? ` · ${removeTarget.category_name}` : ''}）移入回收站，3 天后自动彻底删除。
      </ConfirmDialog>

      {/* 记一笔 / 编辑流水 */}
      <TxDialog
        open={txDialogOpen}
        edit={editTx}
        accounts={accounts}
        categories={cats}
        onClose={() => setTxDialogOpen(false)}
        onSaved={load}
      />

      {/* 账户 / 分类管理 */}
      <ManageDialog open={manageOpen} onClose={() => setManageOpen(false)} onChanged={load} />
    </div>
  )
}
