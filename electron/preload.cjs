const { contextBridge, ipcRenderer } = require('electron')

// 预置主题：组件文字是白色，无宿主时默认浅色背景会白底白字。
// v1 深色实底 → v2 半透明玻璃底。种子版本升级时覆盖一次旧主题，
// 之后用户在 主题设置 tab 里的修改不会被覆盖。
try {
  const themeKeys = ['widget-theme/stock-desktop', 'widget-theme/gold-desktop']
  const versionKey = 'theme-seed-version'
  const SEED_VERSION = 2
  if (Number(window.localStorage.getItem(versionKey) || '0') < SEED_VERSION) {
    const theme = JSON.stringify({
      useGlobalTheme: false,
      borderRadius: 16,
      colors: {
        background: 'rgba(10, 12, 18, 0.35)',
        foreground: '#f3f4f6',
        primary: '#f82842',
        border: 'rgba(255, 255, 255, 0.14)',
      },
    })
    for (const key of themeKeys) {
      window.localStorage.setItem(key, theme)
    }
    window.localStorage.setItem(versionKey, String(SEED_VERSION))
  }
}
catch {
  /* noop */
}

// @widget-js/core 通过 window.parent.electronAPI.invoke(channel, method, ...args)
// 与宿主客户端通信；这里接管组件用到的桥接方法，其余返回 undefined（与无宿主时的行为一致）
contextBridge.exposeInMainWorld('electronAPI', {
  invoke: async (channel, ...rest) => {
    const signature = [channel, ...rest].filter((it) => typeof it === 'string').join(' ')
    if (signature.includes('openConfig')) {
      return ipcRenderer.invoke('shell:open-config')
    }
    if (signature.includes('openDevTools')) {
      return ipcRenderer.invoke('shell:open-devtools')
    }
    // 设置窗口自定义标题栏的红绿灯按钮（WindowApi.minimize/maximize/close/isMaximized）
    if (signature.includes('unmaximize')) {
      return ipcRenderer.invoke('shell:win', 'unmaximize')
    }
    if (signature.includes('isMaximized')) {
      return ipcRenderer.invoke('shell:win', 'isMaximized')
    }
    if (signature.includes('maximize')) {
      return ipcRenderer.invoke('shell:win', 'maximize')
    }
    if (signature.includes('minimize')) {
      return ipcRenderer.invoke('shell:win', 'minimize')
    }
    if (signature.includes('close')) {
      return ipcRenderer.invoke('shell:win', 'close')
    }
    return undefined
  },
})

// 供设置窗口读写“点击穿透”开关、代理设置，以及 SQLite 缓存读写
contextBridge.exposeInMainWorld('stockShell', {
  getClickThrough: () => ipcRenderer.invoke('shell:get-click-through'),
  setClickThrough: (value) => ipcRenderer.invoke('shell:set-click-through', value === true),
  setIgnoreMouseEvents: (hoverInteractive) => ipcRenderer.invoke('shell:set-ignore', hoverInteractive === true),
  startWindowDrag: () => ipcRenderer.invoke('shell:start-window-drag'),
  stopWindowDrag: () => ipcRenderer.invoke('shell:stop-window-drag'),
  cacheGet: (key, maxAgeMs) => ipcRenderer.invoke('shell:cache-get', key, maxAgeMs),
  cacheSet: (key, payload) => ipcRenderer.invoke('shell:cache-set', key, payload),
  getProxy: () => ipcRenderer.invoke('shell:get-proxy'),
  setProxy: proxy => ipcRenderer.invoke('shell:set-proxy', proxy),
})
