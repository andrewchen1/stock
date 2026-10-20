// SQLite 持久化缓存的渲染层封装：
// 网络成功 → 写入缓存；网络失败 → 按有效期（staleMs）兜底返回旧数据。
// 数据范围由调用方用 key 区分，有效期由各数据类型的策略决定。

const DAY_MS = 24 * 3600 * 1000

/** 缓存兜底的宽限期：≤5 分钟的旧数据静默使用，超过则通知界面提示“网络异常” */
export const FALLBACK_GRACE_MS = 5 * 60_000

export type CacheStatusEvent = { type: 'ok' } | { type: 'stale', key: string, ageMs: number }

const statusListeners = new Set<(event: CacheStatusEvent) => void>()

/** 订阅缓存兜底状态（用于界面显示“网络异常·数据延迟”） */
export function onCacheStatus(listener: (event: CacheStatusEvent) => void): () => void {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

function emitStatus(event: CacheStatusEvent): void {
  statusListeners.forEach(listener => listener(event))
}

export { emitStatus }

/** 各类数据的缓存有效期策略 */
export const CachePolicy = {
  /** 行情快照：新鲜 60 秒，兜底最多 7 天 */
  quote: { freshMs: 60_000, staleMs: 7 * DAY_MS },
  /** 分时曲线：新鲜 5 分钟，兜底最多 7 天 */
  minute: { freshMs: 5 * 60_000, staleMs: 7 * DAY_MS },
  /** 黄金（上金所，非交易时段也会停留）：兜底最多 30 天 */
  gold: { freshMs: 5_000, staleMs: 30 * DAY_MS },
  /** 跑马灯：新鲜 60 秒，兜底最多 1 天 */
  ticker: { freshMs: 60_000, staleMs: 1 * DAY_MS },
} as const

export async function dbCacheGet(key: string, maxAgeMs?: number): Promise<{ payload: string, age: number } | null> {
  try {
    return (await window.stockShell?.cacheGet?.(key, maxAgeMs)) ?? null
  }
  catch {
    return null
  }
}

export function dbCacheSet(key: string, payload: unknown): void {
  try {
    window.stockShell?.cacheSet?.(key, JSON.stringify(payload))
  }
  catch {
    /* noop */
  }
}

/**
 * 带持久化兜底的请求：fetcher 成功则回写缓存；失败时返回有效期内的旧数据。
 */
export async function withDbCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  policy: { freshMs: number, staleMs: number },
): Promise<T> {
  try {
    const result = await fetcher()
    if (result !== undefined) {
      dbCacheSet(key, result)
    }
    emitStatus({ type: 'ok' })
    return result
  }
  catch (error) {
    const hit = await dbCacheGet(key, policy.staleMs)
    if (hit) {
      // 宽限期内静默使用；超过 5 分钟通知界面提示网络异常
      if (hit.age > FALLBACK_GRACE_MS) {
        emitStatus({ type: 'stale', key, ageMs: hit.age })
      }
      try {
        return JSON.parse(hit.payload) as T
      }
      catch {
        // 缓存内容损坏，按无缓存处理
      }
    }
    throw error
  }
}
