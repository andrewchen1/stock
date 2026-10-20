import { create } from 'zustand'

// 网络状态：数据全部来自实时接口时为正常；
// 出现“超过宽限期仍只能用缓存”的情况时标记异常，用于界面提示。
interface NetworkStatusState {
  lastOkAt: number | null
  lastFailAt: number | null
  markOk: () => void
  markFail: () => void
}

export const useNetworkStatusStore = create<NetworkStatusState>(set => ({
  lastOkAt: null,
  lastFailAt: null,
  markOk: () => set({ lastOkAt: Date.now() }),
  markFail: () => set({ lastFailAt: Date.now() }),
}))
