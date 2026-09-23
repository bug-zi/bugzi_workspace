# bugzi's workspace 项目学习笔记（导读）

> 写给项目新人的一套代码走读笔记。作者：本项目 AI coding 开发者。
> 配套代码：仓库根目录 `electron/`（主进程）与 `src/`（渲染层）。
> 原版成文于 260902（v1.0 六模块时代）；**260919 依当前代码全面更新**（12 模块 + 音乐吧 + 右缘四面板 + 内置终端时代，DB v46，v1.1.0）。
> 引用约定：本次更新改用 `文件 + 函数/符号名` 定位（如 `ipc.ts 的 registerIpc()`），不再写死行号——这个仓库每周都在长，行号会腐烂，符号不会。

## 这个项目是什么

一个**本地单机运行**的 Electron 桌面应用：「bugzi's workspace —— 生活化个人专属工作台」。
没有账号体系、没有服务端、没有网络同步，所有数据落在本机数据目录（默认 `D:\Paper\app_output\bugzi_workspace`，可迁移）里。

十二个功能模块 + 音乐吧全局功能 + 右缘三块副面板 + 内置终端：

| 模块 | 目录 | 一句话 |
|---|---|---|
| 总导览 | `src/modules/zonglan/` | 启动默认页：今日格言/学习队列/打卡状态/续读直达/每日挑战/热力图，纯聚合零 AI |
| 学习库 | `src/modules/learn/` | 260924 面经题库化：Go 后端面经刷题（AI 联网搜集真实面经、先回忆再对照自评、间隔复习打卡），知识树降级自学参考区 |
| 万象库 | `src/modules/wiki/` | 三板块 tab：百科（知识卡片/划词）/辩真（MCP 联网核查）/问答；测一测题库制 |
| 致知己 | `src/modules/zhijiji/` | 自我认知：问题+多版本答案、预言家判断、十二问题想法碎片、我的画像 |
| 灵感泉 | `src/modules/inspirations/` | 灵感四区看板（草稿/立项/开发/归档），拖拽 + AI「来5条灵感」 |
| 文笔坊 | `src/modules/wenbi/` | 四 tab：格言库（三级流转）/经验书/浮生记/写作台（Copilot 式协笔） |
| 信息源 | `src/modules/feed/` | RSS 聚合（支持 rsshub:// 展开）+ AI 总结 + 内置阅读视图 |
| 图书馆 | `src/modules/zangyue/` | 书架（epub/pdf 双引擎阅读器+笔记书签统计+文件夹）| 收藏（两级分类链接收藏） |
| 推理角 | `src/modules/reasoning/` | 海龟汤（AI 出题/裁判/复盘）+ 思维墙（每日一题/题库/练习场），题池预生成泵 |
| 记账本 | `src/modules/ledger/` | 逐笔流水 + 多账户余额滚存 + 月度统计，金额存分，纯本地零 AI |
| 回收站 | `src/modules/recycle/` | **19 种来源**的统一中转站（含 AI 会话归档），3 天后自动彻底删除 |
| 个人档 | `src/modules/profile/` | 个人信息 + 我的画像 + 字体/导入字体/LLM/MCP 配置 + 数据目录 + 版本与更新 |
| 音乐吧 | `src/modules/noise/` | 全局背景音（不入左栏模块列表）：白噪音合成引擎 + 轻音乐歌单，切页不断 |
| 草稿本 | `src/components/DraftSidebar.tsx` | 右缘面板：通用/海龟汤双频道 md 草稿 |
| 资源管理器 | `src/components/FileExplorerSidebar.tsx` | 右缘面板：浏览本机文件夹/文本/图片 |
| 画布 | `src/components/CanvasSidebar.tsx` | 右缘面板：Excalidraw 多画布 |
| 内置终端 | `src/components/terminal/` | 底部面板：node-pty 真实 shell（Ctrl+J 呼出），可「问 AI」 |

右侧 AI 助手名叫 **debugzi**（与用户 bugzi 配对），**频道制**多会话（助手/格言/万象/致知己/核查/学习/预言家）。

## 学习路线（建议顺序）

```
01-项目总览与业务规则        先懂"做什么"，全局硬性规则是所有模块的宪法
02-技术栈与工程结构          用了什么库、目录怎么分、命令怎么跑、怎么打包发版
03-Electron架构与启动流程    ★核心：三大进程、安全模型、bzres:// 协议、托盘/更新器
04-IPC通信设计              ★核心：40 个命名空间 ~330 条通道、广播、jobId 取消
05-数据存储设计              SQLite 46 版迁移 + md 双存储 + 回收站 19 来源 + 数据目录切换
06-AI能力实现               LLM 咽喉点（路由/记账/活动/取消）/ MCP / 30+ 业务流程
07-渲染层架构               React keep-alive、双主题、右缘四面板、音频引擎
08-模块走读                 12 模块逐个过交互和数据流（综合运用前面所有知识）
09-定时任务与设计权衡        scheduler + 预生成泵、"错过即跳过"哲学、技术债现状
```

前三篇 + 03/04 是地基，务必先看；05-09 按需查阅。

## 快速上手命令

```powershell
npm install        # .npmrc 已配国内镜像 + legacy-peer-deps，直接裸装
npm run dev        # electron-vite 开发启动（热更新）
npm run typecheck  # 双 tsconfig 类型检查（主进程 + 渲染层各查一遍）
npm run build      # 产出 out/
npm run smoke      # build 后以 --smoke 参数启动（冒烟自检）
npm run icon       # scripts/gen-icon.cjs 生成应用图标
npm run dist       # 清 release/ → electron-vite build → electron-builder --win 打 NSIS 安装包
```

没有测试框架、没有 lint 配置——个人工具项目，质量靠 typecheck + 人工验收。
打包发版走 GitHub Releases（`electron-builder.yml` 配 publish 到 `bug-zi/bugzi_workspace`），应用内「版本与更新」经 electron-updater 消费 `latest.yml`。

## 高频名词表

| 名词 | 含义 |
|---|---|
| 主进程 (main) | Electron 的 Node.js 环境，跑在 `electron/`，能碰文件系统、数据库、shell |
| 渲染进程 (renderer) | 跑 React 的浏览器环境，跑在 `src/`，**碰不到** Node API，只有 `window.api` |
| preload | 两大进程之间的"类型化桥"，`electron/preload.ts`，暴露 `window.api` |
| IPC | 进程间通信，`ipcRenderer.invoke(通道名, ...)` ↔ `ipcMain.handle(通道名, 处理器)` |
| userData / 数据目录 | App 数据根目录（DB、md、书、音乐、字体全在这）；默认 D 盘，`storage.ts` 支持 `data_home.json` 指针迁移 |
| bzres:// | 自定义只读协议，渲染层安全引用数据目录下的图片/字体/书籍/音乐（host 作命名空间：root/bg/fonts） |
| 频道 (channel) | AI 边栏按场景分会话（`AiChannel` 七值）；草稿本也有自己的两频道 |
| keep-alive | 模块切换只隐藏不卸载（`.module-hidden`），AI 生成任务不因切页中断 |
| 泵 (stock) | 后台预生成服务（`reasoningStock` / `wikiStock` / `learnStock` / `wikiQuizStock`），启动 +10s 与触发后静默补库 |
| jobId / 取消 | 每个可取消的 AI 调用带 jobId（`ai/jobs.ts` 注册表），`ai:cancel` 统一取消，AI 活动面板可点停 |
| 软删除 | 不真删数据库行，只打 `deleted_at` 时间戳（回收站机制的根基） |
| specs | `docs/project/左侧边栏|右侧边栏/<模块>/designs-specs.md`，AI 生成代码时的直接依据，代码注释里大量引用 |

## 阅读源码时的三条心法

1. **注释里有 specs 引用**。几乎每个文件头都写着如 `// 推理角 specs §3.1`，对照 `docs/project/左侧边栏/生活模块/推理角/designs-specs.md` 就能找到这条代码对应的原始需求条目。需求目录已按左/右侧边栏重组（原「需求（功能模块）」路径已废）。
2. **所有跨进程调用都是字符串通道名**。搜 `ipcMain.handle('模块名:` 和 preload 里的同名前缀，是同一件事的两端；通道名字符串只该出现在 `preload.ts` 和 `ipc.ts` 两处。
3. **数据只有三类住址**：SQLite（结构化，`bugzi.db`）、数据目录下的内容文件（`md/**` 笔记、`books/` 电子书、`music/` 曲目、`canvas/` 画布、`covers/` 封面、`fonts/` 字体）、`settings` 表的 JSON 字符串（各类状态）。看到任何数据，先问自己"它住在哪"。
