// 办公台模块（办公台 specs §8）：列表态 ⇄ 文档态两态容器。
// keep-alive 挂载（App MODULES 分支），激活事件 MODULE_ACTIVATED_EVENT 时重拉列表。
import { useCallback, useEffect, useRef, useState } from 'react'
import { MODULE_ACTIVATED_EVENT } from '../../App'
import { useToast } from '../../components/Toast'
import ConfirmDialog from '../../components/ConfirmDialog'
import ActionMenu, { type ActionMenuItem } from '../../components/ActionMenu'
import type { OfficeDocRow, OfficeKind, OfficeOpenPayload } from '../../shared/types'
import HistoryDialog from './HistoryDialog'
import DocTextView from './DocTextView'
import DocGrid from './DocGrid'
import SlidePreview from './SlidePreview'
import InstructionBar from './InstructionBar'
import './office.css'

const KIND_LABEL: Record<OfficeKind, string> = {
  docx: 'Word',
  xlsx: 'Excel',
  pptx: 'PPT',
  txt: 'TXT',
  csv: 'CSV',
  md: 'MD'
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const NEW_ITEMS: { kind: OfficeKind; label: string; icon: string }[] = [
  { kind: 'docx', label: 'Word', icon: 'article' },
  { kind: 'xlsx', label: 'Excel', icon: 'grid_on' },
  { kind: 'pptx', label: 'PPT', icon: 'slideshow' },
  { kind: 'txt', label: '文本', icon: 'text_snippet' },
  { kind: 'md', label: 'Markdown', icon: 'code' }
]

export default function OfficeModule({ onNavigateToProfile }: { onNavigateToProfile: () => void }) {
  const { toast } = useToast()
  const [docs, setDocs] = useState<OfficeDocRow[]>([])
  const [opened, setOpened] = useState<OfficeOpenPayload | null>(null)
  const [importing, setImporting] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [kindFilter, setKindFilter] = useState<OfficeKind | 'all'>('all')
  const [filterMenu, setFilterMenu] = useState<HTMLElement | null>(null)
  const [rowMenu, setRowMenu] = useState<{ anchor: HTMLElement; doc: OfficeDocRow } | null>(null)
  const [delTarget, setDelTarget] = useState<OfficeDocRow | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [gridAiJson, setGridAiJson] = useState<string | null>(null)
  const selectionFn = useRef<(() => string | null) | null>(null)

  const load = useCallback((): void => {
    void window.api.office.list().then(setDocs)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const onAct = (e: Event): void => {
      if ((e as CustomEvent).detail === 'office') load()
    }
    window.addEventListener(MODULE_ACTIVATED_EVENT, onAct)
    return () => window.removeEventListener(MODULE_ACTIVATED_EVENT, onAct)
  }, [load])

  const doImport = async (): Promise<void> => {
    setImporting(true)
    try {
      const { imported, failed } = await window.api.office.importDocs()
      if (imported.length > 0) toast(`已导入 ${imported.length} 个文档`)
      for (const f of failed) toast(`导入失败 ${f.name}：${f.reason}`)
      load()
    } finally {
      setImporting(false)
    }
  }

  const doCreate = async (kind: OfficeKind): Promise<void> => {
    const row = await window.api.office.create('未命名文档', kind)
    load()
    toast(`已新建「${row.name}」`)
  }

  const openDoc = async (id: number): Promise<void> => {
    setGridAiJson(null)
    setOpened(await window.api.office.open(id))
  }

  const del = async (): Promise<void> => {
    if (!delTarget) return
    await window.api.office.discard(delTarget.id)
    toast('已移入回收站（3 天后自动清除）')
    setDelTarget(null)
    load()
  }

  const filtered = docs.filter(
    (d) =>
      (kindFilter === 'all' || d.kind === kindFilter) &&
      (keyword.trim() === '' || d.name.toLowerCase().includes(keyword.trim().toLowerCase()))
  )
  const countOf = (k: OfficeKind): number => docs.filter((d) => d.kind === k).length

  // ===== 文档态 =====
  if (opened) {
    const { row } = opened
    return (
      <div className="module-page office-page">
        <div className="module-header">
          <button className="btn btn-icon" title="返回列表" onClick={() => setOpened(null)}>
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <span className="module-title office-doc-title">{row.name}</span>
          <span className="badge">{KIND_LABEL[row.kind]}</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="btn" onClick={() => setHistoryOpen(true)}>
              <span className="material-symbols-outlined">history</span>
              历史版本
            </button>
            <button
              className="btn"
              onClick={() => {
                void window.api.office.exportDoc(row.id).then(({ ok }) => ok && toast('已导出'))
              }}
            >
              <span className="material-symbols-outlined">download</span>
              导出到电脑
            </button>
          </span>
        </div>
        <div className="office-doc-body">
          {row.kind === 'xlsx' || row.kind === 'csv' ? (
            <DocGrid
              sheets={opened.sheets ?? []}
              aiJson={gridAiJson}
              onChange={async (sheets) => {
                if (gridAiJson) setGridAiJson(null)
                setOpened({ ...opened, sheets })
                await window.api.office.save(row.id, { sheets })
              }}
            />
          ) : row.kind === 'pptx' ? (
            <SlidePreview
              key={row.id}
              md={opened.content ?? ''}
              onChange={async (content) => {
                setOpened({ ...opened, content })
                await window.api.office.save(row.id, { content })
              }}
            />
          ) : (
            <DocTextView
              key={row.id}
              docId={row.id}
              kind={row.kind}
              md={opened.content ?? ''}
              onSelectionReady={(fn) => {
                selectionFn.current = fn
              }}
              onChange={async (content) => {
                setOpened({ ...opened, content })
                await window.api.office.save(row.id, { content })
              }}
            />
          )}
        </div>
        <InstructionBar
          key={row.id}
          kind={row.kind}
          rowId={row.id}
          getContent={() => opened.content ?? ''}
          getSheetBook={() => opened.sheets ?? undefined}
          getSelection={() => selectionFn.current?.() ?? null}
          onApplied={(patch) => {
            if (patch.aiJson) setGridAiJson(patch.aiJson)
            if (patch.content !== undefined) setOpened((o) => (o ? { ...o, content: patch.content ?? null } : o))
          }}
          onNeedConfig={onNavigateToProfile}
        />
        <HistoryDialog
          open={historyOpen}
          docId={row.id}
          onClose={() => setHistoryOpen(false)}
          onRestored={async () => {
            setHistoryOpen(false)
            setOpened(await window.api.office.open(row.id))
            toast('已恢复该版本')
          }}
        />
      </div>
    )
  }

  // ===== 列表态 =====
  const rowMenuItems: ActionMenuItem[] = rowMenu
    ? [
        {
          key: 'rename',
          icon: 'edit',
          label: '重命名',
          onClick: () => {
            const name = window.prompt('新名称', rowMenu.doc.name)
            if (name && name.trim() && name.trim() !== rowMenu.doc.name) {
              void window.api.office.rename(rowMenu.doc.id, name.trim()).then(load)
            }
          }
        },
        {
          key: 'export',
          icon: 'download',
          label: '导出到电脑',
          onClick: () => {
            void window.api.office.exportDoc(rowMenu.doc.id).then(({ ok }) => ok && toast('已导出'))
          }
        },
        {
          key: 'del',
          icon: 'delete',
          label: '删除',
          danger: true,
          separatorAbove: true,
          onClick: () => setDelTarget(rowMenu.doc)
        }
      ]
    : []

  return (
    <div className="module-page office-page">
      <div className="module-header">
        <span className="material-symbols-outlined">description</span>
        <span className="module-title">办公台</span>
        <span className="module-sub">Word · Excel · PPT · 文本，读写与 AI 代写</span>
      </div>

      <div className="card office-toolbar">
        {NEW_ITEMS.map((n) => (
          <button key={n.kind} className="btn" title={`新建${n.label}`} onClick={() => void doCreate(n.kind)}>
            <span className="material-symbols-outlined">{n.icon}</span>
            {n.label}
          </button>
        ))}
        <button className="btn btn-primary" disabled={importing} onClick={() => void doImport()}>
          <span className="material-symbols-outlined">upload</span>
          {importing ? '导入中…' : '导入'}
        </button>
        <input
          className="field office-search"
          placeholder="搜索文档名…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <button className="btn" onClick={(e) => setFilterMenu(e.currentTarget)}>
          <span className="material-symbols-outlined">filter_list</span>
          {kindFilter === 'all' ? '全部' : KIND_LABEL[kindFilter]}
        </button>
      </div>
      {filterMenu && (
        <ActionMenu
          anchorEl={filterMenu}
          onClose={() => setFilterMenu(null)}
          items={[
            {
              key: 'all',
              label: `全部（${docs.length}）`,
              icon: kindFilter === 'all' ? 'check' : undefined,
              onClick: () => setKindFilter('all')
            },
            ...NEW_ITEMS.map((n) => ({
              key: n.kind,
              label: `${n.label}（${countOf(n.kind)}）`,
              icon: kindFilter === n.kind ? 'check' : undefined,
              onClick: () => setKindFilter(n.kind)
            }))
          ]}
        />
      )}
      {rowMenu && <ActionMenu anchorEl={rowMenu.anchor} items={rowMenuItems} onClose={() => setRowMenu(null)} />}

      <div className="office-list">
        {filtered.length === 0 && (
          <div className="card office-empty">
            <span className="material-symbols-outlined">note_stack</span>
            <p>还没有文档——从电脑导入，或直接新建一个让 AI 帮你写。</p>
          </div>
        )}
        {filtered.map((d) => (
          <div key={d.id} className="card zl-row office-row" onClick={() => void openDoc(d.id)}>
            <span className="badge">{KIND_LABEL[d.kind]}</span>
            <span className="office-row-name">{d.name}</span>
            <span className="module-sub">{fmtSize(d.size)}</span>
            <span className="module-sub" style={{ marginLeft: 'auto' }}>
              {fmtTime(d.updated_at)}
            </span>
            <button
              className="btn btn-icon"
              title="更多操作"
              onClick={(e) => {
                e.stopPropagation()
                setRowMenu({ anchor: e.currentTarget, doc: d })
              }}
            >
              <span className="material-symbols-outlined">more_vert</span>
            </button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={delTarget != null}
        title={`删除「${delTarget?.name ?? ''}」？`}
        confirmText="移入回收站"
        danger
        onConfirm={() => void del()}
        onCancel={() => setDelTarget(null)}
      >
        将移入回收站，3 天后自动彻底删除（连文件与历史版本）。
      </ConfirmDialog>
    </div>
  )
}
