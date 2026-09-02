// 独立复现脚本 v2：从 http://localhost 页面源 fetch bzres://，复刻 dev 环境（页面源 http://localhost:5173）
// 用法： npx electron scripts\test-bzres.cjs [--corsEnabled] [--acao]
//   --corsEnabled = privileges 加 corsEnabled:true；--acao = 响应带 Access-Control-Allow-Origin 头
const { app, protocol, BrowserWindow } = require('electron')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const http = require('node:http')

const WITH_CORSENABLED = process.argv.includes('--corsEnabled')
const WITH_ACAO = process.argv.includes('--acao')
const USER_DATA = join(process.env.APPDATA, 'bugzi_workspace')

const privileges = { standard: true, secure: true, supportFetchAPI: true, stream: true }
if (WITH_CORSENABLED) privileges.corsEnabled = true
protocol.registerSchemesAsPrivileged([{ scheme: 'bzres', privileges }])

app.whenReady().then(() => {
  protocol.handle('bzres', (request) => {
    const url = new URL(request.url)
    const pathPart = url.pathname.replace(/^\/+/, '')
    const parts = decodeURIComponent(url.hostname === 'bg' ? 'bg/' + pathPart : pathPart)
      .split('/')
      .filter((p) => p && p !== '.' && p !== '..')
    const abs = join(USER_DATA, ...parts)
    const headers = { 'Content-Type': 'image/png' }
    if (WITH_ACAO) headers['Access-Control-Allow-Origin'] = '*'
    try {
      const data = readFileSync(abs)
      return new Response(data, { headers })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })

  // 起一个 http 页面源，复刻 dev（http://localhost:5173）
  const PAGE =
    '<script>' +
    "fetch('bzres://bg/bg-light.png')" +
    ".then(r=>console.log('FETCH_OK status='+r.status))" +
    ".catch(e=>console.log('FETCH_FAIL '+e.message));" +
    "setTimeout(()=>{const img=new Image();img.onload=()=>console.log('IMG_OK');img.onerror=()=>console.log('IMG_FAIL');img.src='bzres://bg/bg-light.png';},300);" +
    "setTimeout(()=>console.log('DONE'),1200)" +
    '</script>'
  const server = http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(PAGE)
    })
    .listen(15173, '127.0.0.1', () => {
      const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
      win.webContents.on('console-message', (e) => {
        const msg = typeof e === 'string' ? e : (e.message ?? JSON.stringify(e))
        console.log('[renderer]', msg)
        if (String(msg).startsWith('DONE')) app.quit()
      })
      void win.loadURL('http://127.0.0.1:15173/')
    })
  setTimeout(() => app.quit(), 8000)
})
