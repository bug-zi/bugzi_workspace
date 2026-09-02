# 04 - IPC 通信设计

> 目标：掌握本项目所有进程间通信的命名规律、数据流方向、错误约定。读完你应能"看到任何按钮，脑内自动放出完整调用链"。

## 1. 通道全景图

`electron/preload.ts`（= `src/renderer/api.d.ts`）暴露 9 个命名空间，`electron/ipc.ts` 一一对应注册。**通道名字符串只出现在这两个文件里**——这是铁律，别处出现裸字符串通道名就是破坏抽象。

| 命名空间 | 通道前缀 | 方向 | 职责 | ipc.ts 位置 |
|---|---|---|---|---|
| `settings` | `settings:` | 双向 invoke | 键值设置读写 | :37-44 |
| `md` | `md:` | invoke | md 文件 read/write/create/delete | :47-59 |
| `image` | `image:pick` | invoke | 原生选图对话框 + 落盘 | :62-110 |
| `item` | `item:discard` | invoke + **事件** | 四模块统一丢弃入口 | :121-127 |
| `recycle` | `recycle:` | invoke + 广播消费端 | 回收站列表/恢复/彻底删 | :130-140 |
| `ai` | `ai:` | invoke + **事件** | 边栏消息/对话/配置检测 | :143-152 |
| `mottos`/`wiki`/`inspirations`/`verify` | 各自前缀 | invoke | 模块 CRUD + AI 生成 | :155-302 |
| `llm`/`mcp` | `llm:`/`mcp:` | invoke | 个人中心的连接测试/列表 | :305-306 |
| `shell` | `shell:openExternal` | invoke | 外链系统浏览器打开 | :309-312 |

命名规律：**`领域:动词`**，领域与 preload 命名空间一致。找某功能的实现 = 全局搜 `领域:`，只会命中 preload 和 ipc.ts 两处。

## 2. 三种通信形态

### 形态 A：invoke 请求-响应（占 90%）

```ts
// 渲染层
const rows = await window.api.mottos.list()

// preload
list: (status?) => ipcRenderer.invoke('mottos:list', status)

// 主进程
ipcMain.handle('mottos:list', (_e, status?) => { ... return rows })
```

- 返回值经结构化克隆过进程边界，**Promise 化**。
- 参数与返回的类型契约靠 preload 的函数签名 + api.d.ts 镜像维护。
- 主进程抛出的 Error，其 `message` 会原样传到渲染层 `catch (e)` 里——这是下文错误约定的基础。

### 形态 B：主进程广播 + 渲染层订阅

只有两条广播通道，都是"通知某数据变了，拉去吧"（thin notification，不带数据或带轻数据）：

```
'recycle:changed'   触发点：item:discard / recycle:restore / recycle:delete 之后
                    消费者：RecycleModule（刷新列表）

'ai:message'        触发点：pushAiSystemMessage（写库 + send 双动作，ipc.ts:30-33）
                    消费者：AiSidebar（重载消息）、VerifyModule（bump 计数让 App 层通知边栏）
```

**为什么不把数据塞进广播里？** 因为渲染层状态管理极简（没有 store），收到通知后重新 `list()` 全量拉是最不容易出错的做法——个人应用数据量小，全量拉的成本可忽略，换来的是"状态永远以 DB 为准"的一致性模型。

### 形态 C：长流程的进度推送（辩真阁专用）

`verify:run` 是全项目最复杂的 IPC 调用——一次 invoke 内部跑多轮 LLM+MCP，同时把进度实时推到另一条通道：

```
渲染层 invoke('verify:run', claim)
   │
主进程 runVerification(claim, onProgress)        ai/services.ts:200
   ├→ ① LLM 生成关键词      ──┐
   ├→ ② MCP 检索 ×3 组       ──┤ 每步 onProgress('正在检索：xxx')
   ├→ ③ LLM 综合分析        ──┘      │
   ├→ ④ 写 DB + md                    ├→ pushAiSystemMessage:
   └→ return {recordId, credibility}  │    appendAiMessage('system', ...) 入库
                                      │    webContents.send('ai:message') 推送
                                      ▼
                            AiSidebar 收到 → 重载 → 用户看到「正在检索：xxx」
```

**学到的模式**：长任务把「最终结果」（invoke 返回值）和「过程进度」（事件流）分离在两条通道；进度同时落库（appendAiMessage），所以即使边栏当时收起，展开后历史进度也在。

## 3. 错误传递约定（重点，容易踩坑）

本项目**没有**统一的错误对象协议，只有一条朴素约定：**主进程抛 Error，渲染层拿 message 字符串做包含判断**。

主进程定义的机器可读错误码（`src/shared/types.ts:120-125`）：

```
'LLM_NOT_CONFIGURED'   LLM 一个都没配
'MCP_NOT_ENABLED'      MCP 一个都没启用
'NOT_FOUND'            行不存在
'CONFLICT[:词条名]'     万象库词条重复
```

渲染层的标准消费姿势（MottosModule.tsx:67-73）：

```ts
catch (e) {
  const msg = String((e as Error).message)
  if (msg.includes('LLM_NOT_CONFIGURED')) setGoConfig(true)   // → 弹「去配置」
  else setFailMsg(msg)                                          // → 弹失败详情 + 重试
}
```

为什么用 `includes` 而不是全等？因为主进程有时会包装信息（如 `CONFLICT:边际效应` 带参数，或网络错误拼接前后文），包含匹配容错更高。

**注意 ELECTRON_ERRNO**：invoke 链路上主进程 throw 的 Error 经 Electron 序列化，message 保留但 stack 丢失——所以主进程错误必须在抛出点就把人类可读信息写进 message。

## 4. 一个通道的完整解剖：`item:discard`

挑最典型的"跨模块复用"通道看它是怎么设计的（ipc.ts:113-127）：

```ts
type ItemKind = 'mottos' | 'wiki_entries' | 'inspirations' | 'verify_records'
const RECYCLE_MAP: Record<string, 'mottos'|'wiki'|'inspirations'|'verify'> = {
  mottos: 'mottos', wiki_entries: 'wiki', inspirations: 'inspirations', verify_records: 'verify'
}

ipcMain.handle('item:discard', (_e, table: string, id: number) => {
  const source = RECYCLE_MAP[table]
  if (!source) throw new Error('UNKNOWN_TABLE')
  discardToRecycle(source, id)
  win()?.webContents.send('recycle:changed')
  return true
})
```

设计要点：

1. **四张业务表共用一个丢弃入口**——参数是表名字符串（不是四个通道），因为四个模块的丢弃语义完全一致：软删 + 快照入 recycle_bin + 广播。
2. `RECYCLE_MAP` 解决**表名 ≠ 来源标识**的历史不一致（wiki_entries → 'wiki'），白名单映射顺便挡掉了非法表名（SQL 表名不能参数化，必须拼接，所以这里用映射表防注入）。
3. 丢弃后**主动广播** `recycle:changed`——调用方（各模块）不需要知道"回收站关心这件事"。

对照渲染层的调用（MottosModule.tsx:78）：`window.api.mottos.discard(id)` —— 等等，这不是 `mottos.discard` 吗？看 preload（preload.ts:67）：

```ts
discard: (id: number) => ipcRenderer.invoke('item:discard', 'mottos', id)
```

**命名空间糖**：渲染层按模块调 `api.mottos.discard(id)`，preload 负责补上第一参数路由到公共通道。语义上"格言模块的丢弃"实现上是"公共条目丢弃(表=mottos)"。

## 5. 参数设计的三条惯例

翻遍 ipc.ts 可以总结出：

1. **简单标量参数，不传对象**（除了 `inspirations:reorder` 的 moves 数组和 `llm:test` 的 config 对象）。IPC 参数越扁越好序列化调试。
2. **id 永远是 number，路径永远是 userData 相对路径**（如 `md/mottos/3.md`）——绝对路径不出主进程，防信息泄露也防渲染层伪造。
3. **写操作返回 boolean 或新 id**，读操作返回行数组/单行（**snake_case 字段名直通**，不做 camelCase 转换——DB 列名就是 API 字段名，少一层映射少一层错）。渲染层类型（api.d.ts）直接按 snake_case 声明，如 `note_path`、`created_at`。

## 6. 渲染层消费 IPC 的标准范式

每个模块的骨架几乎一样，背下这个模板：

```tsx
const [items, setItems] = useState<MottoRecord[]>([])

// 1) 加载函数用 useCallback 包（依赖空数组 = 稳定引用）
const load = useCallback(async () => {
  setItems(await window.api.mottos.list())
}, [])

// 2) 挂载时加载
useEffect(() => { void load() }, [load])

// 3) 每次写操作完成后手动调 load() 刷新（无自动失效机制）
const doAdd = async () => {
  await window.api.mottos.create(...)
  await load()
}

// 4) 错误统一 try/catch + message.includes 分流
```

**没有** React Query / SWR 这类数据层库——失效策略是手动的"写完就 load"。代价是忘了 load 就看到旧数据；收益是零抽象、行为完全可预测。个人项目这个取舍成立。

## 7. 新人练习

1. **追踪一次划词问 AI**：从 `MdDialog` 的气泡按钮 `问AI`（MdDialog.tsx:127）开始，跟到 WikiModule 的 `onAskAi`，再看它如何调 props 里的 `onOpenAi(prefill)` 上浮到 `App.tsx` 的 `openAiWith`，最终 `setAiPendingAsk` 预填进 `AiSidebar`。画出这条**纯渲染层**的props 传递链（它不走 IPC，是"组件间通信"的对照样本）。
2. 打开 `api.d.ts` 和 `preload.ts` 并排，抽查 3 个方法签名是否一致——体会"手工镜像同步"的维护成本，想想用什么办法能让它自动（提示：让渲染层直接 `import type { Api } from '../../electron/preload'`，为什么现在没这么做？tsconfig 边界）。
3. 思考：`mottos:generate` 要 5-15 秒（LLM），如果用户连点三次按钮会发生什么？代码哪里防了？（MottosModule 的 `generating` state + `if (generating) return`；主进程没有防重入——双层防护只做了前端一层，这是个可以改进的点。）
