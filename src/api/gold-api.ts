import axios from 'axios'
import { CachePolicy, withDbCache } from '@/api/http-cache'

const EAST_MONEY_QUOTE_URL = 'https://push2.eastmoney.com/api/qt/stock/get'
const EAST_MONEY_TRENDS_URL = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get'
const EAST_MONEY_HEADERS = {
  'x-custom-referer': 'push2.eastmoney.com',
} as const
const CACHE_TTL = 5000

const quotationCache = new Map<string, { data: GoldApiResponse; fetchedAt: number }>()
const pendingRequests = new Map<string, Promise<GoldApiResponse>>()

const INSTRUMENT_CODES: Record<string, string> = {
  'Au99.99': 'AU9999',
  'Au99.95': 'AU9995',
  Au100g: 'AU100G',
  'Au(T+D)': 'AUTD',
  'mAu(T+D)': 'MAUTD',
}

// 新浪上金所行情代码（SGE_*）
const SINA_INSTRUMENT_CODES: Record<string, string> = {
  'Au99.99': 'SGE_AU9999',
  'Au99.95': 'SGE_AU9995',
  Au100g: 'SGE_AU100G',
  'Au(T+D)': 'SGE_AUTD',
  'mAu(T+D)': 'SGE_MAUTD',
}

interface EastMoneyQuote {
  f43: number
  f44: number
  f45: number
  f46: number
  f57: string
  f58: string
  f60: number
  f86: number
}

interface EastMoneyResponse<T> {
  rc: number
  data: T | null
}

interface EastMoneyTrends {
  trends: string[]
}

function toPrice(value: number): number {
  return value / 100
}

function getSecurityId(instrumentId: string): string {
  const code = INSTRUMENT_CODES[instrumentId]
  if (!code) {
    throw new Error(`Unsupported gold instrument: ${instrumentId}`)
  }
  return `118.${code}`
}

export class GoldApi {
  static async quotations(instrumentId: string = 'Au99.99'): Promise<GoldApiResponse> {
    const cached = quotationCache.get(instrumentId)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      return cached.data
    }

    const pending = pendingRequests.get(instrumentId)
    if (pending) return pending

    const requestedAt = Date.now()
    const request = this.fetchQuotations(instrumentId)
      .then((data) => {
        quotationCache.set(instrumentId, { data, fetchedAt: requestedAt })
        return data
      })
      .finally(() => {
        pendingRequests.delete(instrumentId)
      })

    pendingRequests.set(instrumentId, request)
    return request
  }

  private static async fetchQuotations(instrumentId: string): Promise<GoldApiResponse> {
    try {
      return await withDbCache(`gold:em:${instrumentId}`, () => this.fetchQuotationsFromEastMoney(instrumentId), CachePolicy.gold)
    }
    catch (error) {
      // 东方财富接口不可用时，回退到新浪的上金所行情
      const fallback = await withDbCache(`gold:sina:${instrumentId}`, () => this.fetchQuotationsFromSina(instrumentId), CachePolicy.gold)
      if (fallback) return fallback
      throw error
    }
  }

  private static async fetchQuotationsFromSina(instrumentId: string): Promise<GoldApiResponse | undefined> {
    const sinaCode = SINA_INSTRUMENT_CODES[instrumentId]
    if (!sinaCode) return undefined
    try {
      const response = await axios.get(`https://hq.sinajs.cn/list=${sinaCode}`, {
        responseType: 'arraybuffer',
        headers: { Referer: 'https://finance.sina.com.cn' },
        timeout: 10000,
      })
      const text = new TextDecoder('gbk').decode(response.data)
      const m = text.match(/="(.*)"/)
      if (!m) return undefined
      const f = m[1].split(',')
      const latestPrice = Number.parseFloat(f[3])
      const yesterdayClose = Number.parseFloat(f[5])
      const max = Number.parseFloat(f[6])
      const min = Number.parseFloat(f[8])
      if (!Number.isFinite(latestPrice) || latestPrice <= 0) return undefined
      return {
        times: [],
        data: [],
        min: Number.isFinite(min) ? min : latestPrice,
        max: Number.isFinite(max) ? max : latestPrice,
        heyue: instrumentId,
        delaystr: String(f[16] ?? ''),
        latestPrice,
        yesterdayClose: Number.isFinite(yesterdayClose) && yesterdayClose > 0 ? yesterdayClose : latestPrice,
      }
    }
    catch {
      return undefined
    }
  }

  private static async fetchQuotationsFromEastMoney(instrumentId: string): Promise<GoldApiResponse> {
    const secid = getSecurityId(instrumentId)
    const quoteResponse = await axios.get<EastMoneyResponse<EastMoneyQuote>>(
      EAST_MONEY_QUOTE_URL,
      {
        headers: EAST_MONEY_HEADERS,
        params: {
          secid,
          fields: 'f43,f44,f45,f46,f57,f58,f60,f86',
        },
        timeout: 10000,
      }
    )

    const quote = quoteResponse.data.data
    if (quoteResponse.data.rc !== 0 || !quote) {
      throw new Error('Gold quote data is unavailable')
    }

    let trends: string[] = []
    try {
      const trendsResponse = await axios.get<EastMoneyResponse<EastMoneyTrends>>(
        EAST_MONEY_TRENDS_URL,
        {
          headers: EAST_MONEY_HEADERS,
          params: {
            secid,
            fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
            fields2: 'f51,f52,f53,f54,f55,f56,f57,f58',
            ndays: 1,
            iscr: 0,
          },
          timeout: 10000,
        }
      )
      if (trendsResponse.data.rc === 0) {
        trends = trendsResponse.data.data?.trends ?? []
      }
    } catch (error) {
      console.warn('Gold intraday trends are unavailable', error)
    }

    const points = trends
      .map((item) => item.split(','))
      .filter((item) => item.length >= 3 && Number.isFinite(Number(item[2])))
    const times = points.map((item) => item[0].slice(11, 16))
    const data = points.map((item) => Number(item[2]).toFixed(2))
    const latestTime = points.at(-1)?.[0] ?? new Date(quote.f86 * 1000).toLocaleString('sv-SE')

    return {
      times,
      data,
      min: toPrice(quote.f45),
      max: toPrice(quote.f44),
      heyue: instrumentId,
      delaystr: latestTime,
      latestPrice: toPrice(quote.f43),
      yesterdayClose: toPrice(quote.f60),
    }
  }
}

export interface GoldApiResponse {
  times: string[]
  data: string[]
  min: number
  max: number
  heyue: string
  delaystr: string
  latestPrice: number
  yesterdayClose: number
}
