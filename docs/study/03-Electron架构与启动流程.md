# 03 - Electron 架构与启动流程

> 目标：理解 Electron 三进程模型在本项目的落法、安全模型的设计意图、启动序列每一步为什么在那个顺序。这是全项目最核心的一篇。

## 1. 三进程模型总览

```
┌─────────────────────────────────────────────────────────┐
│  Electron App                                            │
│                                                          │
│  ┌───────────────┐   ipcMain.handle   ┌──────────────┐  │
│  │   主进程        │ ←───────────────  │   渲染进程     │  │
│  │  electron/     │   webContents.send │   src/       │  │
│  │                │ ───────────────→  │              │  │
│  │  · Node.js 全能 │   (ipcRenderer.invoke)            │  │
│  │  · SQLite      │                   │  · React      │  │
│  │  · 文件系统     │                   │  · 无 Node    │  │
│  │  · LLM/MCP HTTP│                   │              │  │
│  │  · 定时器       │                   │  window.api  │  │
│  └───────┬───────┘                   └──────┬───────┘  │
│          │                            preload 桥       │
│          │                            (受限 Node)      │
│          ▼                                              │
│   userData/                                             │
│   ├── bugzi.db        ← SQLite                          │
│   ├── md/mottos|wiki|inspirations|verify/*.md           │
│   ├── bg/bg-light.png / bg-dark.png                     │
│   └── avatar.png                                        │
└─────────────────────────────────────────────────────────┘
```

三进程各自的职责与边界：

| 进程 | 代码 | 能做什么 | 不能做什么 |
|---|---|---|---|
| 主进程 main | `electron/main.ts` + `electron/**` | 一切：fs、SQLite、网络、原生对话框、定时器 | 直接操作 UI DOM |
| 预加载 preload | `electron/preload.ts` | 受限 Node：ipcRenderer、contextBridge | 随意暴露 Node API 给页面 |
| 渲染进程 renderer | `src/**` | React UI、fetch bzres:// | **碰不到任何 Node API**，只有 `window.api` |

**为什么这样分？** 核心是安全与关注点分离：UI 层（React）永远不该直接碰数据库和文件系统；所有"能力"集中主进程，形成一个天然的审计边界——想看某个数据怎么被读写的，去 `electron/` 一定能找到。

## 2. 安全模型（main.ts 的窗口配置逐行讲）

`electron/main.ts:14-45`：

```ts
webPreferences: {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,     // ① 上下文隔离
  nodeIntegration: false,     // ② 页面无 Node
  sandbox: false              // ③ 但 preload 不完全沙箱
}
```

- **① contextIsolation: true**：页面 JS 运行在独立世界，与 preload 不共享原型链。即使页面被注入恶意脚本，也拿不到 `require`/`process`。
- **② nodeIntegration: false**：渲染页面彻底没有 Node 能力。
- **③ sandbox: false**：注意这是**有意放宽**的——注释写明"preload 需要部分 node 能力做类型化桥"。Electron 的完全沙箱下 preload 可用 API 更少；本项目接受这个权衡，因为 preload 里只用了 `contextBridge` + `ipcRenderer` 两个纯白名单 API，暴露面可控。

配套的外部链接策略（`main.ts:35-38`）：

```ts
win.webContents.setWindowOpenHandler(({ url }) => {
  if (/^https?:/.test(url)) void shell.openExternal(url)  // 系统浏览器打开
  return { action: 'deny' }                                // 永远不许开新 Electron 窗口
})
```

辩真阁的验证分析里有 LLM 生成的 Markdown 链接——任何 `window.open`/`target=_blank` 都被拒绝，http(s) 一律转交系统浏览器。这样即使 AI 输出里藏了奇怪链接，也不会在拥有 window.api 的环境里导航（那才是真正的灾难面）。

再加单实例锁（`main.ts:48-58`）：`requestSingleInstanceLock()` 失败就退出。原因写在注释里——**避免 userData 锁冲突**：两个实例同时开同一个 SQLite 文件是数据损坏的捷径。

## 3. 启动序列（whenReady 的顺序是设计过的）

`electron/main.ts:60-71`：

```ts
void app.whenReady().then(() => {
  registerBzresSchemes()    // ①
  registerBzresProtocol()   // ②
  initDb()                  // ③
  registerIpc()             // ④
  startSchedulers()         // ⑤
  createWindow()            // ⑥
})
```

顺序不能乱，各有依赖：

1. **registerBzresSchemes()**（bzres.ts:10-17）——必须在 app ready **之前**？不对，看代码它在 whenReady 内——但 Electron 要求 `registerSchemesAsPrivileged` 在**任何内容加载前**调用，whenReady 回调里、createWindow 之前，仍然满足"先于加载"。它声明 bzres:// 是 standard+secure+supportFetchAPI 的特权协议，没有这步，`fetch('bzres://...')` 和 CSS 里的 `url("bzres://...")` 会被当普通协议拒掉。
2. **registerBzresProtocol()**——注册协议处理器本体（ready 后才能 protocol.handle）。
3. **initDb()**——建目录、开 SQLite、跑迁移。**任何 IPC 处理器都依赖 db**，所以必须先于 registerIpc。
4. **registerIpc()**——注册全部通道。必须先于窗口加载，否则页面首帧 invoke 会撞空。
5. **startSchedulers()**——启动即清理回收站超期项 + 排两个定时器。
6. **createWindow()**——最后才建窗口。此时协议、DB、IPC、定时器全部就绪，渲染层一进来就是完整可用世界。

**takeaway**：改启动逻辑时先画依赖图——窗口创建放最后是这个序列的硬约束。

## 4. bzres:// 自定义协议（本项目的"高光"设计）

**问题**：渲染层要显示用户上传的本地图片（头像/背景图），但渲染层拿不到文件路径的访问权（也不该拿）。

**常规烂方案**：`file://` 直连（被安全策略屏蔽）或把图片读成 base64 塞进 DOM（内存爆炸、不缓存）。

**本项目方案**：造一个只读、只能看 userData 的迷你协议。`electron/services/bzres.ts`：

```
渲染层引用: <img src="bzres://bg/bg-light.png">
              或 CSS: url("bzres://bg/bg-light.png")
              或 fetch('bzres://bg/bg-light.png')  ← 探测存在性用
                     │
                     ▼ protocol.handle('bzres', ...)
URL 解析: bzres://bg/bg-light.png
  → hostname='bg', pathname='/bg-light.png'
  → 拼出相对路径 'bg/bg-light.png'
                     │
                     ▼ 路径消毒
按 '/' 切分，过滤空段/'.'/'..'    ← 防 ../../ 越界
join(userDataDir, ...parts)      ← 永远锁死在 userData 内
  → 越界直接 403
                     │
                     ▼ 读文件 + 按扩展名给 MIME
返回 Response(image/png, ...)
```

三个细节值得学：

- **standard: true 的坑**：注册为标准协议后，URL 形如 `bzres://host/path`，第一段会被解析成 hostname。所以处理器里有 `url.hostname === 'localhost' ? '' : url.hostname` 的兜底（bzres.ts:24-25）——`bzres://bg/x` 的 `bg` 其实是 host。不处理这个，路径会丢一段。
- **supportFetchAPI: true**：没有它 ThemeProvider 里的 `await fetch(url)` 探测（ThemeProvider.tsx:63-68）做不了，背景图 404 回退纯色的体验就没了。
- **失败即 404**：文件不存在返回 404，ThemeProvider 探测到 `!probe.ok` 就回退 `none`，UI 永远有兜底。

**同类思想对照**：`files.ts` 的 `resolveUnderUserData()`（files.ts:7-14）给 md 路径做同样的"锁死在 userData 内"检查——一个是协议层防线，一个是文件 API 层防线，**同一个安全意图的两道实现**。

## 5. preload：类型化桥的三件套

`electron/preload.ts` 的模式是固定的，每个命名空间三选一：

```ts
// 1) invoke 型（请求-响应，绝大多数）
getAll: () => ipcRenderer.invoke('settings:getAll'),

// 2) 事件订阅型（主进程 → 渲染层推送），返回取消订阅函数
onRecycleChanged: (cb) => {
  const listener = () => cb()
  ipcRenderer.on('recycle:changed', listener)
  return () => ipcRenderer.removeListener('recycle:changed', listener)  // ← React useEffect 清理用
},

// 3) 参数化 invoke
set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value)
```

注意事件订阅型**一定返回 unsubscribe**——这正好匹配 React `useEffect` 的 cleanup 语义：

```ts
useEffect(() => window.api.ai.onMessage(() => loadAll()), [])   // 返回值就是清理函数
```

preload 末尾 `export type Api = typeof api`（preload.ts:128）配合渲染层的 `src/renderer/api.d.ts` 手工镜像声明 `declare global { interface Window { api: Api } }`——两份需要人工保持同步（技术债，09 篇展开）。

## 6. 主进程 → 渲染层的三条推送通道

主进程不是只会被动应答，它有三种"主动说话"方式，各有用途：

| 方式 | 代码 | 用途 |
|---|---|---|
| `webContents.send('ai:message', msg)` | ipc.ts:30-33 | AI 边栏系统消息（辩真阁验证进度、定时结果） |
| `webContents.send('recycle:changed')` | ipc.ts:125 | 任何模块丢弃/恢复/删除后通知回收站页刷新 |
| `shell.openExternal(url)` | main.ts:36 | 外链转系统浏览器 |

**recycle:changed 的设计意图**：回收站页可能正开着，用户在格言库丢了条格言——两个模块互不知道对方存在，靠主进程广播解耦。渲染层 `RecycleModule` 用 `onRecycleChanged` 订阅 + version 计数触发重载（RecycleModule.tsx:51-61）。

## 7. 走一遍"改一句格言"的全链路（综合练习）

帮你把三进程串起来，从点击到落库：

```
[渲染进程] MottosModule.tsx
用户点"保存" → saveEdit()
  → window.api.mottos.update(id, content, source)        ← 组件只认识这行
       │
[preload 桥]
  ipcRenderer.invoke('mottos:update', id, content, source)
       │  (序列化过进程边界)
[主进程] ipc.ts:179-182
  ipcMain.handle('mottos:update', (_e, id, content, source) => {
    getDb().prepare('UPDATE mottos SET ...').run(...)
    return true
  })
       │  (Promise resolve 回传)
[渲染进程] await 返回 → await load() → list() 再走一遍同链路拿新数据 → setState → React 重渲染
```

七个字总结：**UI 不碰数据，数据不碰 UI，中间全靠桥**。

## 8. 新人练习

1. 在 `main.ts` 里找到 `ELECTRON_RENDERER_URL` 的分支——解释开发模式与生产模式加载页面的两种方式差异（dev server URL vs loadFile）。
2. 画一遍启动六步的依赖图，然后故意把 `initDb()` 挪到 `registerIpc()` 之后，跑 `npm run dev`，观察什么报错（预期：首屏任意 invoke 抛 `DB_NOT_INITIALIZED`）。
3. 思考题：为什么 `recycle:changed` 用广播，而格言列表更新要各模块自己 `load()`？（提示：丢弧行为的"触发方"和"数据所有方"不是同一个模块；而列表数据每个模块自己最清楚何时脏。）
