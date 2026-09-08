// 记一笔/编辑流水弹窗（账本 specs §3.2）：金额→收支→分类宫格→账户→日期→备注；编辑态带删除
import { useEffect, useState } from 'react'
import type { LedgerAccountView, LedgerCategory, LedgerTxInput, LedgerTxView } from '../../shared/types'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { fmtCents, todayStr } from './LedgerModule'

interface TxDialogProps {
  open: boolean
  /** 编辑目标（null=新增） */
  edit: LedgerTxView | null
  accounts: LedgerAccountView[]
  categories: LedgerCategory[]
  onClose: () => void
  onSaved: () => Promise<void> | void
}

/** 金额合法性（specs §0）：正数、最多两位小数 */
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/
/** 与主进程 MAX_AMOUNT_CENTS 同值（渲染层字面量，specs §0） */
const MAX_AMOUNT_CENTS = 9_999_999_999

export default function TxDialog(props: TxDialogProps) {
  const { toast } = useToast()
  const { open, edit, accounts, categories } = props
  const [amount, setAmount] = useState('')
  const [type, setType] = useState<'expense' | 'income'>('expense')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [accountId, setAccountId] = useState<number | null>(null)
  const [date, setDate] = useState('')
  const [note, setNote] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)

  // 打开时按新增/编辑初始化字段
  useEffect(() => {
    if (!open) return
    setConfirmDel(false)
    if (edit) {
      setAmount((edit.amount_cents / 100).toFixed(2))
      setType(edit.type)
      setCategoryId(edit.category_id)
      setAccountId(edit.account_id)
      setDate(edit.date)
      setNote(edit.note ?? '')
    } else {
      setAmount('')
      setType('expense')
      setCategoryId(null)
      setAccountId(accounts[0]?.id ?? null)
      setDate(todayStr())
      setNote('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, edit])

  if (!open) return null

  const submit = async (): Promise<void> => {
    const a = amount.trim()
    if (!AMOUNT_RE.test(a)) {
      toast('金额需为正数，最多两位小数')
      return
    }
    const cents = Math.round(parseFloat(a) * 100)
    if (cents <= 0) {
      toast('金额需大于 0')
      return
    }
    if (cents > MAX_AMOUNT_CENTS) {
      toast('金额超出上限（1 亿元）')
      return
    }
    if (accountId == null) {
      toast('请选择账户')
      return
    }
    if (!date) {
      toast('请选择日期')
      return
    }
    const tx: LedgerTxInput = { date, type, amountCents: cents, categoryId, accountId, note: note.trim() }
    try {
      await window.api.ledger.saveTx(edit?.id ?? null, tx)
      toast(edit ? '已保存' : '已记一笔')
      props.onClose()
      await props.onSaved()
    } catch (e) {
      toast(`保存失败：${(e as Error).message}`)
    }
  }

  const doDelete = async (): Promise<void> => {
    if (!edit) return
    try {
      await window.api.ledger.removeTx(edit.id)
      toast('已移入回收站')
    } catch (e) {
      toast(`删除失败：${(e as Error).message}`)
    }
    setConfirmDel(false)
    props.onClose()
    await props.onSaved()
  }

  const chips = [{ id: null, name: '未分类' } as const, ...categories.filter((c) => c.kind === type)]

  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog" style={{ width: 520 }}>
        <div className="dialog-header">{edit ? '编辑流水' : '记一笔'}</div>
        <div className="dialog-body">
          {/* 支出/收入切换 + 金额 */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div className="ledger-type-toggle">
              <button
                className={`ledger-type-btn${type === 'expense' ? ' active' : ''}`}
                onClick={() => setType('expense')}
              >
                支出
              </button>
              <button
                className={`ledger-type-btn${type === 'income' ? ' active' : ''}`}
                onClick={() => setType('income')}
              >
                收入
              </button>
            </div>
            <input
              className="field ledger-amount-input"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              autoFocus
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
          </div>

          <div className="ledger-field-label">分类（可不选 = 未分类）</div>
          <div className="ledger-chip-grid">
            {chips.map((c) => (
              <button
                key={`${c.id ?? 'none'}`}
                className={`ledger-chip${categoryId === c.id ? ' active' : ''}`}
                onClick={() => setCategoryId(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>

          <div className="ledger-field-label">账户</div>
          <div className="ledger-account-row">
            {accounts.map((a) => (
              <button
                key={a.id}
                className={`ledger-chip${accountId === a.id ? ' active' : ''}`}
                title={`余额 ${fmtCents(a.balance_cents)}`}
                onClick={() => setAccountId(a.id)}
              >
                {a.name}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <input
              className="field"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ flex: '0 0 170px' }}
            />
            <input
              className="field"
              placeholder="备注（选填）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <div className="dialog-footer">
          {edit && (
            <button className="btn btn-danger" onClick={() => setConfirmDel(true)}>
              删除
            </button>
          )}
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void submit()}>
            保存
          </button>
        </div>
      </div>

      {/* 编辑态删除二次确认 */}
      <ConfirmDialog
        open={confirmDel}
        title="删除流水"
        danger
        confirmText="移入回收站"
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDel(false)}
      >
        将这笔流水（{fmtCents(edit?.amount_cents ?? 0)}
        {edit?.category_name ? ` · ${edit.category_name}` : ''}）移入回收站，3 天后自动彻底删除。
      </ConfirmDialog>
    </div>
  )
}
