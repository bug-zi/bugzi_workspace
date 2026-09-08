// 管理弹窗（账本 specs §3.3）：tab 切账户（名称/期初余额/余额）与分类（支出/收入两组）
import { useCallback, useEffect, useState } from 'react'
import type { LedgerAccountView, LedgerCategory } from '../../shared/types'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { fmtCents } from './LedgerModule'

interface ManageDialogProps {
  open: boolean
  onClose: () => void
  onChanged: () => Promise<void> | void
}

/** 期初余额输入合法性：空=0；正数最多两位小数 */
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/

export default function ManageDialog(props: ManageDialogProps) {
  const { toast } = useToast()
  const [tab, setTab] = useState<'accounts' | 'categories'>('accounts')
  const [accounts, setAccounts] = useState<LedgerAccountView[]>([])
  const [cats, setCats] = useState<LedgerCategory[]>([])

  // 账户表单（新建/编辑共用：editingId=null 为新建行）
  const [accName, setAccName] = useState('')
  const [accInitial, setAccInitial] = useState('')
  const [editingAccId, setEditingAccId] = useState<number | null>(null)

  // 分类表单
  const [catName, setCatName] = useState('')
  const [catKind, setCatKind] = useState<'expense' | 'income'>('expense')
  const [editingCatId, setEditingCatId] = useState<number | null>(null)

  const [removeAcc, setRemoveAcc] = useState<LedgerAccountView | null>(null)
  const [removeCat, setRemoveCat] = useState<LedgerCategory | null>(null)

  const load = useCallback(async () => {
    const [accs, cs] = await Promise.all([window.api.ledger.listAccounts(), window.api.ledger.listCategories()])
    setAccounts(accs)
    setCats(cs)
  }, [])

  useEffect(() => {
    if (props.open) void load()
  }, [props.open, load])

  const changed = async (): Promise<void> => {
    await load()
    await props.onChanged()
  }

  if (!props.open) return null

  /** 元字符串 → 分（空串=0）；不合法返回 null */
  const parseInitial = (s: string): number | null => {
    const t = s.trim()
    if (t === '') return 0
    if (!AMOUNT_RE.test(t)) return null
    return Math.round(parseFloat(t) * 100)
  }

  const saveAccount = async (): Promise<void> => {
    const initial = parseInitial(accInitial)
    if (!accName.trim()) {
      toast('账户名不能为空')
      return
    }
    if (initial == null) {
      toast('期初余额不合法（正数，最多两位小数）')
      return
    }
    try {
      await window.api.ledger.saveAccount(editingAccId, accName, initial)
      toast(editingAccId ? '已保存' : '已添加账户')
      setAccName('')
      setAccInitial('')
      setEditingAccId(null)
      await changed()
    } catch (e) {
      toast((e as Error).message)
    }
  }

  const saveCategory = async (): Promise<void> => {
    if (!catName.trim()) {
      toast('分类名不能为空')
      return
    }
    try {
      await window.api.ledger.saveCategory(editingCatId, catName, catKind)
      toast(editingCatId ? '已保存' : '已添加分类')
      setCatName('')
      setEditingCatId(null)
      await changed()
    } catch (e) {
      toast((e as Error).message)
    }
  }

  const doRemoveAccount = async (): Promise<void> => {
    if (!removeAcc) return
    try {
      const r = await window.api.ledger.removeAccount(removeAcc.id)
      toast(`已移入回收站（${r.cascaded} 笔流水一并入站）`)
    } catch (e) {
      toast(`删除失败：${(e as Error).message}`)
    }
    setRemoveAcc(null)
    await changed()
  }

  const doRemoveCategory = async (): Promise<void> => {
    if (!removeCat) return
    try {
      const r = await window.api.ledger.removeCategory(removeCat.id)
      toast(`已删除分类（${r.detached} 笔流水变为未分类）`)
    } catch (e) {
      toast(`删除失败：${(e as Error).message}`)
    }
    setRemoveCat(null)
    await changed()
  }

  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog" style={{ width: 560 }}>
        <div className="dialog-header">管理</div>
        <div className="dialog-body">
          <div className="ledger-manage-tabs">
            <button className={`btn${tab === 'accounts' ? ' btn-primary' : ''}`} onClick={() => setTab('accounts')}>
              账户
            </button>
            <button
              className={`btn${tab === 'categories' ? ' btn-primary' : ''}`}
              onClick={() => setTab('categories')}
            >
              分类
            </button>
          </div>

          {tab === 'accounts' && (
            <>
              {/* 新建/编辑账户表单 */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input
                  className="field"
                  placeholder={editingAccId ? '账户名' : '新账户名'}
                  value={accName}
                  onChange={(e) => setAccName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void saveAccount()}
                />
                <input
                  className="field"
                  inputMode="decimal"
                  placeholder="期初余额（元）"
                  value={accInitial}
                  onChange={(e) => setAccInitial(e.target.value)}
                  style={{ flex: '0 0 140px' }}
                  onKeyDown={(e) => e.key === 'Enter' && void saveAccount()}
                />
                <button className="btn btn-primary" onClick={() => void saveAccount()}>
                  {editingAccId ? '保存' : '添加'}
                </button>
                {editingAccId != null && (
                  <button
                    className="btn"
                    onClick={() => {
                      setEditingAccId(null)
                      setAccName('')
                      setAccInitial('')
                    }}
                  >
                    取消
                  </button>
                )}
              </div>
              {accounts.map((a) => (
                <div key={a.id} className="ledger-manage-row">
                  <span className="ledger-manage-name">{a.name}</span>
                  <span className="ledger-manage-sub">
                    期初 {fmtCents(a.initial_balance_cents)} · 余额 {fmtCents(a.balance_cents)}
                  </span>
                  <span className="row-actions">
                    <button
                      className="icon-btn"
                      title="编辑"
                      onClick={() => {
                        setEditingAccId(a.id)
                        setAccName(a.name)
                        setAccInitial((a.initial_balance_cents / 100).toFixed(2))
                      }}
                    >
                      <span className="material-symbols-outlined">edit</span>
                    </button>
                    <button className="icon-btn danger" title="删除" onClick={() => setRemoveAcc(a)}>
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                  </span>
                </div>
              ))}
            </>
          )}

          {tab === 'categories' && (
            <>
              {/* 新建/编辑分类表单（kind 随表单切换） */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <div className="ledger-type-toggle">
                  <button
                    className={`ledger-type-btn${catKind === 'expense' ? ' active' : ''}`}
                    onClick={() => setCatKind('expense')}
                  >
                    支出
                  </button>
                  <button
                    className={`ledger-type-btn${catKind === 'income' ? ' active' : ''}`}
                    onClick={() => setCatKind('income')}
                  >
                    收入
                  </button>
                </div>
                <input
                  className="field"
                  placeholder={editingCatId ? '分类名' : '新分类名'}
                  value={catName}
                  onChange={(e) => setCatName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void saveCategory()}
                />
                <button className="btn btn-primary" onClick={() => void saveCategory()}>
                  {editingCatId ? '保存' : '添加'}
                </button>
                {editingCatId != null && (
                  <button
                    className="btn"
                    onClick={() => {
                      setEditingCatId(null)
                      setCatName('')
                    }}
                  >
                    取消
                  </button>
                )}
              </div>
              {(['expense', 'income'] as const).map((kind) => (
                <div key={kind}>
                  <div className="ledger-group-title">{kind === 'expense' ? '支出分类' : '收入分类'}</div>
                  {cats
                    .filter((c) => c.kind === kind)
                    .map((c) => (
                      <div key={c.id} className="ledger-manage-row">
                        <span className="ledger-manage-name">{c.name}</span>
                        <span className="row-actions">
                          <button
                            className="icon-btn"
                            title="编辑"
                            onClick={() => {
                              setEditingCatId(c.id)
                              setCatName(c.name)
                              setCatKind(c.kind)
                            }}
                          >
                            <span className="material-symbols-outlined">edit</span>
                          </button>
                          <button className="icon-btn danger" title="删除" onClick={() => setRemoveCat(c)}>
                            <span className="material-symbols-outlined">delete</span>
                          </button>
                        </span>
                      </div>
                    ))}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="dialog-footer">
          <button className="btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>

      {/* 删账户二次确认：级联后果（实际笔数删除后 toast，specs §3.3） */}
      <ConfirmDialog
        open={!!removeAcc}
        title="删除账户"
        danger
        confirmText="移入回收站"
        onConfirm={() => void doRemoveAccount()}
        onCancel={() => setRemoveAcc(null)}
      >
        将删除账户「{removeAcc?.name}」及其名下全部流水（一并移入回收站，3 天后自动彻底删除）。
      </ConfirmDialog>

      {/* 删分类二次确认：断链后果 */}
      <ConfirmDialog
        open={!!removeCat}
        title="删除分类"
        danger
        confirmText="移入回收站"
        onConfirm={() => void doRemoveCategory()}
        onCancel={() => setRemoveCat(null)}
      >
        将删除{removeCat?.kind === 'expense' ? '支出' : '收入'}分类「{removeCat?.name}
        」；仍在使用它的流水将变为「未分类」（流水本身不动）。
      </ConfirmDialog>
    </div>
  )
}
