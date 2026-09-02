# bugzi's workspace 项目学习笔记（导读）

> 写给项目新人的一套代码走读笔记。作者：本项目 AI coding 开发者。
> 配套代码：仓库根目录 `electron/`（主进程）与 `src/`（渲染层）。
> 所有笔记中的 `文件:行号` 都可直接点击跳转对照源码。

## 这个项目是什么

一个**本地单机运行**的 Electron 桌面应用：「bugzi's workspace —— 生活化个人专属工作台」。
没有账号体系、没有服务端、没有网络同步，所有数据落在用户本机的 userData 目录里。

六个功能模块 + 一个全局 AI 助手：

| 模块 | 目录 | 一句话 |
|---|---|---|
| 格言库 | `src/modules/mottos/` | 名言格言三级流转（草稿→沉淀→正式），AI 按正式区风格每天生成 10 条 |
| 万象库 | `src/modules/wiki/` | 非计算机领域知识卡片，AI 生成，划词高光/问 AI |
| 灵感泉 | `src/modules/inspirations/` | 项目灵感四区看板（草稿/立项/开发/归档），可拖拽 |
| 辩真阁 | `src/modules/verify/` | 输入观点 → MCP 联网搜索 → LLM 综合验证给可信度 |
| 回收站 | `src/modules/recycle/` | 四模块丢弃物的统一中转站，3 天后自动彻底删除 |
| 个人中心 | `src/modules/profile/` | 用户信息 + 字体/主题/LLM/MCP 配置 |

## 学习路线（建议顺序）

```
01-项目总览与业务规则        先懂"做什么"，全局硬性规则是所有模块的宪法
02-技术栈与工程结构          用了什么库、目录怎么分、命令怎么跑
03-Electron架构与启动流程    ★核心：三大进程、安全模型、bzres:// 自定义协议
04-IPC通信设计              ★核心：渲染层和主进程怎么对话（本项目最大的设计）
05-数据存储设计              SQLite 表结构 + md 双存储 + 回收站数据机制
06-AI能力实现               LLM 客户端 / MCP 客户端 / 三个 AI 业务流程
07-渲染层架构               React 组织、双主题系统、三栏布局、全局组件
08-六大模块走读             逐模块过一遍交互和数据流（综合运用前面所有知识）
09-定时任务与设计权衡        scheduler 机制、设计决策的"为什么"、已知疑点
```

前三篇 + 03/04 是地基，务必先看；05-09 可以按需查阅。

## 快速上手命令

```powershell
npm install        # .npmrc 已配国内镜像 + legacy-peer-deps，直接裸装
npm run dev        # electron-vite 开发启动（热更新）
npm run typecheck  # 双 tsconfig 类型检查（主进程 + 渲染层各查一遍）
npm run build      # 产出 out/
```

没有测试框架、没有 lint 配置——这是个个人工具项目，质量靠 typecheck + 人工验收。

## 高频名词表

| 名词 | 含义 |
|---|---|
| 主进程 (main) | Electron 的 Node.js 环境，跑在 `electron/`，能碰文件系统和数据库 |
| 渲染进程 (renderer) | 跑 React 的浏览器环境，跑在 `src/`，**碰不到** Node API |
| preload | 两大进程之间的"类型化桥"，`electron/preload.ts`，暴露 `window.api` |
| IPC | 进程间通信，`ipcRenderer.invoke(通道名, ...参数)` ↔ `ipcMain.handle(通道名, 处理器)` |
| userData | 操作系统给 App 分配的用户数据目录，数据库和 md 文件都在这 |
| bzres:// | 自定义协议，让渲染层安全引用 userData 下的本地图片 |
| 三区/四区 | 格言库的 草稿/沉淀/正式 三状态；灵感泉的 草稿/立项/开发/归档 四状态 |
| 软删除 | 不真删数据库行，只打 `deleted_at` 时间戳（回收站机制的根基） |
| specs | `docs/project/**/designs-specs.md`，AI 生成代码时的直接依据，代码注释里大量引用 |

## 阅读源码时的三条心法

1. **注释里有 specs 引用**。几乎每个文件头都写着如 `// 格言库 specs §3.1`，对照 `docs/project/需求（功能模块）/格言库/designs-specs.md` 就能找到这条代码对应的原始需求条目。
2. **所有跨进程调用都是字符串通道名**。搜 `ipcMain.handle('mottos:` 和 preload 里的 `mottos:` 是同一件事的两端。
3. **数据永远只有两处**：SQLite（结构化）和 userData 下的 .md 文件（文档类）。看到任何数据，先问自己"它住在哪"。
