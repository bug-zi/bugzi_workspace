# 信息源·阅读视图 Ctrl+滚轮字体缩放 设计记录

> 创建于 2026-09-16 02:04
> 来源：`docs/project/新功能开发区.md` 待完成区任务三（开发者 260916 提出，当日 brainstorm 商定；开发者要求先分析推广可行性再定范围）。
> 定位：信息源阅读视图支持 Ctrl+滚轮缩放文章字号。本期**只做信息源**，全项目推广不做一刀切，后续按阅读场景逐个接入。

## 一、需求结论（brainstorm 摘要）

| 维度 | 结论 |
|---|---|
| 推广范围 | **仅信息源阅读视图**（ArticleView）；epub/pdf 阅读器、MdView 弹窗、其他模块本期不做 |
| 记忆方式 | **全局记一档**——settings 键存一个缩放值，所有文章共用，重启保留（同书架「阅读模式全局记忆」惯例） |
| 缩放参数 | 范围 80%–200%、步进 10%；上滚放大、下滚缩小，到边界停住 |
| 应用面 | 整个文章容器（标题/元信息/AI 总结卡/正文）一体缩放，缩放感一致 |
| 操作 | Ctrl+滚轮为主；缩放变化时底部中央浮出指示条，点击指示条复位 100% |

## 二、推广可行性分析结论（留档）

- **个人档全局字号冲突**：滚轮若直接改全局字号，误滚全 App 生效，风险大——故本功能定位为阅读视图**局部缩放系数**，与个人档设置解耦，不写 `font_size`。
- **epub/pdf 有坑**：epub 正文在 iframe 内，主文档监听不到内部滚轮，需注入脚本桥接；pdf 自带缩放语义撞车——本期均不碰。
- **适合场景**仅长文阅读面（信息源阅读、MdView、epub）；列表/表单/左栏等 UI 面不适合。后续扩展按「场景逐个 opt-in」演进，共用同一 settings 键口径的可再议。

## 三、实现（ArticleView 单组件改动）

- **监听**：`.feed-reader-scroll` 容器上用原生 `addEventListener('wheel', handler, { passive: false })`（useEffect 挂/卸；React 合成 onWheel 是 passive 的，`preventDefault` 无效，必须原生绑定）。`e.ctrlKey` 时 `preventDefault()`——阻断 Chromium/Electron 默认整页缩放——并按 `e.deltaY` 方向 ±10 步进、clamp 80–200。
- **持久化**：`SettingsKeys` 新增 `FeedZoom: 'feed_reader_zoom'`（字符串存数字）；初始值经 `useAppSettings().settings` 读（缺省 100），变更经 `setSetting` 落库。settings KV 开放 schema，**零 DB 迁移**。
- **应用**：`.feed-article` 容器 inline `fontSize: ${zoom}%`（内部 `0.85em` 等相对字号自然跟随）。
- **指示条**：zoom 变化时阅读页底部中央浮出「110%」小条（点击复位 100%），1.5s 无变化后淡出（定时器清理）；仅阅读页内绝对定位，不全局。

## 四、容错与边界

- 无 Ctrl 普通滚轮行为完全不变（列表页、其他模块零影响）。
- settings 值损坏（非数字/越界）：解析失败或越界回落 100。
- 纯渲染层改动，零主进程、零依赖、零 AI。

## 五、不做（YAGNI）

+/- 按钮与 Ctrl+=/Ctrl+- 快捷键、双击复位、每篇文章独立记忆、记住滚动位置随缩放补偿、epub/pdf、MdView 弹窗、全局推广。

## 六、涉及文件

- 改动：`src/modules/feed/ArticleView.tsx`（监听 + 缩放 state + 指示条）、`src/shared/types.ts`（SettingsKeys.FeedZoom）、`src/modules/feed/feed.css`（指示条样式）
- 文档：`新功能开发区.md` 移入归档区、`docs/log/260916.md` 开发日志

## 七、验证清单

- `npm run typecheck` 双配置 + `npm run build` 通过。
- 运行时冒烟（开发者）：Ctrl+上/下滚放大缩小与 80/200 边界停住；不按 Ctrl 滚动行为不变；缩放时界面其他部分（左栏/右栏/列表）字号不变（默认整页缩放未被触发）；指示条浮出、点击复位、1.5s 淡出；重启后记住上次缩放；AI 总结卡与正文一体缩放；AI 总结生成中缩放不干扰。
