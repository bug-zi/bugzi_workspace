# 04 - IPC 通信设计

> 目标：掌握本项目所有进程间通信的命名规律、数据流方向、错误约定与取消机制。读完你应能"看到任何按钮，脑内自动放出完整调用链"。
> （260919 依当前代码更新：9 命名空间 → 40 命名空间 ~330 条通道；新增 jobId 取消体系与多路广播）

## 1. 通道全景图

`electron/preload.ts`（= `src/renderer/api.d.ts`）暴露 **40 个命名空间**，`electron/ipc.ts` 一一对应注册。**通道名字符串只出现在这两个文件里**——这是铁律，别处出现裸字符串通道名就是破坏抽象。

| 命名空间组 | 前缀 | 职责 |
|---|---|---|
| settings / app | `settings:` `app:` | 键值设置；开机自启 |
| updater | `app:update*` + 推送 `app:updateEvent` | 应用内更新状态机 |
| md / image / fonts | `md:` `image:` `fonts:` | md 读写；背景图选/用/库；导入字体 |
| item / recycle | `item:discard` + `recycle:` | 19 来源统一丢弃；回收站列表/恢复/删 |
| ai / aiSession | `ai:` `aiSession:` | 消息读写/取消/配置检测；频道会话 CRUD/压缩/归档 |
| mottos wiki qa verify | 各自前缀 | 文笔坊格言库；万象库三板块（百科/问答/辩真） |
| zhijiji prophet twelve | 各自前缀 | 致知己三件套（问题版本/预言家/十二问题） |
| turtle wall reasoning | 各自前缀 | 海龟汤对局；思维墙每日一题/题库/练习场；池检查 |
| learn | `learn:` | 学习库全家桶（树/卡/队列/小测/任务/高光/深挖）——最大单命名空间 |
| inspirations draft canvas explorer wenbi | 各自前缀 | 灵感泉；草稿本；画布；资源管理器；文笔坊四 tab |
| books feeds articles favorites | 各自前缀 | 图书馆书架+收藏；信息源源+文章 |
| ledger music challenge overview | 各自前缀 | 记账本；音乐吧曲库；每日挑战；总导览热力图 |
| profile llm llmUsage mcp | 各自前缀 | 我的画像；连接测试/拉模型列表；使用统计；MCP 测试+AI 研究 |
| storage shell clipboard terminal | 各自前缀 | 数据目录迁移；外链；剪贴板；终端四通道 |

命名规律：**`领域:动词`**，领域与 preload 命名空间一致。找某功能的实现 = 全局搜 `领域:`，只会命中 preload 和 ipc.ts 两处。带 AI 的通道第一个参数统一是 `jobId`（见 §4）。

## 2. 三种通信形态 + 一种控制流

### 形态 A：invoke 请求-响应（占 90%+）

```ts
// 渲染层
const rows = await window.api.mottos.list()
// preload
list: (status?) => ipcRenderer.invoke('mottos:list', status)
// 主进程
ipcMain.handle('mottos:list', (_e, status?) => { ... return rows })
```

返回值经结构化克隆过进程边界，Promise 化。主进程抛出的 Error，`message` 原样传到渲染层 `catch`——错误约定的基础。**注意 Electron 序列化会丢 stack**：主进程错误必须在抛出点把人类可读信息写进 message。

### 形态 B：主进程广播 + 渲染层订阅（9 条，清单见 03 篇 §7）

全是"通知某数据变了，拉去吧"（thin notification），例外是 `terminal:data` 字节流（合帧批量带载荷）。**为什么不把数据塞进广播？** 渲染层没有 store，收到通知全量重拉最不易错；个人应用数据量小，全量拉成本可忽略，换来"状态永远以 DB 为准"。

**泵的渐进刷新**是广播的进阶用法：`ensureWikiStock` 等泵每补成一批就发一次 `wiki:stockChanged`，模块收到后重拉——用户看到列表"渐渐变多"而不是等全部生成完。生成是长任务，列表先可用后丰富。

### 形态 C：长流程的进度推送（辩真核查 / 海龟汤）

`verify:run` 类调用：一次 invoke 内部跑多轮 LLM+MCP，进度经 `pushAiSystemMessage` 推到**目标频道的激活会话**（写库 + `ai:message` 广播双动作）。最终结果走 invoke 返回值，过程进度走事件流，且进度落库——边栏当时收起也不丢历史。

### 形态 D：jobId 统一取消（260908 全局取消设计）

所有可能慢的 AI 通道第一个参数都是 `jobId: string`：

```
渲染层生成 jobId（如 crypto.randomUUID()）
  → invoke('mottos:generate', jobId, …)
主进程 beginJob(jobId) → AbortController 注册（electron/ai/jobs.ts）
  → signal 贯穿 chatCompletion 与各阶段（ensureNotCancelled 阶段间检查）
用户点取消 → ai:cancel(jobId) → ac.abort() → 调用链抛「已取消」
  → 渲染层 catch 到「已取消」走轻提示，不弹错误框
```

后台泵任务经 `runPumpJob(label, fn)` 包装——同样有 jobId 并随 `llm:activity` 广播，**AI 活动面板能看到并取消后台预生成**（取消语义 = 跳过当前这张/批，泵循环继续）。

## 3. 错误传递约定

没有统一错误对象协议，只有一条朴素约定：**主进程抛 Error，渲染层拿 message 做 `includes` 判断**。

机器可读错误码（`src/shared/types.ts` 的 `ErrCode`）：

```
'LLM_NOT_CONFIGURED'   LLM 一个都没配（LlmNotConfiguredError 哨兵）
'MCP_NOT_ENABLED'      MCP 一个都没启用
'NOT_FOUND'            行不存在
'CONFLICT[:参数]'       冲突（万象词条重复等）
'已取消'                jobId 被取消（渲染层据此静默处理）
'PATH_OUT_OF_USERDATA' 路径越界（files.ts）
```

渲染层标准消费姿势：

```ts
catch (e) {
  const msg = String((e as Error).message)
  if (msg === '已取消') return                       // 静默
  if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)   // → 弹「去配置」
  else setFailMsg(msg)                               // → 弹失败详情
}
```

用 `includes` 而非全等：主进程会包装信息（`CONFLICT:边际效应` 带参数、网络错误拼 cause 码），包含匹配容错更高。

**特殊约定**：正常业务分支用返回值、失败才用异常——万象库词条冲突走 `{ok:false, conflict}` 返回值而非 throw，因为"已存在"是 UI 要展示的正常分支。这条分界线全项目一致。

## 4. 参数设计惯例

1. **扁平标量优先**；复杂结构有明确理由才传对象：`inspirations:reorder`/`mottos:reorder` 的 moves 数组、`favorites:updateItem` 的 patch 对象、`ledger:tx:save` 的 `LedgerTxInput`、`llm:test` 的 config。
2. **id 永远 number，路径永远是数据目录相对路径**（如 `md/mottos/3.md`）——绝对路径不出主进程。
3. **写操作返回 boolean 或新 id**；读操作返回行数组/单行，**snake_case 直通**（DB 列名即 API 字段名，少一层映射少一层错）。
4. **AI 通道首参 jobId**（形态 D）；预生成池通道返回 `{ ready: number }` 之类健康态（`wiki:stockCheck`/`learn:stockCheck`/`reasoning:stockCheck`）。

## 5. 一个通道的完整解剖：`item:discard`

跨模块复用通道的样板（ipc.ts 的 `item:discard`）：

```ts
ipcMain.handle('item:discard', (_e, table: string, id: number) => {
  const source = RECYCLE_MAP[table]        // 表名 → 回收站来源标识
  if (!source) throw new Error('UNKNOWN_TABLE')
  discardToRecycle(source, id)             // 软删 + 快照（recycle.ts）
  win()?.webContents.send('recycle:changed')
  return true
})
```

设计要点：

1. **19 张业务表共用一个丢弃入口**——参数是表名字符串（不是 19 个通道），因为所有模块的丢弃语义完全一致：软删 + 快照入 recycle_bin + 广播。
2. `RECYCLE_MAP`（recycle.ts）解决**表名 ≠ 来源标识**的不一致（`wiki_entries → 'wiki'`、`turtle_soups → 'reasoning_soup'`），白名单映射顺便挡掉非法表名（SQL 表名不能参数化，必须拼接，映射表即防注入）。
3. 丢弃后**主动广播** `recycle:changed`——调用方不需要知道"回收站关心这件事"。

对照渲染层：`window.api.mottos.discard(id)`——preload 补上第一参数路由到公共通道（`ipcRenderer.invoke('item:discard', 'mottos', id)`）。**命名空间糖**：语义上"格言模块的丢弃"，实现上是"公共条目丢弃(表=mottos)"。

## 6. 渲染层消费 IPC 的标准范式（keep-alive 版）

模块骨架（以任意模块为例）：

```tsx
const [items, setItems] = useState([])
const load = useCallback(async () => setItems(await window.api.xxx.list()), [])
useEffect(() => { void load() }, [load])

// keep-alive：切走再切回不卸载，靠激活事件刷新（useModuleActivated 封装）
useModuleActivated('wiki', () => { void load() })

// 写操作：await api → toast → load() 刷新（无自动失效机制）
```

与旧版的关键差异：模块切换**不再卸载重挂**（条件渲染 → `.module-hidden` 隐藏），所以"挂载时加载"只发生一次，刷新时机改为**激活事件驱动**（`useModuleActivated`）+ 写后手动 `load()`。这条变化解决的问题是：AI 生成任务不因切页中断（问题疑惑区万象库#A）。

错误统一 `try/catch + message.includes` 分流（见 §3）。

## 7. 新人练习

1. **追踪一次"划词问 AI"**：从 MdDialog 气泡 → 模块 `onAskAi` → `App.tsx` 的 `openAiWith(prefill, { channel })` → `aiPending` state → AiSidebar 预填/自动发送。注意 channel 覆盖逻辑（`CHANNEL_BY_MODULE` 映射 + 显式覆盖）——画出这条纯渲染层的链，它不走 IPC。
2. 打开 `api.d.ts` 和 `preload.ts` 并排抽查 3 个方法签名——体会"手工镜像同步"的成本；想想为什么 api.d.ts 里的 `ModuleId` 还残留一个 `verify`（提示：镜像漂移的活证据——shared/types.ts 已删，镜像漏删。这正是 09 篇技术债 #1 的实物教材）。
3. 思考：`mottos:generate` 要 5-15 秒，连点三次会怎样？（渲染层有 generating 态挡连点；主进程靠 jobId——每次点击不同 jobId 各自生成，重复调用靠查重兜底；这是与旧版"主进程无防重入"不同的答案，取消体系顺带提供了观测。）
4. 对照 `api.d.ts` 数一数 `learn:` 命名空间的方法数，解释为什么学习库独占最大命名空间（提示：建树/出卡/展开/队列/小测/任务/高光/深挖——一个模块 ≈ 别人一个模块族）。
