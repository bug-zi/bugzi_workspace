// CDP 截图：从真实 app 渲染进程截取页面图像
const http = require('node:http')
const fs = require('node:fs')
const port = process.argv[2] || '9222'

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve(JSON.parse(data)))
      })
      .on('error', reject)
  })
}

async function main() {
  const pages = await getJson('/json/list')
  const page = pages.find((p) => p.type === 'page' && p.url.startsWith('http'))
  if (!page) throw new Error('no page target')
  const w = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      w.send(JSON.stringify({ id: mid, method, params }))
    })
  w.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  }
  await new Promise((r) => (w.onopen = r))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('D:\\Code\\myapp\\bugzi_workspace\\scripts\\app-page.png', Buffer.from(shot.data, 'base64'))
  console.log('saved scripts/app-page.png')
  w.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
