// 导入字体运行时注册（优化建议区第46轮）：清单缓存 + FontFace 注册。
// 个人档全局字体 / 书架阅读器字体浮层 / epub iframe 注入三处共用。
// FontFace 加载走 bzres://fonts/（CSP font-src 已放行）；全局字体设置只写 --font-family 变量，
// 注册完成即生效，与启动时序无耦合。
import type { CustomFontInfo } from '../shared/types'

let cache: CustomFontInfo[] | null = null
const registered = new Set<string>()

/** 导入/删除后调用，下次 getCustomFonts 重新拉清单 */
export function invalidateCustomFonts(): void {
  cache = null
}

/** 清单（模块级缓存优先；App 启动已预注册，多消费方免重复 IPC） */
export async function getCustomFonts(): Promise<CustomFontInfo[]> {
  if (!cache) cache = await window.api.fonts.list()
  return cache
}

/** 把清单注册进 document.fonts（按 family 幂等）；返回清单便于调用方连用 */
export async function registerCustomFontFaces(): Promise<CustomFontInfo[]> {
  const list = await getCustomFonts()
  for (const f of list) {
    if (registered.has(f.family)) continue
    registered.add(f.family)
    try {
      const face = new FontFace(f.family, `url("${f.url}")`, { weight: '100 900', display: 'swap' })
      document.fonts.add(await face.load())
    } catch {
      registered.delete(f.family) // 加载失败允许下次重试
    }
  }
  return list
}

/** 导入字体 CSS value（统一回落链，同打包字体模式：解析不到时回落楷体/衬线） */
export function customFontCssValue(family: string): string {
  return `'${family}', 'KaiTi', serif`
}
