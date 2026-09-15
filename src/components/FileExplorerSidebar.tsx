// 资源管理器边栏（新功能开发区 260916）：右缘第四面板，与 debugzi/草稿本/画布互斥展开。
// 打开本机任意文件夹只读浏览：懒加载文件树 + 单栏两态（浏览态/查看态）。
// 代码 highlight.js 高亮、md 走全局 MdView、图片直接预览、其余提示不支持；零 AI 零联动。
import { Fragment, useEffect, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import hljs from 'highlight.js/lib/common'
import { SettingsKeys } from '../shared/types'
import MdView from './MdView'
import { useToast } from './Toast'
import './FileExplorerSidebar.css'

export interface FileExplorerSidebarProps {
  onCollapse: () => void
}

/** 面板宽度拖拽范围（px；默认值同 global.css --filex-width），口径同草稿本 280–560 */
const FILEX_WIDTH_MIN = 280
const FILEX_WIDTH_MAX = 560
const FILEX_WIDTH_DEFAULT = 320

const clampFilexWidth = (w: number): number =>
  Math.min(FILEX_WIDTH_MAX, Math.max(FILEX_WIDTH_MIN, Math.round(w)))

/** 宽度写 :root 的 --filex-width（样式即生效） */
function applyFilexWidth(w: number): void {
  document.documentElement.style.setProperty('--filex-width', `${w}px`)
}

interface Entry {
  name: string
  path: string
  type: 'file' | 'dir'
}

type View =
  | { kind: 'browse' }
  | { kind: 'code'; path: string; content: string; lang: string }
  | { kind: 'md'; path: string; md: string }
  | { kind: 'image'; path: string; url: string }
  | { kind: 'unsupported'; path: string; reason: string }

/** 扩展名 → highlight.js 语言名（预览白名单，命中才走代码高亮；仅含 lib/common 注册的语言） */
const CODE_EXT_LANG: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  vue: 'xml',
  svelte: 'xml',
  py: 'python',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini'
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'])

function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

function fileIcon(name: string): string {
  const ext = extOf(name)
  if (ext === 'md') return 'article'
  if (CODE_EXT_LANG[ext]) return 'code'
  if (IMAGE_EXTS.has(ext)) return 'image'
  return 'description'
}

/** 目录条目排序：文件夹在前；`.` 开头各自组内靠后；同组按名称 */
function sortEntries(list: Entry[]): Entry[] {
  return [...list].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    const ad = a.name.startsWith('.')
    const bd = b.name.startsWith('.')
    if (ad !== bd) return ad ? 1 : -1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

/** IPC 错误 → 用户可读文案 */
function readErrMsg(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('TOO_LARGE')) return '文件过大（文本 1MB / 图片 5MB 上限），无法预览'
  if (msg.includes('BINARY')) return '二进制文件，不支持预览'
  if (msg.includes('PATH_OUT_OF_ROOT')) return '路径越界，已拒绝读取'
  return '文件读取失败（可能已被移动或删除）'
}

/** 代码查看区：highlight.js 高亮 + 行号列（语言未注册时纯文本兜底） */
function CodePane(props: { content: string; lang: string }) {
  const { content, lang } = props
  const supported = Boolean(hljs.getLanguage(lang))
  const html = useMemo(
    () => (supported ? hljs.highlight(content, { language: lang }).value : ''),
    [content, lang, supported]
  )
  const gutter = useMemo(
    () => Array.from({ length: content.split('\n').length }, (_, i) => i + 1).join('\n'),
    [content]
  )
  return (
    <div className="filex-code">
      <pre className="filex-code-gutter">{gutter}</pre>
      <pre className="filex-code-body">
        {supported ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{content}</code>
        )}
      </pre>
    </div>
  )
}

export default function FileExplorerSidebar(props: FileExplorerSidebarProps) {
  const { onCollapse } = props
  const { toast } = useToast()
  const [root, setRoot] = useState<string | null>(null)
  const [rootErr, setRootErr] = useState(false)
  // 目录内容缓存：dirPath → 条目数组 | 'loading'（懒加载核心）
  const [dirCache, setDirCache] = useState<Map<string, Entry[] | 'loading'>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [view, setView] = useState<View>({ kind: 'browse' })
  const [activePath, setActivePath] = useState<string | null>(null)
  const [filexWidth, setFilexWidth] = useState(FILEX_WIDTH_DEFAULT)

  /** 打开文件查看（按扩展名分流：md → MdView / 代码白名单 → 高亮 / 图片 → 预览 / 其余不支持）；
   *  silent = 恢复上次文件的启动路径——读取失败静默留在浏览态（设计口径），不弹不支持页 */
  const openFile = async (rootDir: string, path: string, silent = false): Promise<void> => {
    const ext = extOf(path)
    const fail = (e: unknown): void => {
      if (silent) return
      setView({ kind: 'unsupported', path, reason: readErrMsg(e) })
    }
    if (ext === 'md') {
      try {
        const md = await window.api.explorer.readText(rootDir, path)
        setView({ kind: 'md', path, md })
        setActivePath(path)
        void window.api.settings.set(SettingsKeys.FilesLastFile, path)
      } catch (e) {
        fail(e)
      }
      return
    }
    const lang = CODE_EXT_LANG[ext]
    if (lang) {
      try {
        const content = await window.api.explorer.readText(rootDir, path)
        setView({ kind: 'code', path, content, lang })
        setActivePath(path)
        void window.api.settings.set(SettingsKeys.FilesLastFile, path)
      } catch (e) {
        fail(e)
      }
      return
    }
    if (IMAGE_EXTS.has(ext)) {
      try {
        const url = await window.api.explorer.readImage(rootDir, path)
        setView({ kind: 'image', path, url })
        setActivePath(path)
        void window.api.settings.set(SettingsKeys.FilesLastFile, path)
      } catch (e) {
        fail(e)
      }
      return
    }
    setView({ kind: 'unsupported', path, reason: '该文件类型不支持预览' })
    setActivePath(path)
  }

  /** 目录展开/收起；首次展开懒加载该层内容，失败回滚展开态 */
  const toggleDir = async (rootDir: string, entry: Entry): Promise<void> => {
    if (expanded.has(entry.path)) {
      const next = new Set(expanded)
      next.delete(entry.path)
      setExpanded(next)
      return
    }
    const next = new Set(expanded)
    next.add(entry.path)
    setExpanded(next)
    if (!dirCache.has(entry.path)) {
      setDirCache((m) => new Map(m).set(entry.path, 'loading'))
      try {
        const entries = await window.api.explorer.readDir(rootDir, entry.path)
        setDirCache((m) => new Map(m).set(entry.path, entries))
      } catch {
        toast('目录读取失败（可能无权限）')
        const roll = new Set(next)
        roll.delete(entry.path)
        setExpanded(roll)
        setDirCache((m) => {
          const n = new Map(m)
          n.delete(entry.path)
          return n
        })
      }
    }
  }

  /** 设定根目录并读首层；openLast 时恢复上次打开的文件（失效静默留在浏览态） */
  const loadRoot = async (dir: string, openLast: boolean): Promise<void> => {
    setRootErr(false)
    setRoot(dir)
    setDirCache(new Map())
    setExpanded(new Set())
    setView({ kind: 'browse' })
    setActivePath(null)
    try {
      const entries = await window.api.explorer.readDir(dir, dir)
      setDirCache(new Map([[dir, entries]]))
      if (openLast) {
        const saved = await window.api.settings.get(SettingsKeys.FilesLastFile)
        if (saved) void openFile(dir, saved, true)
      }
    } catch {
      setRootErr(true)
      await window.api.settings.set(SettingsKeys.FilesRootPath, '')
      await window.api.settings.set(SettingsKeys.FilesLastFile, '')
    }
  }

  /** 换文件夹：系统弹窗选取 → 持久化 → 重载（旧展开/查看态全部作废） */
  const changeFolder = async (): Promise<void> => {
    const picked = await window.api.explorer.pickFolder()
    if (!picked) return
    await window.api.settings.set(SettingsKeys.FilesRootPath, picked)
    await window.api.settings.set(SettingsKeys.FilesLastFile, '')
    await loadRoot(picked, false)
  }

  /** 刷新：重读根层与全部已展开层（外部变更靠手动刷新，无 fs watcher）；失效层剔除 */
  const refresh = async (): Promise<void> => {
    if (!root) return
    const targets = [root, ...expanded]
    const next = new Map<string, Entry[] | 'loading'>()
    const nextExpanded = new Set(expanded)
    await Promise.all(
      targets.map(async (p) => {
        try {
          next.set(p, await window.api.explorer.readDir(root, p))
        } catch {
          nextExpanded.delete(p)
        }
      })
    )
    setDirCache(next)
    setExpanded(nextExpanded)
  }

  // 初始化：恢复面板宽度 + 上次文件夹（不存在则清设置回空态）
  useEffect(() => {
    void (async () => {
      const savedW = await window.api.settings.get(SettingsKeys.FilesWidth)
      const w = savedW ? Number(savedW) : NaN
      if (Number.isFinite(w) && w >= FILEX_WIDTH_MIN && w <= FILEX_WIDTH_MAX) {
        setFilexWidth(w)
        applyFilexWidth(w)
      }
      const savedRoot = await window.api.settings.get(SettingsKeys.FilesRootPath)
      if (savedRoot) await loadRoot(savedRoot, true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 拖拽左缘调宽：移动中实时生效，松手持久化（口径同画布/草稿本） */
  const startResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = filexWidth
    const onMove = (ev: MouseEvent): void => {
      const w = clampFilexWidth(startWidth - (ev.clientX - startX))
      setFilexWidth(w)
      applyFilexWidth(w)
    }
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      void window.api.settings.set(
        SettingsKeys.FilesWidth,
        String(clampFilexWidth(startWidth - (ev.clientX - startX)))
      )
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
  }

  /** 递归渲染树节点（函数递归非嵌套组件，避免子树重挂） */
  const renderNodes = (entries: Entry[], depth: number): ReactNode => {
    return sortEntries(entries).map((entry) => {
      const isDir = entry.type === 'dir'
      const isOpen = expanded.has(entry.path)
      const child = dirCache.get(entry.path)
      return (
        <Fragment key={entry.path}>
          <div
            className={`filex-node${activePath === entry.path ? ' active' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => void (isDir ? toggleDir(root!, entry) : openFile(root!, entry.path))}
            title={entry.path}
          >
            <span className="filex-node-twist">
              {isDir && (
                <span className="material-symbols-outlined">
                  {isOpen ? 'expand_more' : 'chevron_right'}
                </span>
              )}
            </span>
            <span className="material-symbols-outlined filex-node-ico">
              {isDir ? (isOpen ? 'folder_open' : 'folder') : fileIcon(entry.name)}
            </span>
            <span className="filex-node-name">{entry.name}</span>
          </div>
          {isDir && isOpen && child === 'loading' && (
            <div className="filex-node-loading" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              加载中…
            </div>
          )}
          {isDir && isOpen && Array.isArray(child) && renderNodes(child, depth + 1)}
        </Fragment>
      )
    })
  }

  const rootEntries = root != null ? dirCache.get(root) : undefined
  const rootName = root ? (root.split(/[\\/]/).filter(Boolean).pop() ?? root) : ''
  const viewName = view.kind !== 'browse' ? (view.path.split(/[\\/]/).pop() ?? view.path) : ''
  /** 相对根目录的面包屑文本（如 src/components/App.tsx） */
  const crumb =
    view.kind !== 'browse' && root && view.path.startsWith(root)
      ? view.path.slice(root.length).replace(/^[/\\]+/, '') || view.path
      : view.kind !== 'browse'
        ? view.path
        : ''

  return (
    <aside className="filex-sidebar">
      <div className="filex-resizer" onMouseDown={startResize} title="拖拽调整宽度" />
      <div className="filex-header">
        <span className="material-symbols-outlined">folder_open</span>
        <span className="filex-title">资源管理器</span>
        <button className="btn btn-ghost" onClick={onCollapse} title="收起">
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      </div>

      {root == null || rootErr ? (
        <div className="filex-empty">
          <span className="material-symbols-outlined">folder_off</span>
          <div className="filex-empty-text">
            {rootErr ? '上次文件夹不存在或无法读取' : '还没有选择文件夹'}
          </div>
          <button className="btn btn-primary" onClick={() => void changeFolder()}>
            <span className="material-symbols-outlined">drive_folder_upload</span>
            选择文件夹
          </button>
        </div>
      ) : view.kind === 'browse' ? (
        <>
          <div className="filex-toolbar">
            <span className="filex-toolbar-name" title={root}>
              {rootName}
            </span>
            <button className="btn btn-ghost" onClick={() => void refresh()} title="刷新">
              <span className="material-symbols-outlined">refresh</span>
            </button>
            <button className="btn btn-ghost" onClick={() => void changeFolder()} title="换文件夹">
              <span className="material-symbols-outlined">create_new_folder</span>
            </button>
          </div>
          <div className="filex-tree">
            {rootEntries === 'loading' && <div className="filex-node-loading">加载中…</div>}
            {Array.isArray(rootEntries) && rootEntries.length === 0 && (
              <div className="filex-tree-empty">空文件夹</div>
            )}
            {Array.isArray(rootEntries) && rootEntries.length > 0 && renderNodes(rootEntries, 0)}
          </div>
        </>
      ) : (
        <>
          <div className="filex-toolbar">
            <button
              className="btn btn-ghost"
              onClick={() => {
                setView({ kind: 'browse' })
                setActivePath(null)
              }}
              title="返回文件树"
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <span className="filex-toolbar-name" title={view.path}>
              {viewName}
            </span>
          </div>
          <div className="filex-crumb">{crumb}</div>
          <div className="filex-view">
            {view.kind === 'code' && <CodePane content={view.content} lang={view.lang} />}
            {view.kind === 'md' && (
              <div className="filex-md">
                <MdView md={view.md} />
              </div>
            )}
            {view.kind === 'image' && (
              <div className="filex-image">
                <img src={view.url} alt={viewName} />
              </div>
            )}
            {view.kind === 'unsupported' && (
              <div className="filex-unsupported">
                <span className="material-symbols-outlined">block</span>
                {view.reason}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  )
}
