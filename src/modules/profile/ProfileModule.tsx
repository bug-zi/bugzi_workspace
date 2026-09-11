// 个人中心模块（个人中心 specs 全量 + 我的画像：致知己 specs §3）
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { LlmConfig, McpConfig, McpResearch, ProfileFactRow } from '../../renderer/api'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useAppSettings } from '../../theme/ThemeProvider'
import { useModuleActivated } from '../../hooks/useModuleActivated'
import { FONT_FAMILIES } from '../../theme/fonts'
import { LLM_SCENE_LABELS, SettingsKeys, TERMINAL_DEFAULTS, parseTerminalSettings } from '../../shared/types'
import type { LlmUsageRecord, LlmUsageStats, TerminalSettings } from '../../shared/types'
import BgLibraryDialog from './BgLibraryDialog'

/** 画像类别预设（datalist 建议，可自定义输入；与主进程画像提炼指令同款清单） */
const PROFILE_CATEGORIES = [
  '基本档案', '性格特质', '擅长能力', '兴趣爱好', '生活方式', '社交出行',
  '学习与技能', '职业规划', '价值观', '其他'
]

// 内置字体 FONT_FAMILIES 已迁共享模块 src/theme/fonts.ts（字体选择轮 §1.1，书架字体浮层反查全局名共用）

/** 字体大小默认/范围（优化建议区：默认 16px，10-24px） */
const FONT_SIZE_DEFAULT = 16
const FONT_SIZE_MIN = 10
const FONT_SIZE_MAX = 24

/** 字体粗细 100-900 每 100 一档（优化建议区「粗细细化」） */
const FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

export default function ProfileModule() {
  const { toast } = useToast()
  const { settings, setSetting, theme, setTheme } = useAppSettings()
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  const [avatar, setAvatar] = useState('')
  // LLM
  const [llms, setLlms] = useState<LlmConfig[]>([])
  const [defaultId, setDefaultId] = useState('')
  const [llmForm, setLlmForm] = useState<LlmConfig | null>(null)
  const [testJob, setTestJob] = useState<string | null>(null)
  const testing = testJob != null
  const [delLlm, setDelLlm] = useState<LlmConfig | null>(null)
  // 上游模型列表（优化建议区 #1）
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  // MCP
  const [mcps, setMcps] = useState<McpConfig[]>([])
  const [mcpForm, setMcpForm] = useState<{ name: string; url: string } | null>(null)
  const [delMcp, setDelMcp] = useState<McpConfig | null>(null)
  // AI 辅助 MCP 配置（问题疑惑区方案）：输入名 → 研究 → 填 key → 测试 → 保存
  const [aiQuery, setAiQuery] = useState<{ name: string; url: string } | null>(null)
  const [researchJob, setResearchJob] = useState<string | null>(null)
  const researching = researchJob != null
  const [research, setResearch] = useState<McpResearch | null>(null)
  const [researchErr, setResearchErr] = useState<string | null>(null)
  const [aiKey, setAiKey] = useState('')
  const [mcpTestJob, setMcpTestJob] = useState<string | null>(null)
  const mcpTesting = mcpTestJob != null
  const [mcpTestOk, setMcpTestOk] = useState<string[] | null>(null)
  // 数据存储（优化建议区 #2）
  const [dataDir, setDataDir] = useState('')
  const [migrating, setMigrating] = useState(false)
  const [migrateConfirm, setMigrateConfirm] = useState<{ dir: string } | null>(null)
  // 终端设置（260912）：默认 shell + 默认工作目录（面板高度由面板自身拖拽记忆）
  const [termCfg, setTermCfg] = useState<TerminalSettings>(TERMINAL_DEFAULTS)
  // 我的画像（致知己 specs §3）：条目式画像，注入全部 AI 上下文
  const [facts, setFacts] = useState<ProfileFactRow[]>([])
  const [factForm, setFactForm] = useState<{ id: number | null; category: string; content: string } | null>(null)
  const [delFact, setDelFact] = useState<ProfileFactRow | null>(null)
  // 分组折叠：类别 → 是否收起；默认全收起（260910 开发者指令：新开项目画像条目默认收起），
  // 显式展开过的类别当次会话记住；内存态不持久化（同格言库区折叠范式）
  const [catCollapsed, setCatCollapsed] = useState<Record<string, boolean>>({})
  // 画像 zone 整体折叠（260910 指令改默认收起：新开项目只留「我的画像」大标题，计数徽标常驻）；
  // 展开后小分类仍默认收起（见上 catCollapsed），点开当次会话记住；内存态不持久化
  const [zoneCollapsed, setZoneCollapsed] = useState(true)

  // ---------- AI 使用统计（260910 推理角效率优化） ----------
  const [usageRange, setUsageRange] = useState<'today' | 'month' | 'all'>('today')
  const [usage, setUsage] = useState<LlmUsageStats | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  // AI 使用 zone 整体折叠（260910 追加）：画像 zone 同范式，默认展开，收起时计数徽标常驻（当前范围调用次数）
  const [usageZoneCollapsed, setUsageZoneCollapsed] = useState(false)
  const loadUsage = useCallback(async () => {
    setUsageLoading(true)
    try {
      setUsage(await window.api.llmUsage.stats(usageRange))
    } catch {
      /* 静默保留上次数据 */
    } finally {
      setUsageLoading(false)
    }
  }, [usageRange])
  useEffect(() => {
    void loadUsage()
  }, [loadUsage])
  // 调用记录（260910 明细，同日修订为模式切换）：AI 使用区「按类别/按时间」两视图——
  // 按类别=原有场景聚合（随今日/本月/全部），按时间=最近 30 条滚动明细（与时间范围无关）；
  // 视图内存态不持久化（切模块重置），默认按类别
  const [usageView, setUsageView] = useState<'scene' | 'time'>('scene')
  const [usageRecords, setUsageRecords] = useState<LlmUsageRecord[]>([])
  // 加载失败可见化（260910 修订）：区分「无记录」与「加载失败」，不再静默伪装成空态
  const [recordsError, setRecordsError] = useState<string | null>(null)
  const loadRecords = useCallback(async () => {
    try {
      setUsageRecords(await window.api.llmUsage.records())
      setRecordsError(null)
    } catch (e) {
      setRecordsError(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => {
    void loadRecords()
  }, [loadRecords])
  // 切到按时间视图自动拉一次（挂载早于 IPC 就绪时的失败自愈重试；30 行轻查询）
  useEffect(() => {
    if (usageView === 'time') void loadRecords()
  }, [usageView, loadRecords])
  // AI 空闲时自动刷新（后台生成结束数字即新）；记录与统计一起重拉
  useEffect(() => {
    return window.api.llmUsage.onActivity((p) => {
      if (p.items.length === 0) {
        void loadUsage()
        void loadRecords()
      }
    })
  }, [loadUsage, loadRecords])
  const fmtTokens = (n: number): string => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n))
  /** 记录时间：今天 HH:mm:ss，更早 MM-dd HH:mm（滚动 30 条可能跨天，本地时区） */
  const fmtRecordTime = (iso: string): string => {
    const d = new Date(iso)
    const now = new Date()
    const two = (n: number): string => String(n).padStart(2, '0')
    const sameDay =
      d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
    return sameDay
      ? `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
      : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
  }

  /** 画像条目加载 */
  const loadFacts = useCallback(async () => {
    setFacts(await window.api.profile.list())
  }, [])

  useEffect(() => {
    void loadFacts()
  }, [loadFacts])

  /** 画像按类别分组：预设清单序在前，自定义类别按首次出现追加其后 */
  const groupedFacts = useMemo(() => {
    const byCat = new Map<string, ProfileFactRow[]>()
    for (const f of facts) {
      const arr = byCat.get(f.category)
      if (arr) arr.push(f)
      else byCat.set(f.category, [f])
    }
    const order = [
      ...PROFILE_CATEGORIES.filter((c) => byCat.has(c)),
      ...[...byCat.keys()].filter((c) => !PROFILE_CATEGORIES.includes(c))
    ]
    return order.map((category) => ({ category, items: byCat.get(category)! }))
  }, [facts])

  // keep-alive：切回个人中心时刷新（AI 边栏建议入档后回来看最新）
  useModuleActivated('profile', () => void loadFacts())

  // 载入
  useEffect(() => {
    setName(settings[SettingsKeys.UserName] ?? '')
    setBio(settings[SettingsKeys.UserBio] ?? '')
    setAvatar(settings[SettingsKeys.UserAvatar] ?? '')
    try {
      setLlms(JSON.parse(settings[SettingsKeys.LlmConfigs] ?? '[]'))
    } catch { /* 空值 */ }
    setDefaultId(settings[SettingsKeys.LlmDefaultId] ?? '')
    try {
      setMcps(JSON.parse(settings[SettingsKeys.McpConfigs] ?? '[]'))
    } catch { /* 空值 */ }
    setTermCfg(parseTerminalSettings(settings[SettingsKeys.Terminal]))
    void window.api.storage.currentDir().then(setDataDir)
  }, [settings])

  const saveJson = useCallback(
    async (key: string, value: unknown) => {
      await setSetting(key, JSON.stringify(value))
    },
    [setSetting]
  )

  // ---------- 终端设置（260912） ----------
  const saveTerminalCfg = (patch: Partial<TerminalSettings>): void => {
    const next = { ...termCfg, ...patch }
    setTermCfg(next)
    void window.api.settings.set(SettingsKeys.Terminal, JSON.stringify(next))
  }
  const pickTerminalDir = async (): Promise<void> => {
    const dir = await window.api.storage.pickDir()
    if (dir) saveTerminalCfg({ cwd: dir })
  }

  // ---------- 个人信息 ----------
  const commitName = async (): Promise<void> => {
    if (name.trim() && name !== (settings[SettingsKeys.UserName] ?? '')) {
      await setSetting(SettingsKeys.UserName, name.trim())
      toast('用户名已保存')
    }
  }
  const commitBio = async (): Promise<void> => {
    if (bio !== (settings[SettingsKeys.UserBio] ?? '')) {
      await setSetting(SettingsKeys.UserBio, bio)
      toast('签名已保存')
    }
  }
  const pickAvatar = async (): Promise<void> => {
    const r = await window.api.image.pick('avatar')
    if (r) {
      const file = await window.api.settings.get(SettingsKeys.UserAvatar)
      setAvatar(file ?? '')
      toast('头像已更新')
    }
  }

  // ---------- 字体（即时生效 + 自动保存） ----------
  const applyFont = async (key: string, value: string): Promise<void> => {
    document.documentElement.style.setProperty(
      key === SettingsKeys.FontSize ? '--font-size' : key === SettingsKeys.FontFamily ? '--font-family' : '--font-weight',
      key === SettingsKeys.FontSize ? `${value}px` : value
    )
    await setSetting(key, value)
  }

  // ---------- LLM ----------
  const saveLlm = async (): Promise<void> => {
    if (!llmForm) return
    if (!llmForm.name.trim() || !llmForm.apiUrl.trim() || !llmForm.model.trim()) {
      toast('名称、API 地址、模型名必填')
      return
    }
    const next = llms.some((l) => l.id === llmForm.id)
      ? llms.map((l) => (l.id === llmForm.id ? llmForm : l))
      : [...llms, llmForm]
    setLlms(next)
    await saveJson(SettingsKeys.LlmConfigs, next)
    if (next.length === 1 && !defaultId) {
      setDefaultId(llmForm.id)
      await setSetting(SettingsKeys.LlmDefaultId, llmForm.id)
    }
    setLlmForm(null)
    toast('LLM 配置已保存')
  }

  const doDeleteLlm = async (): Promise<void> => {
    if (!delLlm) return
    const next = llms.filter((l) => l.id !== delLlm.id)
    setLlms(next)
    await saveJson(SettingsKeys.LlmConfigs, next)
    if (defaultId === delLlm.id) {
      const nd = next[0]?.id ?? ''
      setDefaultId(nd)
      await setSetting(SettingsKeys.LlmDefaultId, nd)
    }
    setDelLlm(null)
    toast('已删除')
  }

  const setDefault = async (id: string): Promise<void> => {
    setDefaultId(id)
    await setSetting(SettingsKeys.LlmDefaultId, id)
  }

  const testLlm = async (): Promise<void> => {
    if (!llmForm) return
    const jobId = crypto.randomUUID()
    setTestJob(jobId)
    try {
      await window.api.llm.test(jobId, llmForm)
      toast('连接成功')
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else toast(`连接失败：${msg.slice(0, 120)}`)
    } finally {
      setTestJob(null)
    }
  }

  // 从上游拉取模型列表（优化建议区 #1）：需先填 API 地址
  const fetchModels = async (): Promise<void> => {
    if (!llmForm) return
    if (!llmForm.apiUrl.trim()) {
      toast('请先填写 API 地址')
      return
    }
    setLoadingModels(true)
    try {
      const list = await window.api.llm.models(llmForm)
      setModels(list)
      toast(`获取到 ${list.length} 个模型`)
    } catch (e) {
      setModels([])
      toast(`获取失败：${String((e as Error).message).slice(0, 120)}`)
    } finally {
      setLoadingModels(false)
    }
  }

  // ---------- MCP ----------
  const saveMcp = async (): Promise<void> => {
    if (!mcpForm) return
    if (!mcpForm.name.trim() || !mcpForm.url.trim()) {
      toast('名称与地址必填')
      return
    }
    const next = [...mcps, { id: uid(), name: mcpForm.name.trim(), url: mcpForm.url.trim(), kind: 'http' as const, enabled: true }]
    setMcps(next)
    await saveJson(SettingsKeys.McpConfigs, next)
    setMcpForm(null)
    toast('MCP 已添加')
  }

  const toggleMcp = async (m: McpConfig, enabled: boolean): Promise<void> => {
    const next = mcps.map((x) => (x.id === m.id ? { ...x, enabled } : x))
    setMcps(next)
    await saveJson(SettingsKeys.McpConfigs, next)
  }

  const doDeleteMcp = async (): Promise<void> => {
    if (!delMcp) return
    const next = mcps.filter((x) => x.id !== delMcp.id)
    setMcps(next)
    await saveJson(SettingsKeys.McpConfigs, next)
    setDelMcp(null)
    toast('已删除')
  }

  // ---------- AI 辅助 MCP 配置（问题疑惑区方案） ----------
  /** 启动研究：三步降级（Registry → 文档 → LLM），成功后进入结果表单 */
  const doResearch = async (): Promise<void> => {
    if (!aiQuery?.name.trim()) {
      toast('请先填写 MCP 名称')
      return
    }
    const jobId = crypto.randomUUID()
    setResearchJob(jobId)
    setResearch(null)
    setResearchErr(null)
    setAiKey('')
    setMcpTestOk(null)
    try {
      const r = await window.api.mcp.research(jobId, aiQuery.name.trim())
      setResearch(r)
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else setResearchErr(msg)
    } finally {
      setResearchJob(null)
    }
  }

  /** 研究结果的端点：{apiKey} 占位符用用户填写的 key 替换（无占位符则原样） */
  const resolvedUrl = (r: McpResearch, key: string): string =>
    r.urlTemplate.includes('{apiKey}') && key.trim()
      ? r.urlTemplate.replace('{apiKey}', encodeURIComponent(key.trim()))
      : r.urlTemplate

  /** 测试连接：跑 initialize + tools/list */
  const doTestMcp = async (): Promise<void> => {
    if (!research) return
    const url = resolvedUrl(research, aiKey)
    if (!/^https?:\/\//.test(url)) {
      toast('端点地址无效')
      return
    }
    const jobId = crypto.randomUUID()
    setMcpTestJob(jobId)
    setMcpTestOk(null)
    try {
      const r = await window.api.mcp.test(jobId, {
        name: research.title,
        url,
        authType: research.authType,
        apiKey: research.authType === 'bearer' ? aiKey.trim() : undefined
      })
      setMcpTestOk(r.tools)
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('已取消')) toast('已取消')
      else toast(`连接失败：${msg.slice(0, 160)}`)
    } finally {
      setMcpTestJob(null)
    }
  }

  /** 保存研究结果为 MCP 配置（需密钥时必填 + 已测试通过才可保存） */
  const saveResearched = async (): Promise<void> => {
    if (!research || !aiQuery) return
    const needKey = research.keys.length > 0
    if (needKey && !aiKey.trim()) {
      toast(`请先填写 ${research.keys[0].name}`)
      return
    }
    if (needKey && !mcpTestOk) {
      toast('请先测试连接通过')
      return
    }
    const next = [
      ...mcps,
      {
        id: uid(),
        name: research.title || aiQuery.name.trim(),
        url: resolvedUrl(research, aiKey),
        kind: 'http' as const,
        enabled: true,
        authType: research.authType,
        apiKey: research.authType === 'bearer' ? aiKey.trim() : undefined
      }
    ]
    setMcps(next)
    await saveJson(SettingsKeys.McpConfigs, next)
    setAiQuery(null)
    setResearch(null)
    setAiKey('')
    setMcpTestOk(null)
    toast('MCP 已添加')
  }

  // 背景素材库弹窗（优化建议区第36轮：原「背景图（浅/深）」两行升级为素材库管理）
  const [bgLibOpen, setBgLibOpen] = useState(false)

  // ---------- 我的画像（致知己 specs §3） ----------
  const saveFact = async (): Promise<void> => {
    if (!factForm) return
    if (!factForm.category.trim() || !factForm.content.trim()) {
      toast('类别与内容必填')
      return
    }
    if (factForm.id != null) {
      await window.api.profile.update(factForm.id, factForm.category, factForm.content)
    } else {
      await window.api.profile.add(factForm.category, factForm.content)
    }
    setFactForm(null)
    await loadFacts()
    toast('画像已保存（将注入全部 AI 功能）')
  }

  const doDeleteFact = async (): Promise<void> => {
    if (!delFact) return
    await window.api.profile.delete(delFact.id)
    setDelFact(null)
    await loadFacts()
    toast('已删除')
  }

  // ---------- 数据存储（优化建议区 #2） ----------
  const pickDataDir = async (): Promise<void> => {
    const dir = await window.api.storage.pickDir()
    if (!dir) return
    setMigrateConfirm({ dir })
  }

  const doMigrate = async (): Promise<void> => {
    if (!migrateConfirm) return
    setMigrating(true)
    try {
      await window.api.storage.migrate(migrateConfirm.dir)
      toast('迁移完成，即将重启…')
      await new Promise((r) => setTimeout(r, 800)) // 让 toast 可见
      await window.api.storage.relaunch()
    } catch (e) {
      const code = String((e as Error).message)
      const msg =
        code === 'SAME_DIR'
          ? '新位置与当前存储位置相同'
          : code === 'TARGET_HAS_DATA'
            ? '目标位置已存在数据（bugzi.db），请换一个空目录'
            : code.startsWith('POINTER_WRITE_FAILED')
              ? `指针写入失败：${code.slice(code.indexOf(':') + 1)}`
              : `迁移失败：${code}`
      toast(msg)
      setMigrating(false)
    }
  }

  const fontSettings = settings
  // 旧值兜底：已删除的字体（宋体/黑体/等线等不在列表的存量值）回退显示默认
  const fontFamilyValue = fontSettings[SettingsKeys.FontFamily] ?? ''
  const fontFamilySelected = FONT_FAMILIES.some((f) => f.value === fontFamilyValue)
    ? fontFamilyValue
    : FONT_FAMILIES[0].value

  return (
    <div className="profile-page">
      <div className="module-header">
        <span className="material-symbols-outlined">person</span>
        <span className="module-title">个人档</span>
      </div>

      {/* 个人信息 */}
      <section className="zone">
        <div className="zone-header"><span>个人信息</span></div>
        <div className="zone-body" style={{ padding: 14, display: 'flex', gap: 16, alignItems: 'center' }}>
          <button className="avatar-box" onClick={() => void pickAvatar()} title="更换头像">
            {avatar ? (
              <img src={`bzres://root/${avatar}`} alt="头像" />
            ) : (
              <span className="material-symbols-outlined" style={{ fontSize: 34 }}>person</span>
            )}
          </button>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void commitName()}
              placeholder="用户名（失焦保存）"
            />
            <input
              className="field"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              onBlur={() => void commitBio()}
              placeholder="个性签名（失焦保存）"
            />
          </div>
        </div>
      </section>

      {/* 我的画像（致知己 specs §3）：条目式画像，注入全部 AI 上下文 */}
      <section className="zone">
        <div className="zone-header" onClick={() => setZoneCollapsed((v) => !v)}>
          <span className="material-symbols-outlined">{zoneCollapsed ? 'expand_more' : 'expand_less'}</span>
          <span>我的画像</span>
          <span className="zone-count">{facts.length}</span>
          <div className="zone-actions" onClick={(e) => e.stopPropagation()}>
            <button className="btn" onClick={() => setFactForm({ id: null, category: '', content: '' })}>
              <span className="material-symbols-outlined">add</span>
              新增
            </button>
          </div>
        </div>
        {!zoneCollapsed && (
        <div className="zone-body">
          {facts.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">self_improvement</span>
              暂无画像条目；手填或在与 AI 对话中由 AI 提炼建议、经确认入档。AI 会记住画像，需要了解你时按需取用
            </div>
          )}
          {groupedFacts.map((g) => {
            // 260910 默认收起：未显式展开（undefined）视为收起，点开置 false 当次会话记住
            const collapsed = catCollapsed[g.category] !== false
            return (
              <div key={g.category}>
                <div
                  className="profile-cat-header"
                  onClick={() => setCatCollapsed((c) => ({ ...c, [g.category]: !collapsed }))}
                >
                  <span className="material-symbols-outlined">{collapsed ? 'expand_more' : 'expand_less'}</span>
                  <span>{g.category}</span>
                  <span className="zone-count">{g.items.length}</span>
                </div>
                {!collapsed &&
                  g.items.map((f) => (
                    <div className="row-item" key={f.id} style={{ cursor: 'default' }}>
                      <div className="row-main">
                        <div className="row-title" title={f.content}>
                          {f.content}
                          {f.source === 'ai' && <span className="badge">AI</span>}
                        </div>
                      </div>
                      <div className="row-actions">
                        <button
                          className="icon-btn"
                          title="编辑"
                          onClick={() => setFactForm({ id: f.id, category: f.category, content: f.content })}
                        >
                          <span className="material-symbols-outlined">edit</span>
                        </button>
                        <button className="icon-btn danger" title="删除" onClick={() => setDelFact(f)}>
                          <span className="material-symbols-outlined">delete</span>
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            )
          })}
        </div>
        )}
      </section>

      {/* App 设置 */}
      <section className="zone">
        <div className="zone-header"><span>App 设置</span></div>
        <div className="zone-body" style={{ padding: 0 }}>
          <div className="setting-row">
            <span className="setting-label">字体大小</span>
            <input
              type="range"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step={1}
              value={Number(fontSettings[SettingsKeys.FontSize] ?? FONT_SIZE_DEFAULT)}
              onChange={(e) => void applyFont(SettingsKeys.FontSize, e.target.value)}
              style={{ flex: 1, accentColor: 'var(--color-primary)' }}
            />
            <span className="badge">{fontSettings[SettingsKeys.FontSize] ?? FONT_SIZE_DEFAULT}px</span>
          </div>
          <div className="setting-row">
            <span className="setting-label">字体样式</span>
            <select
              className="field grow"
              value={fontFamilySelected}
              onChange={(e) => void applyFont(SettingsKeys.FontFamily, e.target.value)}
            >
              {FONT_FAMILIES.map((f) => (
                <option key={f.label} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <span className="setting-label">字体粗细</span>
            <input
              type="range"
              min={100}
              max={900}
              step={100}
              value={Number(fontSettings[SettingsKeys.FontWeight] ?? 400)}
              onChange={(e) => void applyFont(SettingsKeys.FontWeight, e.target.value)}
              style={{ flex: 1, accentColor: 'var(--color-primary)' }}
            />
            <span className="badge">{fontSettings[SettingsKeys.FontWeight] ?? 400}</span>
          </div>
          <div className="setting-row">
            <span className="setting-label">主题</span>
            <select
              className="field grow"
              value={theme}
              onChange={(e) => setTheme(e.target.value as 'light' | 'dark')}
            >
              <option value="light">浅色（樱花粉）</option>
              <option value="dark">深色（宝蓝）</option>
            </select>
          </div>
          <div className="setting-row">
            <span className="setting-label">背景素材库</span>
            <button className="btn" onClick={() => setBgLibOpen(true)}>
              <span className="material-symbols-outlined">wallpaper</span>
              管理素材库
            </button>
          </div>
        </div>
      </section>

      {/* 终端（260912 新功能开发区） */}
      <section className="zone">
        <div className="zone-header"><span>终端</span></div>
        <div className="zone-body" style={{ padding: 0 }}>
          <div className="setting-row">
            <span className="setting-label">默认 Shell</span>
            <select
              className="field grow"
              value={termCfg.shell}
              onChange={(e) => saveTerminalCfg({ shell: e.target.value as TerminalSettings['shell'] })}
            >
              <option value="powershell">PowerShell</option>
              <option value="pwsh">PowerShell 7（pwsh）</option>
              <option value="cmd">cmd</option>
            </select>
          </div>
          <div className="setting-row">
            <span className="setting-label">默认工作目录</span>
            <span
              className="grow"
              style={{ wordBreak: 'break-all', fontSize: '0.85em', color: 'var(--color-text-secondary)' }}
              title={termCfg.cwd}
            >
              {termCfg.cwd}
            </span>
            <button className="btn" onClick={() => void pickTerminalDir()}>
              <span className="material-symbols-outlined">folder_open</span>
              选择
            </button>
          </div>
        </div>
      </section>

      {/* 数据存储（优化建议区 #2） */}
      <section className="zone">
        <div className="zone-header"><span>数据存储</span></div>
        <div className="zone-body" style={{ padding: 0 }}>
          <div className="setting-row">
            <span className="setting-label">当前存储位置</span>
            <span
              className="grow"
              style={{ wordBreak: 'break-all', fontSize: '0.85em', color: 'var(--color-text-secondary)' }}
              title={dataDir}
            >
              {dataDir || '读取中…'}
            </span>
            <button
              className="btn"
              onClick={() => dataDir && void window.api.storage.openDir(dataDir)}
              disabled={!dataDir}
              title="在资源管理器中打开"
            >
              <span className="material-symbols-outlined">folder_open</span>
              打开
            </button>
          </div>
          <div className="setting-row">
            <span className="setting-label">修改存储位置</span>
            <span className="grow module-sub">迁移全部数据（数据库/文档/图片）到新位置，完成后自动重启</span>
            <button className="btn" onClick={() => void pickDataDir()} disabled={migrating}>
              <span className="material-symbols-outlined">drive_file_move</span>
              {migrating ? '迁移中…' : '修改'}
            </button>
          </div>
        </div>
      </section>

      {/* LLM 配置 */}
      <section className="zone">
        <div className="zone-header">
          <span>LLM 配置</span>
          <span className="zone-count">{llms.length}</span>
          <div className="zone-actions">
            <button
              className="btn"
              onClick={() => setLlmForm({ id: uid(), name: '', apiUrl: '', apiKey: '', model: '' })}
            >
              <span className="material-symbols-outlined">add</span>
              新增
            </button>
          </div>
        </div>
        <div className="zone-body">
          {llms.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">smart_toy</span>
              暂无配置，新增一套以启用 AI 功能（任何 OpenAI 兼容接口）
            </div>
          )}
          {llms.map((l) => (
            <div className={`llm-item${l.id === defaultId ? ' default' : ''}`} key={l.id}>
              <input
                type="radio"
                name="llm-default"
                checked={l.id === defaultId}
                onChange={() => void setDefault(l.id)}
                title="设为默认"
              />
              <div className="row-main">
                <div className="row-title">
                  {l.name} {l.id === defaultId && <span className="badge primary">默认</span>}
                </div>
                <div className="row-sub">{l.apiUrl} ｜ {l.model}</div>
              </div>
              <div className="row-actions">
                <button className="icon-btn" title="编辑" onClick={() => setLlmForm({ ...l })}>
                  <span className="material-symbols-outlined">edit</span>
                </button>
                <button className="icon-btn danger" title="删除" onClick={() => setDelLlm(l)}>
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* AI 使用统计（260910 推理角效率优化；zone 折叠 260910 追加） */}
      <section className="zone">
        <div className="zone-header" onClick={() => setUsageZoneCollapsed((v) => !v)}>
          <span className="material-symbols-outlined">
            {usageZoneCollapsed ? 'expand_more' : 'expand_less'}
          </span>
          <span>AI 使用</span>
          {usage && <span className="zone-count">{usage.totals.calls}</span>}
          <div className="zone-actions" onClick={(e) => e.stopPropagation()}>
            <div className="llm-usage-range">
              {(['scene', 'time'] as const).map((m) => (
                <button
                  key={m}
                  className={`btn chip${usageView === m ? ' active' : ''}`}
                  onClick={() => setUsageView(m)}
                >
                  {m === 'scene' ? '按类别' : '按时间'}
                </button>
              ))}
            </div>
            {usageView === 'scene' && (
              <div className="llm-usage-range">
                {(['today', 'month', 'all'] as const).map((r) => (
                  <button
                    key={r}
                    className={`btn chip${usageRange === r ? ' active' : ''}`}
                    onClick={() => setUsageRange(r)}
                  >
                    {r === 'today' ? '今日' : r === 'month' ? '本月' : '全部'}
                  </button>
                ))}
              </div>
            )}
            <button
              className="btn"
              title="刷新"
              onClick={() => {
                void loadUsage()
                void loadRecords()
              }}
              disabled={usageLoading}
            >
              <span className="material-symbols-outlined">refresh</span>
            </button>
          </div>
        </div>
        {!usageZoneCollapsed && (
        <div className="zone-body">
          {usageView === 'scene' &&
            usage && (
              <>
              <div className="llm-usage-cards">
                <div className="llm-usage-card">
                  <div className="llm-usage-num">{usage.totals.calls}</div>
                  <div className="llm-usage-sub">调用次数（失败 {usage.totals.failures}）</div>
                </div>
                <div className="llm-usage-card">
                  <div className="llm-usage-num">{fmtTokens(usage.totals.tokens)}</div>
                  <div className="llm-usage-sub">token 消耗</div>
                </div>
              </div>
              {usage.rows.length === 0 ? (
                <div className="empty-state">
                  <span className="material-symbols-outlined">bar_chart</span>
                  该时间范围还没有 AI 调用
                </div>
              ) : (
                <table className="llm-usage-table">
                  <thead>
                    <tr>
                      <th>场景</th>
                      <th>次数</th>
                      <th>失败</th>
                      <th>平均耗时</th>
                      <th>token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.rows.map((r) => (
                      <tr key={r.scene}>
                        <td>{LLM_SCENE_LABELS[r.scene] ?? r.scene}</td>
                        <td>{r.calls}</td>
                        <td>{r.failures || '-'}</td>
                        <td>
                          {r.avgMs >= 1000 ? `${(r.avgMs / 1000).toFixed(1)}s` : `${r.avgMs}ms`}
                        </td>
                        <td>
                          {fmtTokens(r.tokens)}
                          {r.estRows > 0 ? ' ≈' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
          {/* 调用记录（260910 明细，同日修订为模式切换）：按时间视图 = 最近 30 条，与时间范围无关 */}
          {usageView === 'time' &&
            (recordsError ? (
              <div className="empty-state">
                <span className="material-symbols-outlined">cloud_off</span>
                调用记录加载失败：{recordsError}（点击右上角「刷新」重试）
              </div>
            ) : usageRecords.length === 0 ? (
              <div className="empty-state">
                <span className="material-symbols-outlined">history</span>
                还没有 AI 调用记录
              </div>
            ) : (
              <table className="llm-usage-table llm-usage-records-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>场景</th>
                    <th>模型</th>
                    <th>结果</th>
                    <th>耗时</th>
                    <th>token</th>
                  </tr>
                </thead>
                <tbody>
                  {usageRecords.map((r) => (
                    <Fragment key={r.id}>
                      <tr>
                        <td className="llm-usage-rec-time">{fmtRecordTime(r.createdAt)}</td>
                        <td>{LLM_SCENE_LABELS[r.scene] ?? r.scene}</td>
                        <td className="llm-usage-rec-model" title={`${r.configName} · ${r.model}`}>
                          {r.model}
                        </td>
                        <td>
                          {r.ok ? (
                            <span className="llm-usage-rec-ok">成功</span>
                          ) : (
                            <span className="llm-usage-rec-fail">失败</span>
                          )}
                        </td>
                        <td>
                          {r.durationMs >= 1000 ? `${(r.durationMs / 1000).toFixed(1)}s` : `${r.durationMs}ms`}
                        </td>
                        <td title={`输入 ${r.promptTokens} / 输出 ${r.completionTokens}`}>
                          {fmtTokens(r.promptTokens + r.completionTokens)}
                          {r.tokensEstimated ? ' ≈' : ''}
                        </td>
                      </tr>
                      {!r.ok && r.errorBrief && (
                        <tr className="llm-usage-record-error">
                          <td colSpan={6}>{r.errorBrief}</td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            ))}
        </div>
        )}
      </section>

      {/* MCP 配置 */}
      <section className="zone">
        <div className="zone-header">
          <span>MCP 配置</span>
          <span className="zone-count">{mcps.length}</span>
          <div className="zone-actions">
            <button
              className="btn"
              onClick={() => {
                setAiQuery({ name: '', url: '' })
                setResearch(null)
                setResearchErr(null)
              }}
              title="输入名称，AI 自动研究配置文档"
            >
              <span className="material-symbols-outlined">auto_awesome</span>
              AI 帮我配置
            </button>
            <button className="btn" onClick={() => setMcpForm({ name: '', url: '' })}>
              <span className="material-symbols-outlined">add</span>
              新增
            </button>
          </div>
        </div>
        <div className="zone-body">
          {mcps.length === 0 && (
            <div className="empty-state">
              <span className="material-symbols-outlined">hub</span>
              暂无配置（辩真阁联网搜索需要）
            </div>
          )}
          {mcps.map((m) => (
            <div className="mcp-item" key={m.id}>
              <div className="row-main">
                <div className="row-title">
                  {m.name}
                  {m.authType === 'bearer' && <span className="badge">Bearer</span>}
                </div>
                <div className="row-sub">{m.url}</div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.85em' }}>
                <input
                  type="checkbox"
                  checked={m.enabled}
                  onChange={(e) => void toggleMcp(m, e.target.checked)}
                  style={{ accentColor: 'var(--color-primary)' }}
                />
                启用
              </label>
              <button className="icon-btn danger" title="删除" onClick={() => setDelMcp(m)}>
                <span className="material-symbols-outlined">delete</span>
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* LLM 编辑弹窗 */}
      {llmForm && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setLlmForm(null)}>
          <div className="dialog" style={{ width: 480 }}>
            <div className="dialog-header">LLM 配置</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input className="field" placeholder="名称（自定义）" value={llmForm.name} onChange={(e) => setLlmForm({ ...llmForm, name: e.target.value })} />
              <input className="field" placeholder="API 地址（如 https://api.example.com）" value={llmForm.apiUrl} onChange={(e) => { setModels([]); setLlmForm({ ...llmForm, apiUrl: e.target.value }) }} />
              <input className="field" type="password" placeholder="API Key" value={llmForm.apiKey} onChange={(e) => setLlmForm({ ...llmForm, apiKey: e.target.value })} />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="field"
                  style={{ flex: 1 }}
                  placeholder="模型名（如 gpt-4o-mini）"
                  value={llmForm.model}
                  onChange={(e) => setLlmForm({ ...llmForm, model: e.target.value })}
                />
                <button
                  className="btn"
                  style={{ flexShrink: 0 }}
                  onClick={() => void fetchModels()}
                  disabled={loadingModels}
                  title="从上游服务获取可用模型列表"
                >
                  <span className="material-symbols-outlined">refresh</span>
                  {loadingModels ? '获取中…' : '获取模型'}
                </button>
              </div>
              {models.length > 0 && (
                <select
                  className="field"
                  value={llmForm.model}
                  onChange={(e) => setLlmForm({ ...llmForm, model: e.target.value })}
                >
                  <option value="">— 从列表选择模型 —</option>
                  {models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              )}
              <input
                className="field"
                type="number"
                min={1}
                placeholder="并发上限（选填，如 3；留空不限，满载不溢出到其他配置）"
                value={llmForm.maxConcurrent ?? ''}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  setLlmForm({
                    ...llmForm,
                    maxConcurrent: v && Number(v) > 0 ? Math.floor(Number(v)) : undefined
                  })
                }}
              />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => void testLlm()} disabled={testing}>
                {testing ? '测试中…' : '测试连接'}
              </button>
              {testJob && (
                <button className="btn" onClick={() => void window.api.ai.cancel(testJob)} title="取消本次测试">
                  <span className="material-symbols-outlined">stop_circle</span>
                  取消
                </button>
              )}
              <button className="btn" onClick={() => setLlmForm(null)}>取消</button>
              <button className="btn btn-primary" onClick={() => void saveLlm()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* MCP 新增弹窗 */}
      {mcpForm && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setMcpForm(null)}>
          <div className="dialog" style={{ width: 440 }}>
            <div className="dialog-header">新增 MCP</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input className="field" placeholder="名称" value={mcpForm.name} onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })} />
              <input className="field" placeholder="服务器地址（HTTP URL）" value={mcpForm.url} onChange={(e) => setMcpForm({ ...mcpForm, url: e.target.value })} />
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setMcpForm(null)}>取消</button>
              <button className="btn btn-primary" onClick={() => void saveMcp()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* AI 辅助 MCP 配置弹窗（问题疑惑区方案）：输入名称 → 研究 → 填 key → 测试 → 保存 */}
      {aiQuery && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setAiQuery(null)}>
          <div className="dialog" style={{ width: 560 }}>
            <div className="dialog-header">AI 帮我配置 MCP</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* 阶段一：输入名称 */}
              {!research && (
                <>
                  <div className="module-sub">
                    输入 MCP 名称，AI 自动研究官方配置文档（端点地址、鉴权方式、密钥申请入口）
                  </div>
                  <input
                    className="field"
                    placeholder="名称（如 Tavily、Firecrawl）"
                    value={aiQuery.name}
                    onChange={(e) => setAiQuery({ ...aiQuery, name: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && void doResearch()}
                    autoFocus
                  />
                  {researching && (
                    <div className="module-sub" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="material-symbols-outlined spin">progress_activity</span>
                      研究中（查 Registry → 读官方文档 → 模型知识，约需数十秒）…
                    </div>
                  )}
                  {researchErr && (
                    <div className="field" style={{ padding: 10, lineHeight: 1.7, wordBreak: 'break-all' }}>
                      {researchErr}
                    </div>
                  )}
                </>
              )}

              {/* 阶段二：研究结果表单 */}
              {research && (
                <>
                  <div>
                    <div className="row-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {research.title}
                      <span className="badge">
                        {research.source === 'registry' ? '官方 Registry' : research.source === 'docs' ? '官方文档' : '模型知识'}
                      </span>
                    </div>
                    {research.description && (
                      <div className="row-sub" style={{ marginTop: 4 }}>{research.description}</div>
                    )}
                  </div>

                  <div>
                    <div className="module-sub">端点地址{research.urlTemplate.includes('{apiKey}') && '（保存时自动拼入密钥）'}</div>
                    <div className="field" style={{ marginTop: 4, wordBreak: 'break-all', fontSize: '0.85em' }}>
                      {research.urlTemplate}
                    </div>
                  </div>

                  {/* 密钥填写（无鉴权服务不显示） */}
                  {research.keys.length > 0 ? (
                    <div>
                      <div className="module-sub">
                        {research.keys[0].description || '该服务需要 API 密钥'}
                        {research.keys[0].applyUrl && (
                          <>
                            {' '}
                            <a
                              href={research.keys[0].applyUrl}
                              onClick={(e) => {
                                e.preventDefault()
                                void window.api.shell.openExternal(research.keys[0].applyUrl)
                              }}
                              style={{ color: 'var(--color-primary)' }}
                            >
                              去申请
                            </a>
                          </>
                        )}
                      </div>
                      <input
                        className="field"
                        style={{ marginTop: 4 }}
                        type="password"
                        placeholder={research.keys[0].name}
                        value={aiKey}
                        onChange={(e) => {
                          setAiKey(e.target.value)
                          setMcpTestOk(null) // key 变更后需重新测试
                        }}
                        autoFocus
                      />
                      <div className="row-sub" style={{ marginTop: 4 }}>
                        鉴权：{research.authType === 'bearer' ? 'Bearer 请求头' : 'URL 参数'}
                      </div>
                    </div>
                  ) : (
                    <div className="module-sub">该端点无需鉴权</div>
                  )}

                  {mcpTestOk && (
                    <div className="module-sub" style={{ color: 'var(--color-primary)' }}>
                      连接成功，可用工具 {mcpTestOk.length} 个：{mcpTestOk.slice(0, 6).join('、')}
                      {mcpTestOk.length > 6 ? ' 等' : ''}
                    </div>
                  )}

                  {research.docsUrl && (
                    <div className="row-sub">
                      参考：
                      <a
                        href={research.docsUrl}
                        onClick={(e) => {
                          e.preventDefault()
                          void window.api.shell.openExternal(research.docsUrl)
                        }}
                        style={{ color: 'var(--color-primary)' }}
                      >
                        {research.docsUrl}
                      </a>
                    </div>
                  )}
                  <div className="row-sub" style={{ wordBreak: 'break-all' }}>{research.notes}</div>
                </>
              )}
            </div>
            <div className="dialog-footer">
              {research ? (
                <>
                  <button className="btn" onClick={() => { setResearch(null); setResearchErr(null) }}>
                    重新研究
                  </button>
                  <button className="btn" onClick={() => void doTestMcp()} disabled={mcpTesting}>
                    {mcpTesting ? '测试中…' : '测试连接'}
                  </button>
                  {mcpTestJob && (
                    <button
                      className="btn"
                      onClick={() => void window.api.ai.cancel(mcpTestJob)}
                      title="取消本次测试"
                    >
                      <span className="material-symbols-outlined">stop_circle</span>
                      取消
                    </button>
                  )}
                  <button className="btn btn-primary" onClick={() => void saveResearched()}>
                    保存
                  </button>
                </>
              ) : (
                <>
                  <button className="btn" onClick={() => setAiQuery(null)}>取消</button>
                  {researchJob && (
                    <button
                      className="btn"
                      onClick={() => void window.api.ai.cancel(researchJob)}
                      title="取消本次研究"
                    >
                      <span className="material-symbols-outlined">stop_circle</span>
                      取消
                    </button>
                  )}
                  <button className="btn btn-primary" onClick={() => void doResearch()} disabled={researching}>
                    {researching ? '研究中…' : '开始研究'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 数据迁移二次确认（优化建议区 #2） */}
      <ConfirmDialog
        open={migrateConfirm != null}
        title="修改数据存储位置"
        confirmText={migrating ? '迁移中…' : '开始迁移'}
        danger
        onConfirm={() => void doMigrate()}
        onCancel={() => !migrating && setMigrateConfirm(null)}
      >
        将把全部数据从
        <br />
        <span style={{ wordBreak: 'break-all' }}>{dataDir}</span>
        <br />
        迁移到
        <br />
        <span style={{ wordBreak: 'break-all' }}>{migrateConfirm?.dir}</span>
        <br />
        迁移完成后旧位置数据将被清理，App 自动重启。
      </ConfirmDialog>

      {/* 画像条目编辑弹窗（类别 datalist 预设 + 内容多行） */}
      {factForm && (
        <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && setFactForm(null)}>
          <div className="dialog" style={{ width: 440 }}>
            <div className="dialog-header">{factForm.id != null ? '编辑画像条目' : '新增画像条目'}</div>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                className="field"
                placeholder="类别（如：基本档案 / 性格特质 / 擅长能力 / 兴趣爱好 / 生活方式 / 社交出行 / 学习与技能 / 职业规划 / 价值观 / 其他）"
                list="profile-cats"
                value={factForm.category}
                onChange={(e) => setFactForm({ ...factForm, category: e.target.value })}
                autoFocus
              />
              <datalist id="profile-cats">
                {PROFILE_CATEGORIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <textarea
                className="field"
                placeholder="内容（一句话说清，如：计算机相关专业，正在研究 AI 开发与 Python 全栈）"
                value={factForm.content}
                onChange={(e) => setFactForm({ ...factForm, content: e.target.value })}
                rows={3}
                style={{ resize: 'vertical' }}
              />
              <div className="module-sub">画像以「记忆」方式供 AI 使用：对话中 AI 需要时按需检索，生成类功能注入精简摘要——让 AI 更懂你而不干扰作答</div>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setFactForm(null)}>取消</button>
              <button className="btn btn-primary" onClick={() => void saveFact()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      <ConfirmDialog
        open={delFact != null}
        title="删除画像条目"
        danger
        confirmText="删除"
        onConfirm={() => void doDeleteFact()}
        onCancel={() => setDelFact(null)}
      >
        确认删除「{delFact?.category}」这条画像？
      </ConfirmDialog>
      <ConfirmDialog
        open={delLlm != null}
        title="删除 LLM 配置"
        danger
        confirmText="删除"
        onConfirm={() => void doDeleteLlm()}
        onCancel={() => setDelLlm(null)}
      >
        确认删除「{delLlm?.name}」？
      </ConfirmDialog>
      <ConfirmDialog
        open={delMcp != null}
        title="删除 MCP 配置"
        danger
        confirmText="删除"
        onConfirm={() => void doDeleteMcp()}
        onCancel={() => setDelMcp(null)}
      >
        确认删除「{delMcp?.name}」？
      </ConfirmDialog>
      {/* 背景素材库管理弹窗（优化建议区第36轮） */}
      <BgLibraryDialog open={bgLibOpen} onClose={() => setBgLibOpen(false)} />
    </div>
  )
}
