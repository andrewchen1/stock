const { app, BrowserWindow, Tray, Menu, ipcMain, screen, protocol, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const net = require('node:net')
const { DatabaseSync } = require('node:sqlite')

const SCHEME = 'app'
const HOST = 'stock'
const DIST = path.join(__dirname, '..', 'dist')
const WIDGET_WIDTH = 400
const WIDGET_HEIGHT = 480

process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err)
})

// 独立于官方“桌面组件”客户端运行，避免单实例锁互相干扰
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let widgetWin = null
let configWin = null
let tray = null
let quitting = false

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

const positionFile = () => path.join(app.getPath('userData'), 'widget-position.json')
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

function loadPosition() {
  try {
    return JSON.parse(fs.readFileSync(positionFile(), 'utf8'))
  }
  catch {
    return null
  }
}

function savePosition(bounds) {
  try {
    fs.writeFileSync(positionFile(), JSON.stringify({ x: bounds.x, y: bounds.y }))
  }
  catch {
    /* noop */
  }
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  }
  catch {
    return {}
  }
}

function saveSettings(patch) {
  try {
    const merged = { ...loadSettings(), ...patch }
    fs.writeFileSync(settingsFile(), JSON.stringify(merged))
    return merged
  }
  catch {
    return {}
  }
}

// 点击穿透：开启后鼠标点击会穿过组件，命中下层窗口/桌面
let clickThrough = false
// 记录 setIgnoreMouseEvents 最后应用的状态，避免重复调用
// （反复调用、尤其带 forward 的调用会破坏 -webkit-app-region 的窗口拖动）
let ignoreApplied = null

function setWidgetIgnoreMouseEvents(ignore, forward = false) {
  if (!widgetWin || widgetWin.isDestroyed()) return
  if (ignoreApplied === ignore) return
  widgetWin.setIgnoreMouseEvents(ignore, forward ? { forward: true } : undefined)
  ignoreApplied = ignore
}

function applyClickThrough() {
  if (widgetWin && !widgetWin.isDestroyed()) {
    // forward: 穿透时渲染进程仍能收到 mousemove，用于悬停在按钮上时暂停穿透
    setWidgetIgnoreMouseEvents(clickThrough, true)
  }
  tray?.setContextMenu(buildTrayMenu())
}

function setClickThrough(value) {
  clickThrough = value === true
  saveSettings({ clickThrough })
  applyClickThrough()
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
}

function registerAppProtocol() {
  protocol.handle(SCHEME, (request) => {
    try {
      const { pathname } = new URL(request.url)
      let rel = decodeURIComponent(pathname)
      if (rel === '/' || rel === '') {
        rel = '/index.html'
      }
      const filePath = path.join(DIST, rel)
      if (!filePath.startsWith(DIST)) {
        return new Response('forbidden', { status: 403 })
      }
      const body = fs.readFileSync(filePath)
      return new Response(body, {
        headers: { 'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream' },
      })
    }
    catch (err) {
      return new Response(`not found: ${err?.message ?? err}`, { status: 404 })
    }
  })
}

// 行情/搜索接口不返回 CORS 头，这里统一注入，渲染进程的 axios 才能读到响应
function bypassCors() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith('https://') || details.url.startsWith('http://')) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'access-control-allow-origin': ['*'],
        },
      })
    }
    else {
      callback({})
    }
  })
  // 新浪行情接口校验 Referer，渲染进程无法自行设置该受限头，这里统一改写
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://hq.sinajs.cn/*'] }, (details, callback) => {
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        Referer: 'https://finance.sina.com.cn',
      },
    })
  })
}

function attachDevToolsShortcut(win) {
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools()
    }
  })
}

function widgetUrl() {
  return `${SCHEME}://${HOST}/index.html#/widget/stock?id=stock-desktop`
}

function configUrl() {
  return `${SCHEME}://${HOST}/index.html#/widget/config/stock?transparent=false&frame=true&id=stock-desktop`
}

const APP_ICON_PATH = path.join(__dirname, '..', 'dist', 'icon.ico')

function createWidgetWindow() {
  const workArea = screen.getPrimaryDisplay().workArea
  const saved = loadPosition()
  const x = Number.isFinite(saved?.x) ? saved.x : workArea.x + workArea.width - WIDGET_WIDTH - 40
  const y = Number.isFinite(saved?.y) ? saved.y : workArea.y + 100

  widgetWin = new BrowserWindow({
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    minWidth: WIDGET_WIDTH,
    maxWidth: WIDGET_WIDTH,
    minHeight: 240,
    alwaysOnTop: true,
    skipTaskbar: true,
    icon: fs.existsSync(APP_ICON_PATH) ? APP_ICON_PATH : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  // 宽度固定不可调（高度可随自选行数调整）
  widgetWin.on('resize', () => {
    if (!widgetWin || widgetWin.isDestroyed()) return
    const [, height] = widgetWin.getSize()
    if (widgetWin.getMaximumSize()[0] === WIDGET_WIDTH && widgetWin.getMinimumSize()[0] === WIDGET_WIDTH) return
    widgetWin.setMinimumSize(WIDGET_WIDTH, 240)
    widgetWin.setMaximumSize(WIDGET_WIDTH, 20000)
    widgetWin.setSize(WIDGET_WIDTH, height)
  })
  widgetWin.setAlwaysOnTop(true, 'screen-saver')
  attachDevToolsShortcut(widgetWin)
  widgetWin.once('ready-to-show', () => widgetWin?.show())
  widgetWin.loadURL(widgetUrl())

  // 标题栏区域作为窗口拖动区，按钮保持可点击
  widgetWin.webContents.on('dom-ready', () => {
    widgetWin?.webContents.insertCSS(`
      .stock-widget-root > div:first-child { -webkit-app-region: drag; }
      .stock-widget-root > div:first-child button { -webkit-app-region: no-drag; }
    `)
  })

  let saveTimer = null
  widgetWin.on('moved', () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (widgetWin && !widgetWin.isDestroyed()) {
        savePosition(widgetWin.getBounds())
      }
    }, 400)
  })

  // 点关闭 = 隐藏到托盘，真正退出走托盘菜单
  widgetWin.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      widgetWin?.hide()
    }
  })
  widgetWin.on('closed', () => {
    widgetWin = null
  })

  applyClickThrough()
}

function openConfigWindow() {
  if (configWin && !configWin.isDestroyed()) {
    configWin.show()
    configWin.focus()
    return
  }
  configWin = new BrowserWindow({
    width: 860,
    height: 800,
    title: '股票设置',
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#f4f4f5',
    icon: fs.existsSync(APP_ICON_PATH) ? APP_ICON_PATH : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  attachDevToolsShortcut(configWin)
  configWin.loadURL(configUrl())
  // 页面自带标题栏（红绿灯按钮），把它设为拖动区，按钮保持可点击
  configWin.webContents.on('dom-ready', () => {
    configWin?.webContents.insertCSS(`
      main > section > div:first-child { -webkit-app-region: drag; }
      main > section > div:first-child button { -webkit-app-region: no-drag; }
    `)
  })
  configWin.on('closed', () => {
    configWin = null
  })
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: '显示 / 隐藏组件',
      click: () => {
        if (!widgetWin) {
          createWidgetWindow()
          return
        }
        if (widgetWin.isVisible()) {
          widgetWin.hide()
        }
        else {
          widgetWin.show()
        }
      },
    },
    { label: '设置', click: openConfigWindow },
    { type: 'separator' },
    {
      label: '点击穿透（点击穿过组件）',
      type: 'checkbox',
      checked: clickThrough,
      click: (menuItem) => setClickThrough(menuItem.checked),
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked })
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ])
}

function createTray() {
  let iconPath = path.join(DIST, 'icon.ico')
  if (!fs.existsSync(iconPath)) {
    iconPath = path.join(DIST, 'favicon.ico')
  }
  if (!fs.existsSync(iconPath)) {
    iconPath = path.join(DIST, 'logo.png')
  }
  try {
    tray = new Tray(iconPath)
  }
  catch {
    tray = new Tray(path.join(DIST, 'logo.png'))
  }
  tray.setToolTip('股票组件')
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', () => widgetWin?.show())
}

// 探测本机 fclash/clash 代理端口；存在则让应用走代理（Yahoo/东财部分接口直连会被墙或限流）
function detectLocalProxyPort(ports = [7890, 7891, 7897, 1080]) {
  return new Promise((resolve) => {
    const tryPort = (index) => {
      if (index >= ports.length) {
        resolve(null)
        return
      }
      const socket = net.connect({ host: '127.0.0.1', port: ports[index], timeout: 800 })
      socket.on('connect', () => {
        socket.destroy()
        resolve(ports[index])
      })
      socket.on('error', () => {
        socket.destroy()
        tryPort(index + 1)
      })
      socket.on('timeout', () => {
        socket.destroy()
        tryPort(index + 1)
      })
    }
    tryPort(0)
  })
}

// SQLite 持久化缓存：网络请求成功时写入，失败时按有效期兜底返回旧数据
let cacheDb = null

function initCacheDb() {
  try {
    cacheDb = new DatabaseSync(path.join(app.getPath('userData'), 'cache.db'))
    cacheDb.exec(`
      CREATE TABLE IF NOT EXISTS http_cache (
        cache_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      )
    `)
  }
  catch (err) {
    console.error('[cache] init failed:', err)
    cacheDb = null
  }
}

// 代理设置：auto=自动探测本机 clash，direct=直连，custom=自定义规则
// cibo.hk（港股打新数据）直连可达，走代理出口反而被拒，加入直连白名单
const PROXY_BYPASS = '<local>;cibo.hk'

function applyProxySettings() {
  const proxy = loadSettings().proxy || { mode: 'auto' }
  if (proxy.mode === 'direct') {
    return session.defaultSession.setProxy({ mode: 'direct' })
  }
  if (proxy.mode === 'custom' && proxy.rules) {
    return session.defaultSession.setProxy({ proxyRules: proxy.rules, proxyBypassRules: PROXY_BYPASS })
  }
  return detectLocalProxyPort().then((port) => {
    if (port) {
      return session.defaultSession.setProxy({
        proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`,
        proxyBypassRules: PROXY_BYPASS,
      })
    }
    return session.defaultSession.setProxy({ mode: 'direct' })
  })
}

function registerIpc() {
  ipcMain.handle('shell:open-config', () => {
    openConfigWindow()
  })
  ipcMain.handle('shell:open-devtools', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.openDevTools({ mode: 'detach' })
  })
  // 组件页面自定义标题栏的 红绿灯 按钮通过 electronAPI 调用这些窗口控制
  ipcMain.handle('shell:win', (event, cmd) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return undefined
    switch (cmd) {
      case 'minimize': return win.minimize()
      case 'maximize': return win.maximize()
      case 'unmaximize': return win.unmaximize()
      case 'close': return win.close()
      case 'isMaximized': return win.isMaximized()
      default: return undefined
    }
  })
  ipcMain.handle('shell:get-click-through', () => clickThrough)
  ipcMain.handle('shell:set-click-through', (_event, value) => {
    setClickThrough(value === true)
  })
  // 点击穿透模式下的智能放行：鼠标悬停在按钮等交互元素上时暂停穿透
  ipcMain.handle('shell:set-ignore', (_event, hoverInteractive) => {
    if (!clickThrough) {
      // 非穿透模式绝不重复调用（forward 调用会破坏 app-region 拖动）
      setWidgetIgnoreMouseEvents(false, false)
      return undefined
    }
    setWidgetIgnoreMouseEvents(!hoverInteractive, true)
    return undefined
  })
  // 拖动把手：按下后由主进程按光标位置移动窗口（16ms 轮询，跟手），松开即停
  let dragTimer = null
  ipcMain.handle('shell:start-window-drag', () => {
    const win = widgetWin
    if (!win || win.isDestroyed()) return undefined
    const cursor = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    const offsetX = cursor.x - bounds.x
    const offsetY = cursor.y - bounds.y
    clearInterval(dragTimer)
    dragTimer = setInterval(() => {
      if (!win || win.isDestroyed()) {
        clearInterval(dragTimer)
        return
      }
      const point = screen.getCursorScreenPoint()
      win.setPosition(point.x - offsetX, point.y - offsetY)
    }, 16)
    return undefined
  })
  ipcMain.handle('shell:stop-window-drag', () => {
    clearInterval(dragTimer)
    dragTimer = null
    return undefined
  })
  ipcMain.handle('shell:cache-get', (_event, key, maxAgeMs) => {
    if (!cacheDb) return null
    try {
      const row = cacheDb.prepare('SELECT payload, fetched_at FROM http_cache WHERE cache_key = ?').get(String(key))
      if (!row) return null
      const age = Date.now() - Number(row.fetched_at)
      if (Number.isFinite(maxAgeMs) && maxAgeMs > 0 && age > maxAgeMs) return null
      return { payload: row.payload, age }
    }
    catch {
      return null
    }
  })
  ipcMain.handle('shell:cache-set', (_event, key, payload) => {
    if (!cacheDb) return undefined
    try {
      cacheDb.prepare(
        'INSERT INTO http_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at'
      ).run(String(key), String(payload), Date.now())
      // 缓存范围控制：只保留 14 天内的记录
      cacheDb.prepare('DELETE FROM http_cache WHERE fetched_at < ?').run(Date.now() - 14 * 24 * 3600 * 1000)
    }
    catch {
      /* noop */
    }
    return undefined
  })
  ipcMain.handle('shell:get-proxy', () => loadSettings().proxy || { mode: 'auto' })
  ipcMain.handle('shell:set-proxy', (_event, proxy) => {
    const mode = proxy?.mode === 'direct' || proxy?.mode === 'custom' ? proxy.mode : 'auto'
    const rules = mode === 'custom' ? String(proxy?.rules ?? '') : ''
    saveSettings({ proxy: { mode, rules } })
    return applyProxySettings()
  })
}

app.on('second-instance', () => {
  widgetWin?.show()
})

app.whenReady().then(async () => {
  registerAppProtocol()
  bypassCors()
  registerIpc()
  initCacheDb()
  // 代理设置（持久化在 settings.json，默认 auto=自动探测本机 clash）
  await applyProxySettings()
  clickThrough = loadSettings().clickThrough === true
  createWidgetWindow()
  createTray()
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  // 托盘常驻，不随窗口关闭退出
})
