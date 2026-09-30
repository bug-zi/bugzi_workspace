// 办公台转换冒烟（specs §10.2）：xlsx/csv 读写、pptx 大纲⇄生成、md→docx→md 回读。
// officeConvert 为纯函数（不依赖 electron），esbuild 打包后 node 直跑。零依赖断言。
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tmp = mkdtempSync(join(tmpdir(), 'office-smoke-'))
const outfile = join(tmp, 'convert.mjs')
await build({
  entryPoints: [new URL('../electron/services/officeConvert.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  banner: {
    // mammoth 等 CJS 依赖的动态 require 在 ESM 产物里需接回 createRequire
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
  }
})
const C = await import(pathToFileURL(outfile).href)

let pass = 0
const ok = (cond, name) => {
  if (!cond) throw new Error(`FAIL: ${name}`)
  pass += 1
  console.log(`  ok ${name}`)
}

// —— xlsx/csv 读写 ——
const sheets = [{ name: '表一', rows: [['名', '值'], ['a', '1']] }]
C.writeWorkbook(sheets, join(tmp, 't.xlsx'), 'xlsx')
const back = C.readWorkbook(readFileSync(join(tmp, 't.xlsx')))
ok(back[0].name === '表一' && back[0].rows[1][0] === 'a', 'xlsx 读改写往返')
C.writeWorkbook(sheets, join(tmp, 't.csv'), 'csv')
ok(readFileSync(join(tmp, 't.csv'), 'utf8').includes('名'), 'csv 落盘')

// —— pptx 大纲 → pptx → 大纲（往返） ——
const outline = '## 封面\n- 要点一\n- 要点二\n\n## 第二章\n- 甲\n'
await C.outlineToPptx(outline, join(tmp, 't.pptx'))
const outline2 = await C.pptxToOutline(readFileSync(join(tmp, 't.pptx')))
ok(outline2.includes('## 封面') && outline2.includes('要点一') && outline2.includes('第二章'), 'pptx 大纲往返')

// —— md → docx → md（回读验证标题/表格文本） ——
const md = '# 标题甲\n\n正文段落，含**加粗**。\n\n| 列A | 列B |\n|---|---|\n| 1 | 2 |\n'
await C.mdToDocx(md, join(tmp, 'office'), join(tmp, 't.docx'))
ok(readFileSync(join(tmp, 't.docx')).length > 1000, 'docx 生成非空')
const backMd = await C.docxToMd(readFileSync(join(tmp, 't.docx')), join(tmp, 'office-img'), 'bzres://office/0')
ok(backMd.includes('标题甲') && backMd.includes('列A') && backMd.includes('加粗'), 'docx→md 回读含标题/表格/粗体')

console.log(`\noffice-convert smoke: ${pass} assertions passed`)
