// 轻量网格（specs §5/§8）：多 sheet 查看、单元格编辑、增删行列；不做公式计算（读文件缓存值）。
// 全簿保存由父层 onChange 直写（office:save sheets 全量）；AI 返回 JSON 二维数组经 aiJson 应用到当前 sheet。
import { useEffect, useRef, useState } from 'react'
import { useToast } from '../../components/Toast'
import ConfirmDialog from '../../components/ConfirmDialog'
import type { OfficeSheet } from '../../shared/types'

interface Props {
  sheets: OfficeSheet[]
  aiJson?: string | null
  onChange: (sheets: OfficeSheet[]) => void
}

const colName = (i: number): string => {
  let s = ''
  let n = i
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  }
  return s
}

export default function DocGrid({ sheets, aiJson, onChange }: Props) {
  const { toast } = useToast()
  const [active, setActive] = useState(0)
  const [delRowCol, setDelRowCol] = useState<null | { axis: 'row' | 'col' }>(null)
  const warned = useRef(false)

  useEffect(() => {
    if (active >= sheets.length) setActive(Math.max(0, sheets.length - 1))
  }, [sheets.length, active])

  useEffect(() => {
    if (!warned.current && sheets[0] && sheets[0].rows.length > 2000) {
      warned.current = true
      toast('大表建议用本机 Excel 编辑（当前 >2000 行）')
    }
  }, [sheets, toast])

  // AI 表格应用：aiJson（JSON 二维数组）替换当前 sheet（父层 onChange 落盘后置 aiJson=null）
  useEffect(() => {
    if (!aiJson) return
    try {
      const rows = JSON.parse(aiJson) as unknown
      if (!Array.isArray(rows) || !Array.isArray(rows[0])) throw new Error('not 2d array')
      const next = sheets.map((s, i) =>
        i === active ? { ...s, rows: (rows as unknown[][]).map((r) => r.map((c) => String(c ?? ''))) } : s
      )
      onChange(next)
    } catch {
      toast('AI 返回格式异常，未应用')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiJson])

  if (sheets.length === 0) return <div className="module-sub" style={{ padding: 16 }}>空工作簿</div>
  const cur = sheets[Math.min(active, sheets.length - 1)]

  const setCell = (r: number, c: number, v: string): void => {
    const rows = cur.rows.map((row) => [...row])
    while (rows.length <= r) rows.push([''])
    while (rows[r].length <= c) rows[r].push('')
    rows[r][c] = v
    onChange(sheets.map((s, i) => (i === active ? { ...s, rows } : s)))
  }

  const addRowCol = (axis: 'row' | 'col', delta: 1 | -1): void => {
    if (axis === 'row') {
      if (delta === 1) {
        onChange(
          sheets.map((s, i) =>
            i === active ? { ...s, rows: [...s.rows, new Array(s.rows[0]?.length ?? 1).fill('')] } : s
          )
        )
      } else {
        setDelRowCol({ axis: 'row' })
      }
    } else if (delta === 1) {
      onChange(sheets.map((s, i) => (i === active ? { ...s, rows: s.rows.map((r) => [...r, '']) } : s)))
    } else {
      setDelRowCol({ axis: 'col' })
    }
  }

  const confirmDel = (): void => {
    if (!delRowCol) return
    if (delRowCol.axis === 'row') {
      if (cur.rows.length <= 1) {
        toast('至少保留一行')
        setDelRowCol(null)
        return
      }
      onChange(sheets.map((s, i) => (i === active ? { ...s, rows: s.rows.slice(0, -1) } : s)))
    } else {
      if ((cur.rows[0]?.length ?? 1) <= 1) {
        toast('至少保留一列')
        setDelRowCol(null)
        return
      }
      onChange(
        sheets.map((s, i) => (i === active ? { ...s, rows: s.rows.map((r) => r.slice(0, -1)) } : s))
      )
    }
    setDelRowCol(null)
  }

  const cols = Math.max(6, ...cur.rows.map((r) => r.length))

  return (
    <div className="office-grid">
      {sheets.length > 1 && (
        <div className="office-grid-sheets">
          {sheets.map((s, i) => (
            <button key={s.name} className={`btn${i === active ? ' btn-primary' : ''}`} onClick={() => setActive(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="office-grid-tools">
        <button className="btn" title="末尾加一行" onClick={() => addRowCol('row', 1)}>
          <span className="material-symbols-outlined">add</span>行
        </button>
        <button className="btn" title="删除最后一行" onClick={() => addRowCol('row', -1)}>
          <span className="material-symbols-outlined">remove</span>行
        </button>
        <button className="btn" title="末尾加一列" onClick={() => addRowCol('col', 1)}>
          <span className="material-symbols-outlined">add</span>列
        </button>
        <button className="btn" title="删除最后一列" onClick={() => addRowCol('col', -1)}>
          <span className="material-symbols-outlined">remove</span>列
        </button>
      </div>
      <div className="office-grid-scroll">
        <table className="office-grid-table">
          <thead>
            <tr>
              <th className="office-corner" />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c}>{colName(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cur.rows.map((row, r) => (
              <tr key={r}>
                <td className="office-rowno">{r + 1}</td>
                {Array.from({ length: cols }, (_, c) => (
                  <td key={c}>
                    <input
                      value={row[c] ?? ''}
                      onChange={(e) => setCell(r, c, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const below = (e.target as HTMLInputElement)
                            .closest('tr')
                            ?.nextElementSibling?.querySelector('input') as HTMLInputElement | null
                          below?.focus()
                          below?.select()
                        }
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={delRowCol != null}
        title={delRowCol?.axis === 'row' ? '删除最后一行？' : '删除最后一列？'}
        confirmText="删除"
        danger
        onConfirm={confirmDel}
        onCancel={() => setDelRowCol(null)}
      />
    </div>
  )
}
