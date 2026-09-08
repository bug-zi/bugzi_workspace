# 记账本 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/账本/design.md`（260908 brainstorming 定稿并立项）生成，是开发的直接依据。设计全记录（八项决策与被否方案）见同目录 `archive/2026-09-08-账本-design.md`。依赖：样式/designs-specs.md（ConfirmDialog / Toast / ActionMenu 与主题色系、Material Symbols 用法）、回收站既有机制（recycle.ts，本 spec §5 扩展）。**纯本地零 AI**：不依赖 LLM/MCP/jobs.ts、不新增 AiChannel、CSP 零改动、无新 npm 依赖。260908 已实施（typecheck/build 通过，记录见 `docs/log/260908.md`）；**版本号落定 v21**（无并行挤占），listTx 增补「未分类」筛选哨兵 -1（占比条未分类桶下钻，categoryId NULL 与全部的 null 需区分）。
> **260908 显示名更名（开发者指令）**：记账本 → **记账本**（ModuleId `ledger`、目录名、DB 表名均不变，仅 UI 文案含回收站块名与恢复去向文案）。

## 0. 命名与常量

- `ModuleId`（src/shared/types.ts:4）增 `'ledger'`；App.tsx `MODULES` 注册 `{ id: 'ledger', label: '记账本', icon: 'account_balance_wallet' }`，位置（260908 重排后）在推理角与白噪音之间（… → reasoning → **ledger** → noise → recycle → profile）。
- **不新增 AiChannel**（零 AI 模块）；`CHANNEL_BY_MODULE` 不列 → 默认 'assistant'。
- 金额上限：`MAX_AMOUNT_CENTS = 9_999_999_999`（约 1 亿元）；月份参数格式 `'YYYY-MM'`；流水日期 `'YYYY-MM-DD'`。
- 元↔分换算：输入 `Math.round(parseFloat(x) * 100)`，展示 `(cents / 100).toFixed(2)`；合法性：`/^\d+(\.\d{1,2})?$/` 且 > 0 且 ≤ 上限。

## 1. 数据表（DB v21）

```sql
CREATE TABLE ledger_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  initial_balance_cents INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE ledger_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE ledger_tx (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                      -- 'YYYY-MM-DD'
  type TEXT NOT NULL CHECK (type IN ('expense','income')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  category_id INTEGER,                     -- NULL = 未分类
  account_id INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_ledger_tx_date ON ledger_tx(date);
CREATE INDEX idx_ledger_tx_account ON ledger_tx(account_id);
```

- **版本号实况**：设计基准 **v21**（当前 `user_version = 20`）；若被并行会话挤占则顺延，以 db.ts 实际为准（信息源 v19→v20 先例）。
- **种子数据**（迁移内随建表一次性写入）：账户——现金/微信/支付宝/银行卡（期初 0，sort 0-3）；支出分类——餐饮/交通/购物/居住/娱乐/医疗/学习/其他；收入分类——工资/理财/副业/红包/其他。
- **不依赖外键级联**（不依赖 PRAGMA，与信息源先例一致）：级联全部显式 SQL（§2/§5）。
- 类型补 `src/shared/types.ts` + `src/renderer/api.d.ts`：`LedgerAccountView`（含 `balanceCents`）、`LedgerCategory`（含 `kind`）、`LedgerTxInput`、`LedgerTxView`（带 `categoryName`/`accountName`）、`LedgerStats`。

## 2. 主进程 LedgerService（新建 `electron/services/ledger.ts`）

### 2.1 账户

- `listAccounts()`：余额实时聚合——
  `SELECT a.*, a.initial_balance_cents + COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount_cents ELSE -t.amount_cents END), 0) AS balance_cents FROM ledger_accounts a LEFT JOIN ledger_tx t ON t.account_id = a.id AND t.deleted_at IS NULL WHERE a.deleted_at IS NULL GROUP BY a.id ORDER BY a.sort, a.id`。
- `saveAccount(id | null, name, initialBalanceCents)`：name trim 非空、与未删账户重名 throw；新建 sort 取 MAX+1。
- `removeAccount(id)`：`discardToRecycle('ledger_account', id)` 后级联软删——`UPDATE ledger_tx SET deleted_at = <入站时间> WHERE account_id = ? AND deleted_at IS NULL`（已在站的流水不动）。

### 2.2 分类

- `listCategories()`：`WHERE deleted_at IS NULL ORDER BY kind, sort, id`（前端分两组渲染）。
- `saveCategory(id | null, name, kind)`：同 kind 内非空查重。
- `removeCategory(id)`：先断链——`UPDATE ledger_tx SET category_id = NULL WHERE category_id = ? AND deleted_at IS NULL`（**软删流水不断链**，其恢复应保持原分类）→ `discardToRecycle('ledger_category', id)`。

### 2.3 流水

- `listTx(month, categoryId?)`：`WHERE deleted_at IS NULL AND strftime('%Y-%m', date) = ?`（categoryId 时加 `AND category_id = ?`）`ORDER BY date DESC, id DESC`；`LEFT JOIN ledger_categories c ON c.id = t.category_id AND c.deleted_at IS NULL`、`LEFT JOIN ledger_accounts a ON a.id = t.account_id AND a.deleted_at IS NULL` 取显示名，断链显示 `'未分类'`（防分类彻底删后悬空引用；账户侧同理兜底）。
- `saveTx(id | null, input)`：amount_cents > 0 且 ≤ 上限；date 合法日历日；category_id 校验存在且未删（可空）；account_id 必须存在且未删。
- `removeTx(id)`：`discardToRecycle('ledger_tx', id)`。
- `stats(month)`：未删流水按 type 汇总 income/expense cents + 支出按分类 GROUP BY（断链归入「未分类」桶）得 `breakdown: { categoryId, name, cents, pct }[]`（pct 占当月支出比，支出为 0 时 breakdown 为空数组）。

## 3. 渲染层（`src/modules/ledger/`）

### 3.1 LedgerModule.tsx（单主视图）

- 状态：`month`（默认当月）、`filterCategoryId: number | null`、账户/统计/流水三组数据；保存/删除后全部重载（实时聚合无需局部对账）。
- `useModuleActivated('ledger', load)`：切回模块刷新（回收站恢复记账本条目后回来即见）。
- 卡片区：总资产卡（Σ 余额，不随月份）+ `< 2026年9月 >` 切换 + 收入/支出卡（随月份）；月份可无限前翻。
- 占比条：`breakdown` 渲染（分类名 + 占比条 div 宽度百分比 + 金额 + 百分比）；条与文字用主题色 CSS 变量（浅樱粉/深宝蓝），**禁彩亮色**；点击行 toggle `filterCategoryId`（选中态主题色描边），列表随筛；再点或点「全部」取消。
- 流水列表：`listTx` 结果按日分组；组头 `MM月DD日` + 今天/昨天相对称呼 + 当日支出小计；行 = `分类 · 账户 · 备注` + 金额（支出 `-¥36.00`，收入 `+¥xxx`；颜色仅主题文字色）；行尾 `⋯` 复用 `ActionMenu`（编辑/删除）。
- 空状态：所选月无流水 → 一句引导文案 + 「记一笔」入口。
- 删除流水走 `ConfirmDialog`（全局规则）。

### 3.2 TxDialog.tsx（新增/编辑复用）

- 字段序：金额 input（数字键盘 `inputMode="decimal"`，回车提交）→ 支出/收入 toggle（默认支出）→ 分类宫格点选（随 toggle 换组；**可不选** = 未分类，`category_id` 留 NULL）→ 账户横排点选（必选，默认第一个账户）→ 日期 `input type="date"` 默认今天 → 备注 input 选填。
- 校验（§0 换算规则）失败即 Toast，不关弹窗；编辑模式预填 + 「删除」按钮（ConfirmDialog）。

### 3.3 ManageDialog.tsx

- tab 账户/分类。
- 账户 tab：行 = 名称 · 当前余额 · 编辑（名称 + 期初余额）/删除；新建同理。删除确认文案：`该账户下有 N 笔流水，将一并移入回收站`（N 由主进程随 remove 前查——渲染层传不进，改由 `ledger:accounts:remove` 返回 `{ cascaded: N }` 供 toast）。
- 分类 tab：支出/收入两组；删除在用时确认文案：`有 N 笔流水的分类将变为「未分类」`（同上，`ledger:categories:remove` 返回 `{ detached: N }`）。

### 3.4 ledger.css

- 卡片、占比条、宫格点选、分组列表、弹窗表单样式；双主题经既有 CSS 变量体系适配，与全 App 风格一致。

## 4. IPC 与 preload（ipc.ts + preload.ts + api.d.ts 三处同步）

| 通道 | 签名 | 行为 |
|---|---|---|
| `ledger:accounts:list` | `() => Promise<LedgerAccountView[]>` | 含实时余额 |
| `ledger:accounts:save` | `(id: number \| null, name: string, initialBalanceCents: number) => Promise<void>` | 新建/更新；重名抛错 |
| `ledger:accounts:remove` | `(id) => Promise<{ cascaded: number }>` | 入回收站 + 级联软删流水（§2.1） |
| `ledger:categories:list` | `() => Promise<LedgerCategory[]>` | 未删全量（前端分组） |
| `ledger:categories:save` | `(id: number \| null, name: string, kind) => Promise<void>` | 同 kind 查重 |
| `ledger:categories:remove` | `(id) => Promise<{ detached: number }>` | 断链 + 入回收站（§2.2） |
| `ledger:tx:list` | `(month: string, categoryId?: number \| null) => Promise<LedgerTxView[]>` | 带分类/账户显示名 |
| `ledger:tx:save` | `(id: number \| null, tx: LedgerTxInput) => Promise<void>` | 校验见 §2.3 |
| `ledger:tx:remove` | `(id) => Promise<void>` | 入回收站 |
| `ledger:stats` | `(month: string) => Promise<LedgerStats>` | 收支合计 + 支出分类 breakdown |

- 渲染层错误处理：catch 后 `useToast` 显示 message（名称查重/校验失败均走此路径）。

## 5. 回收站接线（八块 → 九块）

- recycle.ts：`RecycleSource` 增 `'ledger_tx' | 'ledger_account' | 'ledger_category'`；`TABLES` 映射三表；`MD_FIELDS` 三项均为 null（无附属 md，走默认路径）。
- `restoreFromRecycle` 分派：
  - `ledger_tx` / `ledger_category` → 仅清 `deleted_at`（流水原样回来；分类回列表不回挂）。
  - `ledger_account` → 清账户标记 + **级联恢复**：`UPDATE ledger_tx SET deleted_at = NULL WHERE account_id = ? AND id NOT IN (SELECT item_id FROM recycle_bin WHERE source = 'ledger_tx')`（有独立回收记录的在站流水不越权拉活——「先删流水后删账户」场景防幽灵恢复）。
- `hardDelete` 分派：
  - `ledger_tx` / `ledger_category` → 默认路径删行。
  - `ledger_account` → 删账户行 + `DELETE FROM ledger_tx WHERE account_id = ? AND id NOT IN (SELECT item_id FROM recycle_bin WHERE source = 'ledger_tx')`（在站流水留给自己的回收流程处置）。
- RecycleModule.tsx：
  - `TABS` 增 `{ key: 'ledger', label: '记账本' }`（文笔坊之后）。
  - `tabOf`：三 source → `'ledger'`。
  - `backToOf`：`ledger_tx` → `'记账本月度列表'`、`ledger_account` → `'记账本账户列表'`、`ledger_category` → `'记账本分类列表'`。
  - `srcTag`：`'流水 · '` / `'账户 · '` / `'分类 · '`。
  - `summaryOf`：流水 `` `${date} ${category_name ?? '未分类'} ${type==='expense' ? '-' : '+'}¥${(amount_cents/100).toFixed(2)}` ``、账户 `` `账户：${name}` ``、分类 `` `${kind==='expense' ? '支出' : '收入'}分类：${name}` ``。
  - **快照冗余**：流水入站前的行快照需带显示名——`ledger:tx:remove` 在 discard 前用 `SELECT t.*, c.name AS category_name, a.name AS account_name`（LEFT JOIN 口径同 §2.3）取整行再交 `discardToRecycle` 入 payload，summaryOf 从 payload 直取 `category_name ?? '未分类'`；恢复/删除只读写已知列，不受冗余列影响。
- `cleanupExpired` / `recycle:changed` 推送机制零改动（走既有分派）。

## 6. 接线

- App.tsx：`MODULES` 增 ledger（260908 重排后为 reasoning → ledger → 白噪音控件 → recycle）；keep-alive 区 `{m.id === 'ledger' && <LedgerModule />}`（切页仅隐藏不卸载）；**不传 `onOpenAi`**（零边栏联动）。
- `src/modules/ledger/`：`LedgerModule.tsx` + `TxDialog.tsx` + `ManageDialog.tsx` + `ledger.css`。

## 7. 明确不做（design.md 背书）

- 转账、账单导入、预算与超支提醒、图表库、多币种、周期自动记账、AI 总结、借贷/应收（v2 备选）。
- 不新增 AI 边栏频道（五频道不动）；CSP 零改动；无新依赖。

## 8. 验收清单

- [ ] DB v21 迁移：三表 + 索引 + 种子；新装库顺序迁移覆盖
- [ ] 记一笔：金额校验（>0、≤上限、两位小数）；保存后卡片/占比条/流水列表/账户余额全联动；回车提交
- [ ] 月份切换过滤卡片/占比条/列表；总资产不随月份变；可翻历史月份
- [ ] 期初余额：新建/编辑账户设置后该账户余额与总资产立即体现
- [ ] 占比条点击分类 → 流水列表筛选；取消恢复
- [ ] 编辑流水预填正确；弹窗内删除走二次确认
- [ ] 删流水 → 回收站记账本块 → 恢复原样回来（原日期/账户/分类）
- [ ] 删带流水账户：确认文案含流水数；站内仅账户一条；恢复级联拉回流水；彻底删级联清且不误删在站流水（「先删流水后删账户」双场景）
- [ ] 删在用分类：流水变「未分类」；恢复不回挂；分类彻底删后流水仍显「未分类」（LEFT JOIN 防悬空）
- [ ] 回收站九块：记账本页签三 source 混排、恢复去向文案、剩余时间显示
- [ ] 名称查重（账户全局、分类同 kind）Toast 拒绝
- [ ] 金额精度：0.1 + 0.2 累计显示 0.30
- [ ] 双主题下卡片/占比条/宫格/弹窗外观一致；`npm run typecheck` / `npm run build` 通过
