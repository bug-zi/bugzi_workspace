# 白噪音 designs-specs.md

> 本文档由 AI 基于 `docs/project/左侧边栏/白噪音/design.md`（260908 brainstorming 定稿并立项）生成，是开发的直接依据。设计全记录（六项决策与被否方案）见同目录 `2026-09-08-白噪音-design.md`。依赖：样式/designs-specs.md（ConfirmDialog / Toast / 弹窗与主题色系、Material Symbols 用法）。**纯渲染层实现：主进程零改动**——无新 IPC、无 DB 迁移（复用 settings 表与 `window.api.settings.get/set` 既有通道）、无新 npm 依赖、CSP 零改动、不新增 AiChannel。

## 0. 命名与常量

- **不新增 `ModuleId`**：白噪音页不是模块。`src/App.tsx` 本地定义 `type MainView = ModuleId | 'noise'`，`module` 状态与 `activateModule` 参数放宽为 `MainView`。
- `SettingsKeys`（src/shared/types.ts）增两键：`NoiseState: 'noise_state'`、`NoiseCustomMixes: 'noise_custom_mixes'`。
- 图标（Material Symbols，禁 emoji）：左栏控件 `graphic_eq`；场景「雨」`rainy`；主题按钮沿用 `dark_mode` / `light_mode`。
- 滑杆值域 0–100 整数；增益映射 `(v / 100) ** 2`（等响感知近似，滑杆低段不至于无声）。
- 主音量默认 60，层默认值见 §1.3。

## 1. 场景注册表（新建 `src/services/noiseScenes.ts`）

### 1.1 类型

```ts
export interface SteadyLayerDef {
  id: string; label: string; type: 'steady'
  noise: 'white' | 'pink' | 'brown'
  filter: { kind: 'lowpass' | 'bandpass' | 'highpass'; freq: number; q?: number }
  am?: { rateHz: number; depth: number }            // 幅度抖动（密雨）
  lfoFilter?: { rateHz: number; depthHz: number }   // 低通截止慢扫（风）
}
export interface EventLayerDef {
  id: string; label: string; type: 'event'
  minGapSec: number; maxGapSec: number
  spawn: 'thunder' | 'drip' | 'tap'                  // 引擎内三种事件合成器（§2.4）
}
export type NoiseLayerDef = SteadyLayerDef | EventLayerDef
export interface NoisePreset { id: string; label: string; layers: Record<string, number> }
export interface NoiseScene {
  id: string; label: string; icon: string
  layers: NoiseLayerDef[]
  defaults: Record<string, number>
  presets: NoisePreset[]
}
export const SCENES: NoiseScene[]   // 首版仅 rain；后续新场景 = 追加配置项
```

### 1.2 雨场景层定义（`id` 与结构定死；频点/间隔为调参基准，实施可微调）

| id | label | 定义 |
| --- | --- | --- |
| `thunder` | 远雷 | event：gap 20–60s，spawn `thunder` |
| `body_low` | 雨体·沉 | steady：brown + lowpass 120Hz |
| `body_hiss` | 雨体·沙沙 | steady：pink + bandpass 中心 600Hz（300–1k） |
| `patter` | 密雨 | steady：white + bandpass 中心 2kHz（1–3k）+ am { 1Hz, 0.15 } |
| `fine` | 细雨·高频 | steady：white + highpass 4kHz |
| `drips` | 屋檐滴水 | event：gap 0.2–2s，spawn `drip` |
| `window` | 雨打窗 | event：gap 1–6s，spawn `tap` |
| `wind` | 风 | steady：pink + lowpass 500Hz + lfoFilter { 0.08Hz, ±300Hz } |

### 1.3 defaults 与出厂预设（数值为调参基准，实施可微调；键名定死）

- `defaults`（中雨基准）：thunder 20 / body_low 40 / body_hiss 60 / patter 50 / fine 40 / drips 40 / window 20 / wind 30。
- 预设 5 个：

| 预设 | thunder | body_low | body_hiss | patter | fine | drips | window | wind |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 细雨 | 0 | 15 | 45 | 20 | 35 | 25 | 10 | 20 |
| 暴雨 | 10 | 70 | 75 | 85 | 55 | 15 | 30 | 40 |
| 屋檐夜雨 | 0 | 20 | 35 | 15 | 25 | 80 | 15 | 10 |
| 雷雨 | 70 | 65 | 70 | 75 | 45 | 10 | 25 | 55 |
| 微风细雨 | 0 | 10 | 40 | 15 | 40 | 15 | 5 | 65 |

## 2. 声音引擎（新建 `src/services/noiseEngine.ts`，模块级单例 `export const noiseEngine`）

### 2.1 结构

- `ctx: AudioContext | null`（懒创建，首次 `play()` 时 new；全局唯一）。
- 主链：各层 GainNode → `master` GainNode → `destination`。
- 当前场景层实例表：steady 层 = BufferSource(loop) → BiquadFilter（bandpass 用 frequency + Q）→ GainNode；am 用 LFO OscillatorNode → GainNode 接层 Gain.gain 的加法调制；lfoFilter 用 LFO → GainNode 接 filter.frequency。event 层 = 调度器（setTimeout 链持句柄）。
- 播放态 `playing: boolean` + 最小订阅机制 `subscribe(listener)` / `getSnapshot()`（React 侧 `useSyncExternalStore` 取播放态，左栏图标高亮与页面播放按钮共用）。

### 2.2 噪声缓冲

- `makeWhite / makePink / makeBrown`：约 4s 单声道 `AudioBuffer`，pink 用 Paul Kellet 近似滤波，brown 用漏积分白噪声；同色缓冲跨层复用一份，仅生成一次。

### 2.3 生命周期

- `play()`：幂等——已播放直接返回；懒建 ctx + 建层（若未建）→ `ctx.resume()` → 启动 event 调度器。
- `pause()`：`ctx.suspend()` + 清空全部调度器 timer（层节点保留，恢复不重建）。
- `toggle()` / `isPlaying()`。
- `setLayer(layerId, v)`：层 Gain `setTargetAtTime((v/100)**2, τ≈0.05)` 平滑无爆音；未建层时先记参数。
- `setMaster(v)`：同上映射。
- `setScene(sceneId)`：停源拆除当前层节点 → 按新场景 `defaults` 建层并应用；通知订阅者。
- `loadState(state)`：不播放，仅应用 sceneId/layers/master（启动恢复用）。
- `getState()`：`{ sceneId, layers, master, playing }`。

### 2.4 事件合成器（三种 spawn）

- `thunder`：brown 噪声源 → lowpass 100–200Hz → Gain 包络（attack 0.5–2s 随机、release 4–10s 随机），一次性节点用完弃。
- `drip`：正弦 Oscillator（800–2400Hz 随机音高）→ Gain 指数衰减（约 0.05–0.15s）+ 一个 5–20ms 高通白噪声瞬态叠加。
- `tap`：bandpass 中心 500–1500Hz 随机的白噪声短脉冲（20–80ms）快速衰减。
- 事件音量跟随该层滑杆值（同一映射），随机 gap 由层定义的 min/max 均匀取值。

## 3. 混音器页（新建 `src/modules/noise/NoisePage.tsx` + `noise.css`）

- 自上而下：
  1. **头部**：标题「白噪音」+ 播放/暂停大按钮（图标 `play_arrow` / `pause`，播放态主题色高亮，禁彩亮）。
  2. **场景条**：`SCENES` 渲染场景卡（图标 + 名称，首版仅「雨」一张），点击 `setScene`；当前场景主题色描边。
  3. **滑杆区**：当前场景各层竖向滑杆（mynoise 式一排，`input[type=range]` 竖向实现 + 层 label + 数值），onChange 即 `setLayer` 并防抖落库；右侧独立主音量滑杆（横向，图标 `volume_up`）。
  4. **预设区**：出厂预设 chips 一排，点击将配比逐层 `setLayer`（各层平滑过渡）并可继续微调。
  5. **自定义混音区**：「保存当前配比」按钮 + 当前场景归属的自定义条目 chips（名称 + 删除小按钮）；点击条目 = 召回配比；空态一句文案「还没有保存过混音」。
- **保存命名**：小弹窗（复用全局弹窗风格）+ 单输入框；名称 trim 非空否则 Toast 拒绝；**允许重名**（按 id 区分）。
- **删除条目**：`ConfirmDialog` 二次确认（全局规则），彻底删不入回收站。
- 页面卸载无清理负担（引擎在组件外）；每次挂载从 settings + 引擎 getState 对齐初始 UI。

## 4. 持久化（settings 两键，值均为 JSON 字符串）

- `noise_state`：`{ sceneId: string, layers: Record<string, number>, master: number }`。写入时机：滑杆/主音量变化防抖 500ms；场景切换、预设应用、召回自定义即刻写。
- `noise_custom_mixes`：`{ id: string, name: string, sceneId: string, layers: Record<string, number>, createdAt: string }[]`（**不含 master**）；id 用 `Date.now() + Math.random().toString(36).slice(2, 7)`。保存/删除后整组重写。
- **启动恢复**：App 挂载（或左栏控件首次挂载）时读 `noise_state` → `noiseEngine.loadState(...)`；**默认暂停**，仅恢复参数。

## 5. 外壳接线（`src/App.tsx` + `src/App.css`）

### 5.1 主栏视图

- `module` 状态类型放宽 `MainView = ModuleId | 'noise'`；`activateModule(id: MainView)`。
- MODULES 数组与 keep-alive 渲染区**零改动**；`'noise'` 时全部模块 div 自然进入 `module-hidden`。
- keep-alive 区之外、main-area 内条件渲染 `{module === 'noise' && <NoisePage />}`（不 keep-alive）。
- 激活/失活自定义事件携带 `'noise'` 时无模块认领（listener 均比对自身 id），无害；从真实模块进白噪音页，该模块正常收到失活事件（海龟汤计时等语义保持）。

### 5.2 左栏底部双区控件（替换现主题按钮位）

```tsx
<div className="nav-item noise-control">
  <button className={`noise-toggle${playing ? ' playing' : ''}`} onClick={() => noiseEngine.toggle()}
          title={playing ? '暂停白噪音' : '播放白噪音'}>
    <span className="material-symbols-outlined">graphic_eq</span>
  </button>
  <button className="noise-open" onClick={() => activateModule('noise')} title="打开白噪音混音器">白噪音</button>
</div>
```

- `playing` 经 `useSyncExternalStore(noiseEngine.subscribe, noiseEngine.getSnapshot)`。
- App.css：`.noise-control` 布局对齐既有 nav-item（图标 + 文字纵向外壳，内部左右双区）；`.playing` 图标主题色高亮；hover 用既有 `--color-primary-soft`。

### 5.3 主题按钮迁移右栏底部

- App.tsx：右栏（AiSidebar + 条件 DraftSidebar）外包一层 `<div className="right-col">`，其底部追加主题按钮：

```tsx
<div className="right-col">
  <AiSidebar ... />
  {rightPanel === 'draft' && <DraftSidebar ... />}
  <button className="right-col-theme" onClick={toggleTheme} title={...同现在...}>
    <span className="material-symbols-outlined">{theme === 'light' ? 'dark_mode' : 'light_mode'}</span>
  </button>
</div>
```

- 一份实现覆盖三态（收起细条 / debugzi 展开 / 草稿本展开），常驻窗口右下角。
- App.css：`.right-col { display: flex; flex-direction: column; }`，侧栏本体 `flex: 1`；`.right-col-theme` 样式对齐 `.ai-toggle`（透明底、图标、hover `--color-primary-soft`），容器加 `border-left` 与背景延续侧栏边缘，收起态宽度跟随细条。
- 左栏 nav 中原主题按钮删除（`App.tsx:149-152`）。

## 6. 边界与错误处理

- 引擎单例幂等：重复 `play()` 不重建节点不叠音；`pause` 后 `play` 复用既有层节点。
- settings 读到的 JSON 非法/缺键：try/catch 后回退场景 `defaults`、master 回退 60，不 Toast 打扰（静默容错）。
- AudioContext 创建/resume 异常：catch → Toast 提示「音频初始化失败」。
- 自定义混音按 `sceneId` 归属过滤展示；场景下无条目显示空态文案。
- 本功能无网络、无 AI、无外部文件依赖；不涉及回收站（条目删除为彻底删 + 二次确认）。

## 7. 明确不做（design.md 背书）

- 睡眠定时、重启自动续播、托盘控制、频谱可视化、音频素材方案（v2 备选）。
- 更多场景（海浪/篝火等，后续各为一份场景配置）。
- 自定义混音重命名（删除重存即可）；混音导出导入。
- 不新增 AI 边栏频道；CSP 零改动；无新依赖。

## 8. 验收清单

- [ ] 左栏底部：双区控件（图标播放/暂停、文字进页）；播放中图标高亮；主题按钮已迁右栏底部且三态常驻右下角、切换行为不变
- [ ] 任意模块下播放 → 切模块/开关右栏/进出混音器页，声音连续不断；左栏图标与页面播放按钮状态同步
- [ ] 8 根滑杆拖动实时生效、平滑无爆音；主音量独立生效；滑杆低段仍有可闻渐变（二次方映射）
- [ ] 5 个出厂预设一键切换配比；切换后微调生效
- [ ] 保存当前配比：命名弹窗非空校验；条目召回配比正确；删除走 ConfirmDialog 彻底删；重名允许
- [ ] 重启 App：场景/滑杆/主音量恢复，但处于暂停态，手动播放
- [ ] 暂停→播放恢复无需重建（快速来回切换无异常）；关闭 App 声音自然停止
- [ ] 双主题下控件/页面/弹窗外观一致，无彩亮色；`npm run typecheck` / `npm run build` 通过
- [ ] 听感验收：单层独奏可辨（尤其 drips/thunder/wind），全层 defaults 混听像自然雨声（调参基准值可在此环节微调，改的是 noiseScenes.ts 数值）
