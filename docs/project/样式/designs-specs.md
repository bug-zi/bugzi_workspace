# 样式 designs-specs.md —— 主题系统、应用骨架与全局布局

> 本文档由 AI 基于 `docs/project/样式/design.md` 与《总需求文档.md》第 2/3/5/6/7/8/9/11/12 条生成，是开发的直接依据。
> **范围说明**：本模块除样式外，还承载应用工程骨架（Electron+React+TS 初始化）、三栏布局、全局 md 弹窗组件、AI 助手边栏的实现——这些在 样式/design.md 第 5 条与总需求文档中定义，但无独立模块文档，归入本 specs。首次启动引导见 个人中心/designs-specs.md。

## 0. 工程骨架

### 0.1 技术栈与初始化

- Electron + React + TypeScript，Vite 构建（electron-vite 脚手架）。
- 目录结构约定：

```
bugzi_workspace/
├── electron/            # 主进程
│   ├── main.ts          # 窗口创建、生命周期、托盘无关
│   ├── preload.ts       # contextBridge 暴露 IPC API
│   ├── db/              # SQLite 初始化与访问层
│   ├── ai/              # LLM/MCP 调用（唯一发起点）
│   └── services/        # 回收站清理、定时任务
├── src/                 # 渲染进程（React）
│   ├── App.tsx          # 三栏布局 + 模块路由
│   ├── theme/           # 主题系统
│   ├── components/      # 全局组件（MdDialog 等）
│   └── modules/         # 六个模块页面
└── docs/                # 项目文档（本目录，不参与构建）
```

### 0.2 进程架构（硬性规则，来自总需求文档第 2 条）

- 渲染进程（React UI）**只做展示与交互**，不直接发外部 HTTP 请求、不直接读写磁盘。
- 所有 IO 走主进程：SQLite 读写、md 文件读写、LLM API 调用、MCP 连接。
- 通信方式：preload 中 contextBridge 暴露类型化 IPC API（`window.api.*`），接口按模块划分（如 `window.api.mottos.*`、`window.api.ai.chat()`）。
- contextIsolation: true，nodeIntegration: false。

### 0.3 数据存储（总需求文档第 3 条）

- SQLite（better-sqlite3）存结构化数据，md 存真实文件，均位于 `app.getPath('userData')` 下：
  - `<userData>/bugzi.db`
  - `<userData>/md/` 下按模块分目录：`mottos/`（格言笔记）、`inspirations/`（灵感文档）、`wiki/`（知识卡片正文）、`verify/`（辩真记录详情）
  - `<userData>/bg/`：bg-light、bg-dark 背景图
- 各模块数据表结构在各自模块的 designs-specs.md 中定义；回收站表见 回收站/designs-specs.md。

## 1. 主题系统（样式 design.md 第 1、2、4 条）

### 1.1 主题定义

CSS 变量双套，`:root[data-theme='light']` 与 `:root[data-theme='dark']`：

| 变量 | 浅色（樱花粉） | 深色（宝蓝） |
|---|---|---|
| `--color-primary` | #E8A0BF | #1A237E |
| `--color-primary-soft` | #F8BBD0 | #283593 |
| `--color-text` | #1F1F1F | #FFFFFF |
| `--color-surface` | rgba(255,255,255,0.75) | rgba(40,53,147,0.55) |
| `--bg-image` | bg-light | bg-dark |

- 色值为参考值，实现时可在同色系内微调；**禁止彩亮颜色**，所有组件框/按键/弹窗用 `--color-primary`、`--color-primary-soft`、`--color-surface` 及其透明度衍生，不得引入色系外颜色。
- 背景图铺满全窗口（fixed，cover），内容卡片/列表用 `--color-surface` 半透明底色叠加。

### 1.2 主题状态与切换

- 主题存 SQLite settings 表（key-value），启动时读入设置 `data-theme`。
- 双入口切换（总需求文档第 7 条）：左侧边栏底部一键切换图标 + 个人中心 App 设置下拉项；两处切换即时生效（切换 `data-theme` + 写库），全 App 无刷新换肤。
- 背景图更换：个人中心设置里选择本地图片 → 复制到 `<userData>/bg/` 覆盖对应文件 → 刷新 `--bg-image`。（入口在个人中心，机制在本模块实现。）

## 2. 图标（样式 design.md 第 3 条）

- 全 App 统一 Material Symbols Outlined（Google Fonts 引入），禁 emoji。
- 六模块图标建议：格言库 format_quote、万象库 public、灵感泉 lightbulb、辩真阁 fact_check、回收站 delete、个人中心 person；AI 边栏 forum；主题切换 light_mode/dark_mode。实现时可调整，保持 Outlined 风格统一。

## 3. 三栏布局（样式 design.md 第 5 条 + 总需求文档第 12 条）

### 3.1 结构

```
┌──────┬──────────────────────────┬─────────────┐
│ 左边栏 │        中间主栏           │  AI 助手边栏  │
│ 图标+ │   当前模块的内容           │  可收起/展开  │
│ 名称  │   （路由切换六个模块）      │  默认宽度 ~   │
│      │                          │  320px      │
└──────┴──────────────────────────┴─────────────┘
```

- 左侧边栏：垂直排列，宽约 72px 展开态（图标+模块名竖排或横排悬浮提示均可，实现时定）。模块顺序固定：格言库 → 万象库 → 灵感泉 → 辩真阁 → 回收站 → 个人中心。当前模块高亮（`--color-primary-soft` 底）。侧边栏底部：主题切换图标。
- 中间主栏：模块路由（格言库为默认页），内容区滚动，背景透出主题背景图。
- 右侧 AI 助手边栏：可收起/展开（边缘把手或按钮），收起时仅留窄条。宽度可拖拽调整（v1 可选）。

### 3.2 窗口

- 窗口标题：bugzi's workspace。最小尺寸 1024×680，默认 1440×900。深浅色标题栏随主题。

## 4. AI 助手边栏（总需求文档第 8、9 条）

### 4.1 能力

- 自由对话：多轮聊天，输入框 + 消息气泡列表，支持流式输出渲染。
- 模块感知：每轮请求附带当前所在模块名与简短上下文标签（如 `当前模块：格言库`），system prompt 中指示 AI 优先围绕该模块话题。
- 单会话（v1）：全部历史持久保存（SQLite ai_messages 表：id, role, content, created_at），打开 App 即加载全部历史；多会话管理列 v2。
- 万象库「问 AI」与辩真阁验证过程会向此边栏推送消息（见各模块 specs）。

### 4.2 降级（总需求文档第 8 条）

- LLM 未配置（无默认 LLM）时：边栏仍可打开，输入框可点击，发送时弹窗提示「请先在个人中心配置 LLM」+「去配置」按钮直达个人中心。

## 5. 全局 md 弹窗组件 MdDialog（总需求文档第 6 条）

格言笔记 / 万象卡片 / 灵感文档 / 辩真记录详情共用，props 化：

```ts
interface MdDialogProps {
  open: boolean
  title: string            // 弹窗标题（如格言正文摘要、灵感标题）
  filePath: string         // md 文件绝对路径（相对 userData）
  onChanged?: () => void   // 保存回调（刷新列表等）
}
```

- **默认渲染态**：react-markdown（含 GFM）渲染 md 内容，阅读样式。
- **双击文档任意处 → 编辑态**：切换为 textarea（等宽或常规字体），纯源码编辑。
- **退出编辑即保存并恢复渲染**：失焦或点「完成」按钮 → 写回 md 文件（主进程）→ 重新渲染。
- 弹窗居中，宽度约 720px、高度 80vh，内容滚动；遮罩半透明；Esc 关闭（编辑态先提示保存）。
- 样式遵守主题变量，禁止彩亮色。

## 6. 验收清单

- [ ] electron-vite 工程可启动，窗口标题 bugzi's workspace，渲染三栏布局
- [ ] 主题双套 CSS 变量生效，双入口切换即时换肤且持久化
- [ ] 背景图铺满全窗口，卡片半透明叠加，符合双主题色系
- [ ] 全 App 无 emoji 图标，Material Symbols Outlined 统一
- [ ] 六模块路由可达，侧边栏顺序与高亮正确，默认页格言库
- [ ] AI 边栏可收起/展开，能自由对话（已配置 LLM 时），历史持久
- [ ] LLM 未配置时发送 → 提示弹窗 + 直达个人中心
- [ ] MdDialog 组件：渲染态 → 双击编辑 → 失焦保存恢复渲染，四个模块场景可复用
