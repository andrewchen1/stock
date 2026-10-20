// / <reference types="vite/client" />

interface Window {
  stockShell?: {
    getClickThrough?: () => Promise<boolean>
    setClickThrough?: (value: boolean) => Promise<void>
  }
}
