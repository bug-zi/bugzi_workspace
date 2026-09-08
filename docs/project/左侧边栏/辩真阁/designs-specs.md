# 辩真阁 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/辩真阁/design.md` 与《总需求文档.md》第 1、5、6、8 条生成，是开发的直接依据。依赖：样式/designs-specs.md 的 AI 边栏与 MdDialog、回收站/designs-specs.md 的接入约定、个人档的 MCP 配置。
> **260908 模块解散（开发者指令：辩真阁并入万象库）**：左栏独立模块移除，面板整体迁为 `src/modules/wiki/VerifyPanel.tsx`（万象库「辩真」板块，交互见 万象库/designs-specs.md 头部注记）。**本 specs 描述的功能行为全部继续有效**（提交即验/重复检测/MCP 检索/过程推核查频道/回收站流转），数据层零改动；`ModuleId` 移除 `'verify'`，回收站 verify 来源聚合进「万象库」块显示。

## 1. 数据表

```sql
CREATE TABLE verify_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim TEXT NOT NULL,            -- 原观点
  analysis TEXT NOT NULL,         -- 验证分析文字
  credibility INTEGER NOT NULL,   -- 综合可信度 0-100
  md_path TEXT NOT NULL,          -- 详情 md（md/verify/<id>.md）
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
```

- 详情 md 内容（生成时写入，含来源链接）：

```md
# 验证：{原观点}

**可信度：{N}%** ｜ 验证时间：{time}

## 分析
{analysis}

## 来源
- [来源标题](url)
- ...
```

## 2. 页面结构

- 主栏上部：观点输入框（多行）+ 提交即自动验证（无「验证」按钮，回车/失焦提交按钮自定，实现时保证「输入后自动开始」的体验）。
- 主栏下部：历史记录列表，按时间倒序：每行 = 原观点摘要 + 可信度百分比（徽章样式，主题色系）+ 验证时间 + 删除操作。

## 3. 验证流程

1. 输入观点提交 → **重复检测**：历史中已有相同观点（规范化比对）→ 提示「已于 {date} 验证过」+ 两按钮：「查看旧记录」（打开旧记录 MdDialog）/「重新验证」（继续，新结果另存新记录，不覆盖旧记录）。
2. 前置检查：
   - LLM 未配置 → 「去配置」弹窗（总需求文档第 8 条）。
   - **MCP 未启用（无可用搜索 MCP）→ 同样「请先在个人档配置 MCP」+「去配置」直达**。
3. 验证执行（主进程）：LLM 通过 MCP 搜索工具多轮检索（搜索了什么关键词、引用了哪些来源），随后综合产出：分析文字 + 可信度百分比 + 来源链接列表。
4. **过程可见**：验证过程中的检索步骤作为系统消息实时推送到右侧 AI 助手边栏（自动展开），用户可在边栏追问（如「第二个来源可靠吗」）。
5. 完成：写 verify_records + md 文件 → 列表顶部出现新记录 → toast「验证完成，可信度 N%」。

## 4. 记录操作

- 点击记录 → MdDialog（title=观点摘要，filePath=md_path），渲染态查看、双击可编辑（全局统一）。
- 删除：二次确认 → 进回收站辩真阁板块；恢复回历史列表；彻底删除时 md 一并删。

## 5. 验收清单

- [ ] 输入观点自动开始验证；LLM/MCP 未配置时对应引导弹窗
- [ ] 验证过程消息实时出现在 AI 边栏，可追问
- [ ] 记录字段完整：观点/分析/可信度/来源链接/时间；链接可点击（shell.openExternal）
- [ ] 重复观点提示旧记录并可查看/重验；重验另存新记录
- [ ] 详情 MdDialog 渲染/编辑统一；删除→回收站辩真阁板块、恢复、彻底删除正确
