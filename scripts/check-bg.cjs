// 临时验证脚本：检查 userData bg 目录与 settings（只读）
const { DatabaseSync } = require('node:sqlite')
const { join } = require('node:path')
const fs = require('node:fs')

const ud = join(process.env.APPDATA, 'bugzi_workspace')
console.log('--- bg dir ---')
for (const f of fs.readdirSync(join(ud, 'bg'))) {
  const st = fs.statSync(join(ud, 'bg', f))
  console.log(f, st.size)
}
console.log('--- settings ---')
const d = new DatabaseSync(join(ud, 'bugzi.db'), { readOnly: true })
const rows = d.prepare("SELECT key, value FROM settings WHERE key LIKE 'bg_%' OR key = 'user_avatar'").all()
for (const r of rows) console.log(r.key, '=', r.value)
console.log('user_version =', d.prepare('PRAGMA user_version').get().user_version)
d.close()
