// 繁→简统一转换（科普线呈现口径：解读产物与入库中文文本一律简体）。
// opencc-js 纯 JS 词典转换；简体输入幂等原样返回，无汉字/异常时兜底原样返回。
import * as OpenCC from 'opencc-js'

let cached: ((text: string) => string) | null = null

/** 繁→简；空串/无汉字/异常时原样返回 */
export function toSimplified(text: string): string {
  if (!text || !/[㐀-鿿豈-﫿]/.test(text)) return text
  try {
    cached ??= OpenCC.Converter({ from: 't', to: 'cn' })
    return cached(text)
  } catch {
    return text
  }
}

/** JSON 字符串数组列（tags 等）逐项繁→简；非数组/解析失败降级整串转换 */
export function simplifyJsonStrArray(raw: string): string {
  try {
    const p = JSON.parse(raw)
    if (Array.isArray(p)) {
      return JSON.stringify(p.map((x) => (typeof x === 'string' ? toSimplified(x) : x)))
    }
  } catch {
    /* 降级整串转换 */
  }
  return toSimplified(raw)
}
