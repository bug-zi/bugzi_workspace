# 03 - Electron 架构与启动流程

> 目标：理解 Electron 三进程模型在本项目的落法、安全模型的设计意图、启动序列每一步为什么在那个顺序。这是全项目最核心的一篇。
> （260919 依当前代码更新：数据目录切换、托盘、更新器、终端、五个预生成泵都进了启动序列）

## 1. 三进程模型总览

```
┌─────────────────────────────────────────────────────────────┐
│  Electron App                                                │
│                                                              │
│  ┌─────────────────┐  ipcMain.handle    ┌────────────────┐  │
│  │   主进程          │ ←────────────────  │   渲染进程       │  │
│  │  electron/       │  webContents.send  │   src/         │  │
│  │                  │ ─────────────────→ │                │  │
│  │  · Node.js 全能   │  (invoke 请求-响应) │  · React        │  │
│  │  · SQLite        │                    │  · 无 Node      │  │
│  │  · 文件系统       │   node-pty 子进程   │  · Web Audio    │  │
│  │  · LLM/MCP HTTP  │   (终端独立进程)     │                │  │
│  │  · 定时器/泵      │                    │  window.api    │  │
│  └───────┬─────────┘                    └──────┬─────────┘  │
│          │                              preload 桥         │
│          │                              (受限 Node)         │
│          ▼                                                  │
│   数据目录（默认 D:\Paper\app_output\bugzi_workspace，可迁移）   │
│   ├── bugzi.db            ← SQLite（WAL）                    │
│   ├── md/{mottos,wiki,learn,verify,zhijiji,turtle,wall,     │
│   │      drafts,wenbi,inspirations,qa,prophet}/…  ← 笔记文档 │
│   ├── books/ covers/ music/ canvas/ fonts/ bg/ ← 内容资产     │
│   └── data_home.json（指针留在系统默认 userData 位置）          │
└─────────────────────────────────────────────────────────────┘
```

| 进程 | 代码 | 能做什么 | 不能做什么 |
|---|---|---|---|
| 主进程 main | `electron/main.ts` + `electron/**` | 一切：fs、SQLite、网络、shell、pty、定时器 | 直接操作 UI DOM |
| 预加载 preload | `electron/preload.ts` | 受限 Node：ipcRenderer、contextBridge | 随意暴露 Node API 给页面 |
| 渲染进程 renderer | `src/**` | React UI、Web Audio、fetch bzres:// | **碰不到任何 Node API**，只有 `window.api` |

**为什么这样分？** 安全与关注点分离：UI 层永远不该直接碰数据库和文件系统；所有"能力"集中主进程，形成天然审计边界——想看某个数据怎么被读写的，去 `electron/` 一定能找到。

## 2. 启动前的两步钉位（main.ts 顶部，易漏看）

```ts
app.setName('bugzi_workspace')
app.setPath('userData', join(app.getPath('appData'), 'bugzi_workspace'))
```

**为什么先钉 userData**：打包态 productName 带空格（`bugzi's workspace`）会让 Electron 默认 userData 路径分裂、已有数据"消失"。钉回统一位置必须在**单实例锁之前**（锁文件在 userData）和 `applyDataDirAtStartup` 之前。

```ts
registerBzresSchemes()      // 必须在 app ready 之前（registerSchemesAsPrivileged 约束）
applyDataDirAtStartup()     // 读 data_home.json 指针 → setPath 到实际数据目录（ready 前）
```

`storage.ts` 的数据目录逻辑：默认目录是**内置 D 盘路径**（`BUILTIN_DEFAULT_DATA_DIR`，开发者要求），用户在个人档迁移后在系统默认 userData 位置留 `data_home.json` 指针；启动读指针，目标不可用回退系统默认。**"逻辑 userData"与"物理 userData"就此分离**——所有 `userDataDir()` 调用拿到的是迁移后的目录。

## 3. 安全模型（createWindow 逐条讲）

```ts
webPreferences: {
  preload: join(__dirname, '../preload/preload.js'),
  contextIsolation: true,     // ① 上下文隔离
  nodeIntegration: false,     // ② 页面无 Node
  sandbox: false              // ③ preload 不完全沙箱（有意放宽：类型化桥需要）
}
```

- **① contextIsolation: true**：页面 JS 与 preload 不共享原型链，注入脚本拿不到 `require`/`process`。
- **② nodeIntegration: false**：渲染页面彻底没有 Node 能力。
- **③ sandbox: false**：有意放宽——preload 只用 `contextBridge` + `ipcRenderer` 两个白名单 API，暴露面可控。

配套防线：

- **外链一律系统浏览器**（`setWindowOpenHandler`）：任何 `window.open`/`target=_blank` 被拒绝，http(s) 转交 `shell.openExternal`。AI 输出的 Markdown 链接（辩真来源、信息源文章）再多也不会在拥有 window.api 的环境里导航。
- **点 × 不退出，隐藏到托盘**（`win.on('close')`）：`settings.close_action !== 'exit'` 时 `preventDefault + hide()`；托盘「退出」先置 `quitting = true` 放行。常驻托盘的代价由 `before-quit` 偿还：`settleTurtleTimers()`（海龟汤净用时落库）+ `killAllTerminals()`（杀光 pty 子进程，不留僵尸 shell）。
- **单实例锁**（`requestSingleInstanceLock`）：失败即退出，二次启动唤起既有窗口（`second-instance` → restore/show/focus）。两个实例同时开同一个 SQLite 文件是数据损坏的捷径。

## 4. 启动序列（whenReady 的顺序是设计过的）

```ts
void app.whenReady().then(() => {
  registerBzresProtocol()   // ① 协议处理器本体（ready 后才能 protocol.handle）
  initDb()                  // ② 建目录 + 开 SQLite + 46 版迁移
  registerIpc()             // ③ 注册全部 ~330 条通道
  startSchedulers()         // ④ 启动清理 + 排格言定时/零点清理
  setTimeout(…, 10_000) ×5  // ⑤ 五个延迟任务，全部错开启动高峰、unref、内部自 catch：
                            //    backfillTrickNotes（存量汤诡计摘要回填）
                            //    ensureReasoningStock / ensureWikiQuizStock（推理角两池）
                            //    ensureDailyLearn + ensureWikiStock（万象库待学习区+后库）
                            //    ensureLearnStock（学习库队列定档+今日新卡）
  createWindow()            // ⑥ 最后才建窗口
  createTray(appIcon, …)    // ⑦ 托盘常驻（菜单含开机自启勾选，实时读 settings）
  app.setLoginItemSettings(…) // ⑧ 按 settings.launch_on_boot 应用开机自启
  initUpdater(…)            // ⑨ 应用内更新（内部再错峰 5s 静默检查，dev 态直接 disabled）
})
```

顺序不能乱，各有依赖：

1. **协议先于一切加载**——bzres:// 特权声明（`registerBzresSchemes`）甚至要更早在 ready 前。
2. **initDb 先于 registerIpc**——任何 IPC 处理器都依赖 db。
3. **registerIpc 先于 createWindow**——否则页面首帧 invoke 撞空。
4. **泵延迟 10 秒**——启动瞬间 DB 迁移+窗口加载已经很忙，LLM 泵的任务（出题/生成）又重又可能等网络，错峰是实测出来的经验（`260909 推理角补充泵排障`注释）。**泵永不抛错**：内部自 catch、LLM 未配置静默跳过。
5. **托盘/自启/更新器在窗口之后**——它们是"窗口之外"的系统集成，晚一秒无感知。

**takeaway**：改启动逻辑先画依赖图——窗口创建放最后是这个序列的硬约束；往里加东西先问"它饿不饿（网络/DB 重活），饿就进 10 秒错峰队列"。

## 5. bzres:// 自定义协议（本项目的"高光"设计）

**问题**：渲染层要显示本地图片/字体/书籍/音乐，但渲染层拿不到文件路径访问权（也不该拿）。

**方案**：只读、只能看数据目录的迷你协议。`electron/services/bzres.ts`：

```
渲染层引用: <img src="bzres://bg/bg-light.png">   背景/头像
           bzres://fonts/xxx.ttf            导入字体（FontFace 加载）
           bzres://root/books/1.epub        书籍/音乐等根下资产
                  │
                  ▼ host 作"命名空间"，不映射磁盘目录
  host==='bg'    → bg/<path>
  host==='fonts' → fonts/<path>
  host==='root'（或 localhost/空）→ <path> 原样
                  │
                  ▼ 路径消毒
  decodeURIComponent → '\' 归一 '/' → 按段过滤 '' / '.' / '..'
  join(userDataDir(), …parts)，越界即 403
                  │
                  ▼ 按扩展名给 MIME（新增 font/ttf 等字体类型）
  读文件 → Response；失败 404
```

三个细节值得学：

- **corsEnabled: true**：dev 下页面源是 `http://localhost:5173`，`fetch(bzres://)` 属跨源请求，不加此特权 Chromium 直接拒（IMG 标签不受限，但 ThemeProvider 用 fetch 探测背景图 404）。
- **standard: true 的坑**：标准协议下 URL 第一段解析成 hostname，所以有 host 命名空间兜底（`host === 'localhost' ? '' : host` 的历史包袱演化为现在的 root/bg/fonts 三命名）。
- **失败即 404**：ThemeProvider 探测 `!probe.ok` 回退纯色；书籍/音乐加载失败由各自 UI 兜底。**每个"配置指向资源"的地方都要有存在性兜底**——桌面本地应用特有的健壮性问题。

**同类思想对照**：`files.ts` 的 `resolveUnderUserData()` 给 md 路径做同样的"锁死在数据目录内"检查——协议层与文件 API 层，同一安全意图的两道实现。

## 6. preload：类型化桥的三件套

`electron/preload.ts` 的模式固定，每个命名空间三选一：

```ts
// 1) invoke 型（请求-响应，占绝大多数）
get: (key: string) => ipcRenderer.invoke('settings:get', key),

// 2) 事件订阅型（主进程 → 渲染层推送），返回取消订阅函数
onTerminalData: (cb) => {
  const listener = (_e, payload) => cb(payload)
  ipcRenderer.on('terminal:data', listener)
  return () => ipcRenderer.removeListener('terminal:data', listener)  // ← React useEffect 清理用
},

// 3) 参数化 invoke
list: (status?) => ipcRenderer.invoke('mottos:list', status)
```

事件订阅型**一定返回 unsubscribe**，正好匹配 React `useEffect` 的 cleanup 语义。渲染层经 `src/renderer/api.d.ts` 手工镜像声明 `window.api` 的类型——两份需人工同步（技术债，09 篇展开）。

## 7. 主进程 → 渲染层的广播通道（现有 9 条）

| 通道 | 生产者 | 消费者 |
|---|---|---|
| `ai:message` | `pushAiSystemMessage`（辩真过程/泵结果等，写库+推送双动作） | AiSidebar 重载、相关模块 bump |
| `recycle:changed` | 一切软删/恢复/彻底删之后（ipc.ts 多处） | RecycleModule 刷新 |
| `llm:activity` | `llm.ts` 的 `broadcastActivity`（调用起止各一次） | LlmActivity 活动面板 |
| `learn:stockChanged` | `learnStock.ts` 泵 | LearnModule 渐进刷新 |
| `wiki:stockChanged` | `wikiStock.ts` / `wikiQuizStock.ts` 泵 | WikiModule 渐进刷新 |
| `reasoning:stockChanged` | `reasoningStock.ts` 泵 | 推理角汤库列表渐进刷新 |
| `terminal:data` / `terminal:exit` | `terminal.ts`（合帧批量发，防 IPC 洪峰） | TerminalPanel 写 xterm |
| `app:updateEvent` | `updater.ts` 状态机 | 个人档「版本与更新」UI |

**thin notification 原则**：广播只说"某数据变了"，消费者重新 `list()` 全量拉——没有 store 的渲染层，"状态永远以 DB 为准"是最不易错的一致性模型。**例外是 terminal:data**：字节流数据本身就带载荷（合帧批量），属"流式通道"而非通知。

## 8. 走一遍"沉淀一条格言"的全链路（综合练习）

```
[渲染进程] MottosModule / WenbiModule 格言面板
用户点「加入沉淀区」→ window.api.mottos.setStatus(id, 'settled')
       │
[preload 桥]
  ipcRenderer.invoke('mottos:setStatus', id, 'settled')
       │  (结构化克隆过进程边界)
[主进程] ipc.ts 的 mottos:setStatus 处理器
  UPDATE mottos SET status=?；若升 formal 且无笔记 → 建笔记 md（同函数内原子完成）
       │  (Promise resolve 回传)
[渲染进程] await 返回 → load() 全量重拉 → setState → React 重渲染
```

七个字总结：**UI 不碰数据，数据不碰 UI，中间全靠桥**。

## 9. 新人练习

1. 在 `main.ts` 找到 `ELECTRON_RENDERER_URL` 分支，解释开发/生产两种加载方式；再把 `initDb()` 挪到 `registerIpc()` 之后跑 `npm run dev`，观察首屏 invoke 抛 `DB_NOT_INITIALIZED`。
2. 给启动序列加一个"第十步"练习：假如要加"启动时同步系统主题"，它该排哪？需要错峰吗？（参考答案：createWindow 之后即可；读系统主题是轻操作，不进 10 秒队列。）
3. 思考题：为什么托盘「退出」要靠 `quitting` 标志放行，而不是直接 `win.destroy()`？（提示：destroy 绕过 close 事件里的 `settleTurtleTimers`/`killAllTerminals` 兜底——走 `app.quit()` 统一出口才能保证 before-quit 收尾。）
