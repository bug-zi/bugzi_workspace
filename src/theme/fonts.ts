// 字体定义共享模块（字体选择轮 §1.1）：个人档 FONT_FAMILIES 自 ProfileModule 迁出共用，
// 阅读器 READER_FONTS 供书架字体浮层与 iframe @font-face 注入
import liyuUrl from '../renderer/assets/fonts/liyu-shoushu.ttf?url'
import hongleiUrl from '../renderer/assets/fonts/honglei-banshu.ttf?url'
import lxgwUrl from '../renderer/assets/fonts/lxgw-wenkai.ttf?url'
import xuanzongUrl from '../renderer/assets/fonts/xuanzongti.otf?url'
import youranUrl from '../renderer/assets/fonts/youran-xiaokai.ttf?url'
import type { CustomFontInfo } from '../shared/types'
import { customFontCssValue } from './customFonts'

export interface FontOption {
  label: string
  /** CSS font-family 串（含回落链） */
  value: string
}

/** 个人档全局字体（原 ProfileModule 私有，内容不变；对应 global.css @font-face，楷体为系统字体） */
export const FONT_FAMILIES: FontOption[] = [
  { label: '默认（系统）', value: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif" },
  { label: '漓雨手书', value: "'Liyu Shoushu', 'KaiTi', serif" },
  { label: '鸿雷板书简体', value: "'Honglei Banshu', sans-serif" },
  { label: '霞鹜文楷', value: "'LXGW WenKai', 'KaiTi', serif" },
  { label: '玄宗体', value: "'XuanZong Ti', serif" },
  { label: '演示悠然小楷', value: "'Youran Xiaokai', 'KaiTi', serif" },
  { label: '楷体', value: "'KaiTi', 'STKaiti', serif" }
]

export interface ReaderFont extends FontOption {
  /** @font-face family 名（打包项注入 iframe 用） */
  family: string
  /** 打包字体文件 URL（Vite ?url 资产；缺省 = 系统字体无需注入） */
  url?: string
}

/** 阅读器字体清单（字体选择轮 §1.1，系统 6 + 打包 5；「跟随全局」项由调用方动态拼、不在此列） */
export const READER_FONTS: ReaderFont[] = [
  { label: '系统默认（雅黑）', value: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif", family: 'system-ui' },
  { label: '微软雅黑', value: "'Microsoft YaHei', 'PingFang SC', sans-serif", family: 'Microsoft YaHei' },
  { label: '宋体', value: "'SimSun', 'STSong', serif", family: 'SimSun' },
  { label: '楷体', value: "'KaiTi', 'STKaiti', serif", family: 'KaiTi' },
  { label: '黑体', value: "'SimHei', 'STHeiti', sans-serif", family: 'SimHei' },
  { label: '仿宋', value: "'FangSong', 'STFangsong', serif", family: 'FangSong' },
  { label: '漓雨手书', value: "'Liyu Shoushu', 'KaiTi', serif", family: 'Liyu Shoushu', url: liyuUrl },
  { label: '鸿雷板书简体', value: "'Honglei Banshu', sans-serif", family: 'Honglei Banshu', url: hongleiUrl },
  { label: '霞鹜文楷', value: "'LXGW WenKai', 'KaiTi', serif", family: 'LXGW WenKai', url: lxgwUrl },
  { label: '玄宗体', value: "'XuanZong Ti', serif", family: 'XuanZong Ti', url: xuanzongUrl },
  { label: '演示悠然小楷', value: "'Youran Xiaokai', 'KaiTi', serif", family: 'Youran Xiaokai', url: youranUrl }
]

/** 打包字体（@font-face 注入 iframe 用；设计 §1.4，EpubReader 消费） */
export const BUNDLED_FONTS = READER_FONTS.filter((f): f is ReaderFont & { url: string } => f.url != null)

/** 合并导入字体后的个人档全局字体清单（导入字体追加在打包字体之后，优化建议区第46轮） */
export function withCustomGlobalFonts(customs: CustomFontInfo[]): FontOption[] {
  return [...FONT_FAMILIES, ...customs.map((c) => ({ label: c.label, value: customFontCssValue(c.family) }))]
}

/** 导入字体 → 阅读器字体条目（family/url 供 epub iframe @font-face 注入） */
export function customsToReaderFonts(customs: CustomFontInfo[]): ReaderFont[] {
  return customs.map((c) => ({
    label: c.label,
    value: customFontCssValue(c.family),
    family: c.family,
    url: c.url
  }))
}

/** 合并导入字体后的阅读器字体清单（系统 6 + 打包 5 + 导入 N） */
export function withCustomReaderFonts(customs: CustomFontInfo[]): ReaderFont[] {
  return [...READER_FONTS, ...customsToReaderFonts(customs)]
}
