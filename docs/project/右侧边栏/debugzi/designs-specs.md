# debugzi designs-specs.md —— AI 伴学助手实现规格

> 依据 debugzi/design.md 与已实现代码整理（260907）；本文档为 AI 维护的实现正本，后续改动同步更新。

## 1. 数据表（SQLite，用户数据目录 bugzi.db）

- `ai_sessions(id, title, channel, created_at, updated_at)`——DB v4 建（无 channel），v9 加 `channel`（频道制）；存量会话归 `assistant`。
- `ai_messages(id, role, ai_module, content, created_at, session_id)`——`role: 'user' | 'assistant' | 'system'`；`ai_module` 记消息来源模块（如 mottos/wiki/verify）；FK 挂 session。
- 消息入会话即 bump `ai_sessions.updated_at`（会话列表按 updated_at 倒序浮顶）。

## 2. 设置键（settings 表）

| key | 用途 |
|---|---|
| `ai_active_session_id` / `…_motto` / `…_wiki` / `…_zhijiji` / `…_verify` | 各频道激活会话 id（主进程 `ACTIVE_SESSION_KEYS` 与渲染层常量同名同步；非法/缺失 → null） |
| `ai_width` | 边栏宽度（280–560px） |

## 3. IPC 契约（preload `api.ai` / `api.aiSession`）

| 通道 | 签名 | 说明 |
|---|---|---|
| `ai:chat` | `(message, currentModule, sessionId, channel)` | 发消息：先落库用户消息再调 LLM；带会话最近 30 条上下文 + 频道人设 + 画像索引；失败消息已落不丢 |
| `ai:configured` | `(): boolean` | LLM 是否已配置 |
| `ai:messages` | `(sessionId): AiMessage[]` | 会话消息（id 升序） |
| `ai:message` | 事件（webContents.send） | 系统消息推送（辩真验证过程），渲染层 onMessage 订阅 |
| `ai:pushSystem` | `(content): boolean` | 系统消息落当前激活会话（无则自动新建接收） |
| `ai:deleteMessage` | `(id): boolean` | 删单条消息 |
| `ai:editMessage` | `(id, content): boolean` | 改写消息（画像建议「加入/忽略」后剥协议标记行） |
| `aiSession:list` | `(channel?): AiSession[]` | 会话列表（updated_at DESC） |
| `aiSession:create` | `(channel?): AiSession` | 新会话（默认标题「新对话」） |
| `aiSession:rename` | `(id, title): boolean` | 改名（trim + 截 50 字） |
| `aiSession:delete` | `(id, channel?): boolean` | 删会话连同消息；删激活会话 → 同频道自动切剩余最近，无则清激活 |
| `aiSession:active` | `(channel?): number \| null` | 频道激活会话 id |
| `aiSession:compact` | `(sessionId): AiSession` | /compact：历史 LLM 压 ≤500 字摘要（temp 0.3），另存「· 压缩」新会话，摘要为首条 user 消息（带【前情摘要】头） |
| `aiSession:clear` | `(sessionId): boolean` | /clear：清空会话全部消息，会话与标题保留 |

## 4. 主进程（electron/ai/）

- `services.ts`：会话管理（list/getActive/setActive/create/rename/delete/listMessages/append/edit/clear/compact）、`appendSystemToChannelSession`（系统消息自动建会话）、`MODULE_LABELS`（消息来源模块中文名）。
- **频道人设** `CHANNEL_PERSONAS`（五频道，与渲染层 CHANNELS 同步）：身份声明（AI_NAME 单一事实源）+ 频道行拼合为 system prompt；频道人设全文见代码，概要见 design.md §2。
- **画像记忆化**：`profileIndex()`（索引：类别 + 24 字摘要）入边栏对话 system prompt；`PROFILE_LOOKUP:关键词` 协议——渲染层/主进程识别 `<<<…>>>` 标记（历史摘要压缩时以 `/<<<[^>]*>>>/g` 剥离）检索画像补注入再答一轮；`PROFILE_SUGGEST` 提议入档协议；生成类功能用 `profileDigest()`（每条 60 字）。
- `llm.ts`：OpenAI 兼容 chat/completions；`normalizeChatUrl` 自动拼 `/v1/chat/completions`；429 尊重 Retry-After 否则 2s/4s/8s 退避重试 3 次；`LlmNotConfiguredError` → 渲染层 GoConfigDialog；`listUpstreamModels`（个人档拉模型列表）、`testLlmConnection`。

## 5. 渲染层组件

- `src/components/AiSidebar.tsx/.css`——props 契约（右缘双面板互斥制，第 21 轮）：

| prop | 说明 |
|---|---|
| `collapsed` | 收起（rightPanel !== 'ai' 时 display:none，**不卸载**保生成态回填） |
| `showRail` | 都收起时渲染右缘细条双图标入口（草稿本展开时不渲染，右缘让位） |
| `onExpand` / `onCollapse` | 细条展开 / 头部收起 |
| `onOpenDraft` | 细条切草稿本 |
| `currentModule` | 模块感知（moduleLabel 显示来源） |
| `pending: { text, channel, auto } \| null` | 模块动作直发（openAiWith）；auto 时切频道后自动发送 |
| `onPendingConsumed` / `messagesVersion` | pending 消费 / 消息版本 bump（系统消息触发展开） |
| `onNavigateToProfile` | 「去配置」直达个人档 |

- 内部常量：`CHANNELS`（五频道 id/label/icon）、`ACTIVE_SESSION_KEYS`（与主进程同步）、`ROLE_LABEL`（assistant 显示 AI_NAME）。
- 行为要点：乐观上屏（临时负 id，完成后库记录替换）、消息 MdView 渲染（用户/系统纯文本）、输入框高度自适应（超视口 30% 内滚）、/clear /compact 命令、会话浮层（单击切换/hover 重命名·删除）、删消息保 scrollTop、左缘 7px 拖宽 280–560px。

## 6. 关联链路

- 模块直发：`App.openAiWith(prefill, {auto})` → `CHANNEL_BY_MODULE` 映射频道 → pending → AiSidebar 发送（格言「AI 解读」/万象「问 AI」等）。
- 致知己内嵌追问栏（MdDialog sidePanel 扩展位）：与全局边栏同频道同数据、同一激活会话。
- 辩真（万象库「辩真」板块，260908 并入）：验证过程 `ai:pushSystem` → 激活会话 + `ai:message` 事件；频道经 openAiWith 的 channel 覆盖直连。

## 7. 验收清单（现状核对）

- [x] 五频道独立人设/独立会话历史，切换互不干扰
- [x] 多会话：新建/切换/重命名/删除（二次确认）/自动命名；删激活自动切换
- [x] /clear 清消息保会话；/compact 摘要另存新会话
- [x] 乐观上屏；AI 回复 md 渲染；外链走系统浏览器
- [x] 画像索引注入 + PROFILE_LOOKUP 按需检索 + PROFILE_SUGGEST 提议入档
- [x] LLM 未配置不置灰弹「去配置」；生成中任务不因面板切换中断（常驻挂载）
- [x] 拖宽/收起持久化；右缘细条双面板互斥（第 21 轮）
