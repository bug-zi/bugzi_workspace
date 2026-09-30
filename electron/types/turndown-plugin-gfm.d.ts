// turndown-plugin-gfm 最小类型（@types 镜像缺包，npm 安装反复失败——260930 本地声明兜底；
// 仅用 gfm 聚合插件，API 面与 @types/turndown-plugin-gfm 同名导出一致）
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'
  export const gfm: TurndownService.Plugin
  export const tables: TurndownService.Plugin
  export const strikethrough: TurndownService.Plugin
}
