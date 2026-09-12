// resources/app.png → build/icon.ico（electron-builder 打包用；app.png 变更后重跑 npm run icon）
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const png2icons = require('png2icons')

const input = readFileSync('resources/app.png')
const ico = png2icons.createICO(input, png2icons.BILINEAR, 0, true)
if (!ico) {
  console.error('ICO 生成失败：检查 resources/app.png 是否为有效 PNG')
  process.exit(1)
}
mkdirSync('build', { recursive: true })
writeFileSync('build/icon.ico', ico)
console.log('build/icon.ico 已生成,', ico.length, 'bytes')
