# 灵感泉 designs-specs.md

> 本文档由 AI 基于 `docs/project/需求（功能模块）/灵感泉/design.md` 与《总需求文档.md》第 1、5、6 条生成，是开发的直接依据。依赖：样式/designs-specs.md 的 MdDialog、回收站/designs-specs.md 的接入约定。

## 1. 数据表

```sql
CREATE TABLE inspirations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'project' | 'develop' | 'archive'
  md_path TEXT NOT NULL,                 -- md/inspirations/<id>.md
  sort INTEGER NOT NULL DEFAULT 0,       -- 区内排序（拖拽顺序）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
```

## 2. 页面结构

- 四区展示（推荐四列看板，宽度不足时纵向堆叠；实现时定）：草稿区 / 立项区 / 开发区 / 归档区。
- 每区标题：区名 + 条数 + 「+」新建按钮。
- 每条灵感一行/一卡组件：标题 + 更新时间 + 右侧回收站 icon。
- 各区职责与语义：草稿区（记录想法）、立项区（决定要做）、开发区（正在开发）、**归档区（已完成开发的长期存档，不自动删除，可拖回开发区二次开发）**。

## 3. 操作

### 3.1 新建

- 区标题旁「+」→ 弹窗输入标题 → 建表记录 + 创建 md 文件（模板：`# {标题}\n`）→ 该区列表出现新条目。任何区都可直接新建（不强制从草稿区开始）。

### 3.2 查看/编辑

- 点击条目 → MdDialog（title=标题，filePath=md_path），默认渲染态、双击编辑，全局统一交互。
- 标题可在弹窗头部编辑（改后列表同步）。

### 3.3 跨区移动（两种方式）

- **拖拽**（主方式）：任意两区之间自由拖拽（HTML5 drag & drop 或 dnd-kit），放下即改 status、更新 sort；同区内拖拽调整顺序。
- **菜单移动**（补充）：条目悬浮菜单/右键「移动到 → 草稿区/立项区/开发区/归档区」（列出除当前区外的三区）。
- 移动即时生效，无确认弹窗（非破坏性操作）。

### 3.4 丢弃

- 条目右侧回收站 icon → 二次确认（「放入回收站，3 天后自动彻底删除」）→ 进回收站灵感泉板块；恢复回草稿区；彻底删除时 md 文件一并删除。

## 4. 明确不做（v1）

- AI 生成灵感：不做（design.md「具体怎么生成我还没想好，再说」，列 v2 待定）。

## 5. 验收清单

- [ ] 四区展示、计数正确；每区「+」新建（建表+建 md）正确
- [ ] MdDialog 打开/双击编辑/保存正确；标题编辑同步列表
- [ ] 拖拽：跨区移动改 status、区内排序；菜单移动与拖拽等效
- [ ] 丢弃：二次确认 → 回收站灵感泉板块；恢复回草稿区；彻底删除连 md 删
- [ ] 归档区条目不参与 3 天自动删除（仅回收站条目参与）
