# 播客台 ASR 转写提速 — 设计

> 创建于 2026-09-26 11:33
> 来源：优化建议区第 58 轮任务 1（ASR 单集转写 10 分钟 → 目标 2-3 分钟）

## 一、诊断（基于 llm_usage 实测数据）

- `podcast:polish` 共 15 次调用、平均 **165s/次**、completion ≈1.1 万 token/次——排版 LLM 深度思考（glm 默认开思维链）是**最大瓶颈**，与第 32 轮格言生成同病（当时 249.7s/10,046 tok，关思维链后 21.3s/774 tok）。
- 单集音频实测 27MB~261MB：>45MB 走 `transcribeChunked`（~40MB 帧对齐分片），当前**串行**逐片转写，大文件耗时按片数线性叠加。
- 结论：光提速 ASR 不够，排版才是大头；三管齐下。

## 二、方案（electron/services/podcast.ts 单文件，零 DB 零 IPC 零 UI）

### 1. 排版关思维链（最大头）

`polishTranscript` 每块 `chatCompletion` 增加 `thinking: 'disabled'`。

- `ChatOptions.thinking` 为既有机制（electron/ai/llm.ts:140）：仅 `/^glm/i` 模型实际发送 `body.thinking`，其余模型一律不发参数——溢出路由/非 glm 配置零风险（llm.ts:244 同款注释口径）。
- 预期 165s/块 → 10~20s/块。

### 2. 排版分块并行

- `splitForPolish` 切块逻辑不变；执行由串行 for 改 `Promise.all`（块数通常 2~4，LLM 层已有 maxConcurrent/溢出路由兜底）。
- **按序拼接**：`map` 保序，结果顺序与块序一致。
- **单块失败/返回空 → 回退原块**（逐块 try/catch）——「排版永不让文字变少」口径不变。
- 日志每块一条（块序 + 原字数 → 出字数）。

### 3. ASR 分片并行

- `transcribeChunked` 重构两段：先 `sliceMp3Chunks(buf)` 纯函数切出帧对齐分片数组（复用 `findFrameSync`，切片算法逐字保留），再并发转写。
- 并发上限 **3**（简易工作池，防 ASR 服务商限流）。
- 按序拼接（`map` 保序 + filter 空串，同现状）。
- 任一分片失败 → 整体 throw（外层 `processTranscribe` 置 failed，与现状一致；不重试不吞错）。
- 分片日志保留（`分片转写 #N（X.XMB）`）。

## 三、不改的部分

- 分片大小（CHUNK_TARGET 40MB）、ASR prompt、下载链路、RSS 文字稿直抓路径、队列串行泵（`pumpTranscribeQueue` 一次一集的串行语义不变——并行只发生在单集内部）、取消链路（AbortSignal 透传并发任务）。
- 零 DB 迁移、零 IPC 变化、零 UI 变化。

## 四、验收

- typecheck 双配置通过；build 通过。
- 效果验收（冒烟）：中短篇小说类单集（≤45MB）转写全程 2-3 分钟内；llm_usage 新 `podcast:polish` 行 duration 降至 10~30s、completion 数百 token。
- 回归：转写完成态/排版失败回退原文/取消回 none/队列多集依次处理。

## 五、反馈修订（260926 当日）：m4a 误用 mp3 切片致分片转写 500

开发者反馈转写失败。取证：失败全为 9/24 拉取的小宇宙源（718-727，72-452MB，`.m4a`），错误 `ASR 服务返回 500：`（空体）；成功集全部 ≤45MB 直传。切片实验（真音频 69MB 三片对照）实锤：首片（含容器头）200 / **中段无头碎片 500**——分片逻辑假设 mp3（帧自含），m4a 中段切片是无效 MP4 容器碎片，服务端解码崩溃；文档 50MB/1h 上限经 DB 时长计算排除（首片均 29-57min）。

**修复**：新 `electron/services/audioChunk.ts` 统一入口 `sliceAudioForAsr(buf)`：
- **mp3**（ID3/帧同步检测）→ 原帧对齐切片（逻辑迁入，行为不变）；
- **mp4**（ftyp 检测）→ 解析 moov：esds 取 AudioSpecificConfig（freqIdx/chCfg）+ stsz/stsc/stco/co64 逐帧偏移表 → 每帧合成 7 字节 ADTS 头重封装为可任意切的 .aac 流，边重封装边按 40MiB 帧边界产出分片（每片均自含可解码内容）；
- 其他格式 → 整文件单片（交服务端判）。解析失败抛 `AUDIO_SEGMENT_PARSE_FAILED`（friendlyError 映射可读文案）。

`transcribeBuffer` 按片传 mime/ext（audio/aac/.aac）；直传守卫补时长条件（≤45MB **且已知时长 ≤55min**，防低码率长音频超单请求 1h 限制）。

**修订验收**：生产代码切 715 真音频 2 片（40+29MiB），第二片（此前必 500 的纯 ADTS 无头片）实测 **HTTP 200**、转出正确节目中段内容；mp3 源行为零变化。
