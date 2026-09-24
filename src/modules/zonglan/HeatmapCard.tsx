// 热力图卡片（260916 新功能开发区）：近一年 53 周 × 7 天三任务完成度四档着色。
// 纯自研 div grid 零依赖；颜色经 color-mix 派生主题色（浅樱粉/深宝蓝自动适配，零彩亮）；
// hover 详情固定在标题行右侧（不做跟随浮层）。范围：今天回推 52 周对齐周一。
import { useMemo, useState } from 'react'
import type { HeatmapDay } from '../../shared/types'

/** 本地 YYYY-MM-DD */
function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 近一年范围：今天回推 52 周再对齐该周周一（getDay 0=周日 → 周一偏移 (day+6)%7） */
export function heatmapRange(today = new Date()): { from: string; to: string } {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const start = new Date(end)
  start.setDate(start.getDate() - 52 * 7)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  return { from: fmt(start), to: fmt(end) }
}

interface HeatCell {
  date: string
  day: HeatmapDay | null
  future: boolean
}

/** 53 列 × 7 行格子（列=周，首列含 from 对齐的周一；未来日期仅占位不渲染颜色） */
function buildGrid(from: string, to: string, days: HeatmapDay[]): HeatCell[][] {
  const byDate = new Map(days.map((d) => [d.date, d]))
  const cur = new Date(`${from}T00:00:00`)
  const cols: HeatCell[][] = []
  for (let c = 0; c < 53; c++) {
    const col: HeatCell[] = []
    for (let r = 0; r < 7; r++) {
      const iso = fmt(cur)
      col.push({ date: iso, day: byDate.get(iso) ?? null, future: iso > to })
      cur.setDate(cur.getDate() + 1)
    }
    cols.push(col)
  }
  return cols
}

/** 四档样式类名 */
function cellClass(cell: HeatCell): string {
  if (cell.future) return 'zl-heat-cell zl-heat-future'
  return `zl-heat-cell zl-heat-${cell.day?.level ?? 0}`
}

/** hover 详情文案（无记录日 → 「无记录」；260925 五源：学习/一题/挑战/飞花令/副本） */
function detailText(d: HeatmapDay | null): string {
  if (!d) return '无记录'
  const part = (on: boolean, label: string): string => `${label} ${on ? '已完成' : '未完成'}`
  return `${d.date} · ${part(d.learn, '学习')} · ${part(d.wall, '一题')} · ${part(d.challenge, '挑战')} · ${part(d.fushi, '飞花令')} · ${part(d.copies, '副本')}`
}

export default function HeatmapCard(props: { days: HeatmapDay[] | null }) {
  const [hovered, setHovered] = useState<HeatmapDay | null>(null)

  const { cols, labels } = useMemo(() => {
    if (!props.days) return { cols: [] as HeatCell[][], labels: new Map<number, string>() }
    const { from, to } = heatmapRange()
    const grid = buildGrid(from, to, props.days)
    const labels = new Map<number, string>()
    let prevMonth = -1
    grid.forEach((col, i) => {
      // 标签取该列周一所在月份（跨月周归周一侧，GitHub 同款简化）
      const m = new Date(`${col[0].date}T00:00:00`).getMonth() + 1
      if (m !== prevMonth) labels.set(i, `${m}月`)
      prevMonth = m
    })
    return { cols: grid, labels }
  }, [props.days])

  const today = fmt(new Date())
  const detail = hovered ?? props.days?.find((d) => d.date === today) ?? null

  return (
    <div className="card zl-heat-card">
      <div className="zl-heat-head">
        <span className="material-symbols-outlined">calendar_month</span>
        <span className="zl-row-title">这一年的完成情况</span>
        <span className="zl-heat-detail module-sub">{detailText(detail)}</span>
      </div>
      {props.days === null ? (
        <div className="module-sub">加载失败</div>
      ) : (
        <>
          <div className="zl-heat" onMouseLeave={() => setHovered(null)}>
            <div className="zl-heat-weeks">
              {['一', '', '三', '', '五', '', ''].map((t, i) => (
                <span className="zl-heat-week" key={i}>
                  {t}
                </span>
              ))}
            </div>
            <div className="zl-heat-grid">
              <div className="zl-heat-months">
                {cols.map((_, i) => (
                  <span className="zl-heat-month" key={i}>
                    {labels.get(i) ?? ''}
                  </span>
                ))}
              </div>
              <div className="zl-heat-cols">
                {cols.map((col, ci) => (
                  <div className="zl-heat-col" key={ci}>
                    {col.map((cell) => (
                      <div
                        key={cell.date}
                        className={cellClass(cell)}
                        onMouseEnter={() => !cell.future && setHovered(cell.day)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="zl-heat-legend module-sub">
            少
            <span className="zl-heat-cell zl-heat-0" />
            <span className="zl-heat-cell zl-heat-1" />
            <span className="zl-heat-cell zl-heat-2" />
            <span className="zl-heat-cell zl-heat-3" />
            <span className="zl-heat-cell zl-heat-4" />
            <span className="zl-heat-cell zl-heat-5" />
            多
          </div>
        </>
      )}
    </div>
  )
}
