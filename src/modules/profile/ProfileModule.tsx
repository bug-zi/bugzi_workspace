// 个人中心模块（个人中心 specs 全量）
import { useCallback, useEffect, useState } from 'react'
import type { LlmConfig, McpConfig } from '../../renderer/api'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../components/Toast'
import { useAppSettings } from '../../theme/ThemeProvider'
import { SettingsKeys } from '../../shared/types'

const FONT_FAMILIES = [
  { label: '默认（系统）', value: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif" },
  { label: '宋体', value: "'SimSun', 'STSong', serif" },
  { label: '黑体', value: "'SimHei', 'Microsoft YaHei', sans-serif" },
  { label: '楷体', value: "'KaiTi', 'STKaiti', serif" },
  { label: '等线', value: "'DengXian', sans-serif" }
]

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

export default function ProfileModule() {
  const { toast } = useToast()
  const { settings, setSetting, refreshBg, theme, setTheme } = useAppSettings()
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  const [avatar, setAvatar] = useState('')
  // LLM
  const [llms, setLlms] = useState<LlmConfig[]>([])
  const [defaultId, setDefaultId] = useState('')
  const [llmForm, setLlmForm] = useState<LlmConfig | null>(null)
  const [testing, setTesting] = useState(false)
  const [delLlm, setDelLlm] = useState<LlmConfig | null>(null)
  // 上游模型列表（优化建议区 #1）
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  // MCP
  const [mcps, setMcps] = useState<McpConfig[]>([])
  const [mcpForm, setMcpForm] = useState<{ name: string; url: string } | null>(null)
  const [delMcp, setDelMcp] = useState<McpConfig | null>(null)
  // 数据存储（优化建议区 #2）
  const [dataDir, setDataDir] = useState('')
  const [migrating, setMigrating] = useState(false)
  const [migrateConfirm, setMigrateConfirm] = useState<{ dir: string } | null>(null)

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
    void window.api.storage.currentDir().then(setDataDir)
  }, [settings])

  const saveJson = useCallback(
    async (key: string, value: unknown) => {
      await setSetting(key, JSON.stringify(value))
    },
    [setSetting]
  )

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
    setTesting(true)
    try {
      await window.api.llm.test(llmForm)
      toast('连接成功')
    } catch (e) {
      toast(`连接失败：${String((e as Error).message).slice(0, 120)}`)
    } finally {
      setTesting(false)
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

  const pickBg = async (kind: 'bg-light' | 'bg-dark'): Promise<void> => {
    const r = await window.api.image.pick(kind)
    if (r) {
      await refreshBg()
      toast('背景图已更新')
    }
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

  return (
    <div className="profile-page">
      <div className="module-header">
        <span className="material-symbols-outlined">person</span>
        <span className="module-title">个人中心</span>
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

      {/* App 设置 */}
      <section className="zone">
        <div className="zone-header"><span>App 设置</span></div>
        <div className="zone-body" style={{ padding: 0 }}>
          <div className="setting-row">
            <span className="setting-label">字体大小</span>
            <input
              type="range"
              min={12}
              max={20}
              step={1}
              value={Number(fontSettings[SettingsKeys.FontSize] ?? 15)}
              onChange={(e) => void applyFont(SettingsKeys.FontSize, e.target.value)}
              style={{ flex: 1, accentColor: 'var(--color-primary)' }}
            />
            <span className="badge">{fontSettings[SettingsKeys.FontSize] ?? 15}px</span>
          </div>
          <div className="setting-row">
            <span className="setting-label">字体样式</span>
            <select
              className="field grow"
              value={fontSettings[SettingsKeys.FontFamily] ?? FONT_FAMILIES[0].value}
              onChange={(e) => void applyFont(SettingsKeys.FontFamily, e.target.value)}
            >
              {FONT_FAMILIES.map((f) => (
                <option key={f.label} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <span className="setting-label">字体粗细</span>
            <select
              className="field grow"
              value={fontSettings[SettingsKeys.FontWeight] ?? '400'}
              onChange={(e) => void applyFont(SettingsKeys.FontWeight, e.target.value)}
            >
              <option value="400">常规 400</option>
              <option value="500">中等 500</option>
              <option value="700">加粗 700</option>
            </select>
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
            <span className="setting-label">背景图（浅色）</span>
            <button className="btn" onClick={() => void pickBg('bg-light')}>
              <span className="material-symbols-outlined">image</span>
              更换
            </button>
          </div>
          <div className="setting-row">
            <span className="setting-label">背景图（深色）</span>
            <button className="btn" onClick={() => void pickBg('bg-dark')}>
              <span className="material-symbols-outlined">image</span>
              更换
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

      {/* MCP 配置 */}
      <section className="zone">
        <div className="zone-header">
          <span>MCP 配置</span>
          <span className="zone-count">{mcps.length}</span>
          <div className="zone-actions">
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
                <div className="row-title">{m.name}</div>
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
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => void testLlm()} disabled={testing}>
                {testing ? '测试中…' : '测试连接'}
              </button>
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

      {/* 删除确认 */}
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
    </div>
  )
}
