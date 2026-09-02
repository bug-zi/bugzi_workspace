// CDP 只读检测：在真实 app 渲染进程读取 --bg-image 计算样式 + fetch 探测 + img 加载
// 用法： node scripts/cdp-check.cjs [port]
const http = require('node:http')
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
  const ws = new (require('node:net').Socket)()
  // node 无内置 WebSocket（Node 22+ 有全局 WebSocket）——直接用全局
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

  const expr = `(async () => {
    const bgEl = document.querySelector('.app-bg')
    const computed = bgEl ? getComputedStyle(bgEl).backgroundImage : 'NO_APP_BG_EL'
    const body = document.body
    const html = document.documentElement
    const varVal = html.style.getPropertyValue('--bg-image')
    let fetchResult = 'n/a'
    try {
      const r = await fetch('bzres://bg/bg-light.png')
      fetchResult = 'status=' + r.status
    } catch (e) {
      fetchResult = 'FAIL ' + e.message
    }
    const imgOk = await new Promise((res) => {
      const img = new Image()
      img.onload = () => res('IMG_OK')
      img.onerror = () => res('IMG_FAIL')
      img.src = 'bzres://bg/bg-light.png'
    })
    return JSON.stringify({
      url: location.href,
      dataTheme: html.getAttribute('data-theme'),
      cssVar: varVal,
      computedBg: computed,
      fetchResult,
      imgOk,
      hasAppBgEl: !!bgEl
    }, null, 2)
  })()`

  const result = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  console.log(result.result.value)
  w.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
