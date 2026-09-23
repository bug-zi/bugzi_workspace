# 信息源：rsshub:// 协议支持（优化建议区第46轮）

## 背景与需求

开发者添加 `rsshub://sspai/index` 订阅失败。probeFeed（electron/services/feed.ts）入口校验强制 `^https?://`，RSSHub 分享格式 `rsshub://<路由>` 直接被拒。

微信公众号订阅经 brainstorming 商讨（2026-09-16）：公众号官方无 RSS，一切路线都依赖外部 feed 生成服务（wewe-rss 自部署 / wechat2rss 免费聚合源等），**开发者拍板存档暂缓、本轮不实现**；本轮只做 rsshub:// 协议层支持。将来公众号 feed 生成后本就是普通 RSS 直链，无需 App 侧额外适配。

## 决策

- **默认实例 rsshub.app**：`rsshub://sspai/index` → `https://rsshub.app/sspai/index`。
- **逐条实例覆盖**：`rsshub://` 后首段形如域名（含点、可带端口）时视为实例地址——`rsshub://my.rsshub.dev/sspai/index` → `https://my.rsshub.dev/sspai/index`。依据：RSSHub 路由命名空间不含点，无歧义；不新增全局实例设置键（YAGNI，暂缓公众号后暂无自建实例场景，逐条覆盖已够用）。
- **落库存展开后的真实 https 直链**：addFeed 本就存 `probed.feedUrl`，展开发生在 probe 之前，拉取/去重天然一致；订阅列表不感知协议，DB 零迁移。
- 不支持的写法（如 `rsshub://` 后为空）保持原报错路径（「请输入 http/https 链接」）。

## 方案细节

feed.ts probeFeed 入口归一化（新增模块内纯函数 `expandRsshub`）：

```
rsshub://sspai/index            → https://rsshub.app/sspai/index
rsshub://host.tld/path(:port)?  → https://host.tld(:port)?/path
其余（含 http/https）            → 原样透传
```

正则判定域名段：`^[\w-]+(\.[\w-]+)+(:\d+)?`；命中即实例覆盖，否则拼默认实例。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| electron/services/feed.ts | 新增 expandRsshub 纯函数；probeFeed 入口调用 |
| src/modules/feed/FeedModule.tsx | 添加订阅弹窗 placeholder 补「支持 rsshub:// 路由」提示 |

## 待冒烟

- `rsshub://sspai/index` 添加成功且「实际订阅源」显示 https://rsshub.app/sspai/index
- `rsshub://rsshub.app/sspai/index` 域名形式等价展开
- 重复添加（rsshub:// 与 https 两种写法）正确报「该订阅已存在」
- 既有 http/https 直链与首页自动发现回归不受影响

## 反馈修订（260916 14:38）：默认实例不可用，改为可配置

开发者实测 `rsshub://sspai/index` 报错。取证：rsshub.app 直连/代理均 **403**，响应体官方声明「仅作测试用途、逐步限制 feed 阅读器访问、建议自建」——公共官方实例不能用作订阅源；当日实测公共镜像 `hub.slarker.me`、`rsshub.ktachibana.party` 返回 200 且内容为正常 RSS，`rss.owo.nz`/`rsshub.rss.tips` 502、其余超时。

修订三点：

1. **默认实例改 `https://hub.slarker.me`**（当日实测可用公共镜像；公共镜像可用性随时变化，故必须可换）。
2. **实例可配置**：新 SettingsKeys `feed_rsshub_base`，添加订阅弹窗内「RSSHub 实例」输入行（改即存 settings）；expandRsshub 改收 base 参数（probeFeed 每次从 settings 读，主进程单点兜底默认值；无协议自动补 https://、尾斜杠归一）。
3. **拒绝时友好提示**：rsshub:// 展开源遇 403/429/5xx 时报「RSSHub 实例拒绝了请求…请更换 RSSHub 实例或自建部署」替代裸「HTTP 403」。

改动收敛 feed.ts + FeedModule.tsx + feed.css + shared/types.ts 四文件，typecheck 双配置 + build 通过；hub.slarker.me/sspai/index 内容抽检为正常 RSS 2.0（少数派）。
