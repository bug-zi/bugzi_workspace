# Web 模式 + 数据入仓双向同步（设计）

> 创建于 2026-09-20，brainstorming 会话产出；立项后本文件移入对应归档目录。

## 背景与目标

开发者白天在 Android 手机（Termux）工作、晚上在 PC 工作，希望两端通过 GitHub 私有仓库（bug-zi/bugzi_workspace，已确认 private）双向同步应用数据。

前提结论：Electron 无法在手机运行，`npm run dev` 原样在 Termux 跑不通（主进程需要桌面图形环境）。经调查，本项目架构对 Web 化高度友好（IPC 通道统一、服务层纯 Node、渲染层全走 `window.api.*`），故采用「Web 模式改造 + 数据目录迁入仓库」方案（方案 A；远程桌面方案 B 作为过渡备选，未选）。

已确认决策：

| 决策点 | 结论 |
| --- | --- |
| 手机端形态 | Termux 跑 Node 服务 + 手机本机浏览器访问（非 Electron） |
| 电子书大文件 | books/、covers/ 不入仓（.gitignore），仅 PC 端可看书 |
| 同步操作 | 手动 git（pull / commit / push 均由开发者执行） |
| 界面适配 | 首版最小适配（viewport），手机横屏使用，后续经优化建议区迭代 |
| 仓库隐私 | 已确认私有 |
| 桌面版 | 行为完全不变，dev:web 为附加模式 |

## 现状事实（调查结论，2026-09-19/20 核实）

- 数据目录：当前为 `D:\Paper\app_output\bugzi_workspace`（内置默认；指针文件 `%APPDATA%\bugzi_workspace\data_home.json`）。应用自有数据：`bugzi.db`（±wal/shm）、`md/`（12 板块子目录）、`bg/`、`avatar.*`、`fonts/`、`books/`、`covers/`、`music/`、`canvas/`；其余为 Electron 缓存。
- 数据目录迁移功能已存在：个人中心 → 数据存储（`electron/services/storage.ts`）；**现存 bug**：`dataItemNames` 清单缺 books/covers/music/canvas/fonts，迁移会遗漏这五类。
- IPC：`electron/ipc.ts` 298 个 `ipcMain.handle`，统一 `(channel, args)` 模式；`electron/preload.ts` 303 个薄封装暴露 `window.api.*`；渲染层无直接 ipcRenderer 调用。
- 服务层几乎纯 Node（node:sqlite + node:fs）；Electron 专属点：dialog 9 处（全在 ipc.ts）、shell 3 处、node-pty（terminal.ts，dependencies）、托盘/自启/自动更新、bzres:// 协议。
- bzres:// URL 散布约 8 个渲染层文件（BookshelfModule、EpubReader、BgLibraryDialog、ProfileModule、customFonts、ThemeProvider、api.d.ts、types.ts）；电子书数据经 `window.api.books.readFile(id)` IPC 传输（非 bzres 直读）。
- `electron/main.ts` 启动序列：applyDataDirAtStartup → initDb → startSchedulers；`before-quit` 有清理钩子（SQLite 正常退出自动 checkpoint）；`registerIpc()` 为独立导出函数（ipc.ts:167），可在 web 端直接复用。
- 数据子目录体积实测（260920）：books 53M、fonts 20M、music 15M、covers 1.2M、canvas 极小——books 不入仓，其余入仓无压力。
- LLM 走 fetch（Web 模式天然可用，配置随 db 同步）；MCP 为 stdio spawn（Termux 尽力而为）。

## §1 总体架构

两种形态一套代码：

- **桌面版**（不动）：`npm run dev` / `npm run build`，Electron 主进程 + preload + 渲染层。
- **Web 版**（新增 `npm run dev:web`）：Node HTTP 服务（端口 8787，仅监听 127.0.0.1）+ vite 渲染层（端口 5173）；手机本机浏览器访问 `http://localhost:5173`。无局域网暴露。
- **electron 垫片**：web 服务端构建时将 `import ... from 'electron'` 别名到垫片模块——`ipcMain.handle` 收集进 Map（channel → handler）；`app.getPath('userData')` 返回 `BZ_DATA_DIR`（默认仓库 `./data`）；dialog/shell/BrowserWindow/protocol/tray 等提供降级桩。**ipc.ts 与 services 层零改动**。
- 数据流同构：`window.api.xxx()` → `fetch POST /ipc {channel, args}` → 垫片 Map 查原 handler 执行 → 返回结果。语义与 `ipcRenderer.invoke` 一致（含错误传播）。

## §2 Web 服务端（新增 `electron/web/`）

- `web/main.ts` 启动序列：确定数据目录（env `BZ_DATA_DIR`，默认 `./data`）→ `initDb` → 复用 ipc.ts 的注册函数 → `startSchedulers`（定时任务由 Node 服务承担，含每晚 10 点格言生成）→ 起 HTTP 服务。
- 路由：`POST /ipc`（通用通道转发）；`GET /bzres/*`（等价替代 bzres:// 协议，读同一数据目录，MIME 与路径安全规则同 `services/bzres.ts`）。
- vite（web 配置）将 `/ipc`、`/bzres` 代理到 8787。
- 主→渲染推送事件（recycle:changed、reasoning:stockChanged、learn/wiki stock 等存量事件）：web 模式经 SSE（`GET /events`）下发，垫片的 `ipcMain.webContents.send` 桩广播到 SSE 连接。

## §3 渲染层适配

- **形态识别**：`index.html` 内联脚本——检测非 Electron 环境（`window.api` 缺失）时注入 fetch 版 Proxy 垫片作为 `window.api`；SSE 接收推送并触发与 `ipcRenderer.on` 相同的监听器注册面。渲染层业务代码零改动。
- **文件选择**（dialog 类，约 8 处：头像/阅读背景/背景素材上传/字体导入/书籍导入/封面等）：web 分支改 `<input type=file>` + 上传（POST `/upload` 或经通道 base64），落盘到数据目录对应位置。
- **bzres URL 收口**：新增统一 helper（如 `src/shared/resUrl.ts`）——桌面返回 `bzres://…`，web 返回 `/bzres/…`；改造上述 8 个散用文件改经 helper 构造 URL。
- **桌面专属隐藏**：托盘/开机自启/自动更新/内置终端，web 模式不渲染入口（形态标记全局可得）。
- `shell.openExternal` 类（收藏 Ctrl+点开网页等）：web 分支 `window.open`。
- `index.html` 加 viewport meta；首版不做响应式改造，横屏使用。

## §4 数据入仓与同步纪律

1. 先修 `storage.ts` `dataItemNames`：补 `books`、`covers`、`music`、`canvas`、`fonts`。
2. 开发者在**个人中心 → 数据存储**将数据目录迁到仓库子目录 `D:\Code\myapp\bugzi_workspace\data\`（现成功能，PC 端零代码）。
3. `.gitignore` 增补：`data/books/`、`data/covers/`、`data/*.db-wal`、`data/*.db-shm`。书不入仓（手机端打开书提示「本机无书籍文件」）；WAL 不入库（正常退出时 SQLite checkpoint 合并进主库）。
4. 同步纪律（写入 README）：
   - 开工：`git pull`（先于启动 App）
   - 收工：退出 App → `git add data/ && git commit && git push`
   - 两端永不同时改动（白天手机/晚上 PC 作息天然错开）；万一冲突：db 为二进制只能二选一，md 手工合并。
   - Termux 端同样纪律。

## §5 Termux 环境

- `pkg install nodejs git`（Node 24，`node:sqlite` 免 flag）；克隆私有仓库（HTTPS + token）。
- `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`：跳过 electron 二进制下载；`node-pty` 从 dependencies 移到 optionalDependencies（Termux 编译失败不阻断安装，web 模式不加载 terminal 服务）。
- `npm run dev:web` → 浏览器打开 `http://localhost:5173`（如需息屏保活可后续用 termux-services/tmux，属使用技巧不入代码）。

## §6 降级与错误处理

| 功能 | Web 模式行为 |
| --- | --- |
| 书架打开书 | `books.readFile` 报错 → 提示「本机无书籍文件」 |
| 内置终端 | 入口隐藏 |
| MCP（stdio） | spawn 失败按「未配置」既有提示路径处理 |
| 托盘/自启/自动更新 | 入口隐藏，相关 api 返回固定降级值 |
| 白噪音（Web Audio）/ epub.js / pdfjs / marked | 浏览器原生可用，无改动 |
| LLM | 直接可用（配置随 db 同步） |

## §7 验收

1. 桌面回归：`npm run dev` 全模块走查不受影响；`npm run typecheck`、`npm run build` 通过。
2. PC 浏览器验证 `npm run dev:web` 全模块走查（含 dialog 类流程、bzres 资源、推送事件）。
3. Termux：安装 → 启动 → 核心模块（格言/经验书/记账/md 笔记/总导览）增删改查。
4. 同步演练：PC 改 → 手机 pull 可见 → 手机改 → PC pull 可见；验证 WAL 不入仓且数据完整（重开后无丢失）。

## 实施阶段划分（供写计划参考）

1. electron 垫片 + web 服务端（/ipc、/bzres、SSE、dev:web 脚本）
2. 渲染层适配（api 垫片注入、dialog 分支、resUrl 收口、桌面专属隐藏、viewport）
3. storage.ts 迁移清单修复 + 数据迁移入仓 + .gitignore
4. README 同步纪律与 Termux 说明 + node-pty 依赖调整
