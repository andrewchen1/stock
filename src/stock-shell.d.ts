declare global {
  interface StockShellProxy {
    mode: 'auto' | 'direct' | 'custom'
    rules?: string
  }

  interface Window {
    stockShell?: {
      getClickThrough?: () => Promise<boolean>
      setClickThrough?: (value: boolean) => Promise<void>
      setIgnoreMouseEvents?: (hoverInteractive: boolean) => Promise<void>
      startWindowDrag?: () => Promise<void>
      stopWindowDrag?: () => Promise<void>
      cacheGet?: (key: string, maxAgeMs?: number) => Promise<{ payload: string, age: number } | null>
      cacheSet?: (key: string, payload: unknown) => Promise<void>
      getProxy?: () => Promise<StockShellProxy>
      setProxy?: (proxy: StockShellProxy) => Promise<void>
    }
  }
}

export {}
