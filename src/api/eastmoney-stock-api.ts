import type { OpenDataResult } from '@/api/opendata'
import type { Stock } from '@/model/stock'
import { Quotation } from '@/model/quotation'
import { GoldApi } from '@/api/gold-api'
import { CachePolicy, dbCacheGet, dbCacheSet, emitStatus, FALLBACK_GRACE_MS, withDbCache } from '@/api/http-cache'
import axios, { type AxiosRequestConfig } from 'axios'

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { expireAt: number; value: any }>()

function cacheKey(url: string, params?: Record<string, any>): string {
  if (!params || Object.keys(params).length === 0) return url
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${JSON.stringify(params[k])}`)
  return `${url}?${sorted.join('&')}`
}

function cachePolicyForUrl(url: string): { freshMs: number, staleMs: number } {
  if (url.includes('trends2/get')) {
    return CachePolicy.minute
  }
  if (url.includes('/sug?') || url.includes('suggest/get')) {
    return { freshMs: 5 * 60_000, staleMs: 1 * 24 * 3600 * 1000 }
  }
  return CachePolicy.quote
}

async function cachedGet<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const key = cacheKey(url, config?.params as Record<string, any> | undefined)
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && hit.expireAt > now) {
    return hit.value as T
  }
  const policy = cachePolicyForUrl(url)
  try {
    const response = await axios.get(url, config)
    cache.set(key, { expireAt: now + CACHE_TTL_MS, value: response.data })
    dbCacheSet(key, response.data)
    emitStatus({ type: 'ok' })
    return response.data as T
  }
  catch (error) {
    // 网络失败（限流/断网/代理不可用）时，返回有效期内的 SQLite 旧数据兜底
    const dbHit = await dbCacheGet(key, policy.staleMs)
    if (dbHit) {
      if (dbHit.age > FALLBACK_GRACE_MS) {
        emitStatus({ type: 'stale', key, ageMs: dbHit.age })
      }
      return JSON.parse(dbHit.payload) as T
    }
    throw error
  }
}

function baiduExchangeToEmSecid(code: string, exchange?: string): string {
  if (exchange) {
    const ex = exchange.toUpperCase()
    if (ex === 'SH') return `1.${code}`
    if (ex === 'SZ') return `0.${code}`
    if (ex === 'BJ') return `0.${code}`
    if (ex === 'HK') return `116.${code}`
    if (ex === 'US' || ex === 'NASDAQ' || ex === 'NSD' || ex === 'NYSE') return `105.${code}`
  }
  if (/^\d{6}$/.test(code)) {
    return code.startsWith('6') || code.startsWith('9') ? `1.${code}` : `0.${code}`
  }
  if (/^\d{5}$/.test(code)) {
    return `116.${code}`
  }
  return `105.${code}`
}

function emMarketToBaiduExchange(mk: number, type?: string, code?: string): string {
  if (type === 'index') {
    if (mk === 1) return 'SH'
    if (mk === 0) return 'SZ'
    if (mk === 116) return 'HK'
    return 'US'
  }
  if (mk === 1) return 'SH'
  if (mk === 0) return 'SZ'
  if (mk === 116) return 'HK'
  if (mk === 105 || mk === 106 || mk === 107) {
    const u = code?.toUpperCase?.() || ''
    if (u === '.DJI' || u === '.IXIC' || u === '.INX') return 'US'
    return 'NASDAQ'
  }
  // 153 = 美股粉单市场（OTC，如滴滴 ADR DIDIY）
  if (mk === 153) return 'US'
  return 'SH'
}

function emMarketToBaiduMarket(mk: number): string {
  if (mk === 1 || mk === 0) return 'cn'
  if (mk === 116) return 'hk'
  return 'us'
}

function emStatusToBaiduInfo(tr: string): 'TRADE' | 'ENDTR' | 'STOPT' {
  if (tr === '1') return 'TRADE'
  if (tr === '2') return 'ENDTR'
  return 'STOPT'
}

function sign(x: number): '1' | '-1' | '0' {
  if (x > 0) return '1'
  if (x < 0) return '-1'
  return '0'
}

// 上海黄金交易所合约：以 GOLD: 为前缀并入股票自选列表，报价走 GoldApi（EM 上金所 + 新浪回退）
export const GOLD_INSTRUMENTS: Record<string, string> = {
  'GOLD:Au99.99': '黄金 Au99.99',
  'GOLD:mAu(T+D)': '黄金 mAu(T+D)',
  'GOLD:Au(T+D)': '黄金 Au(T+D)',
}

export function isGoldCode(code: string): boolean {
  return code.startsWith('GOLD:')
}

export function goldSearchOptions(query: string): Stock[] {
  const q = query.trim()
  if (!q) return []
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const nq = norm(q)
  return Object.entries(GOLD_INSTRUMENTS)
    .filter(([code, name]) => {
      if (q.includes('黄金') || name.includes(q)) return true
      return nq.length > 0 && (norm(code).includes(nq) || norm(name).includes(nq))
    })
    .map(([code, name]) => ({
      code,
      type: 'stock' as const,
      market: 'gold',
      follow_status: '0',
      amount: '0',
      exchange: 'SGE',
      name,
      price: '--',
      increase: '0',
      ratio: '0',
      amplitudeRatio: '0',
      turnoverRatio: '0',
      holdingAmount: '0',
      volume: '0',
      capitalization: '0',
      peRate: '0',
      pbRate: '0',
      status: '0',
      stockStatus: '6',
      stockStatusInfo: 'STOPT' as const,
      src_loc: '',
      subType: '',
      sf_url: '',
      pv: '0',
      CNYPrice: '--',
    }))
}

// 东方财富 push2 接口偶尔限流/不可达，用腾讯行情做回退，保证价格能刷出来
function tencentPrefixFor(code: string): string | null {
  if (/^\d{6}$/.test(code)) {
    return /^[569]/.test(code) ? 'sh' : 'sz'
  }
  if (/^\d{5}$/.test(code)) {
    return 'hk'
  }
  // 美股/粉单（字母代码，如 AAPL、DIDIY）
  if (/^[A-Za-z]/.test(code)) {
    return 'us'
  }
  return null
}

async function getTencentQuoteStock(code: string, type?: StockType): Promise<Stock | undefined> {
  const prefix = tencentPrefixFor(code)
  if (!prefix) return undefined
  try {
    const response = await axios.get(`https://qt.gtimg.cn/q=${prefix}${code}`, { responseType: 'arraybuffer' })
    const text = new TextDecoder('gbk').decode(response.data)
    const m = text.match(/="(.*)"/)
    if (!m) return undefined
    const f = m[1].split('~')
    const price = Number.parseFloat(f[3])
    if (!Number.isFinite(price) || price <= 0) return undefined
    const prevClose = Number.parseFloat(f[4])
    const high = Number.parseFloat(f[33])
    const low = Number.parseFloat(f[34])
    const increase = Number.isFinite(Number.parseFloat(f[31])) ? Number.parseFloat(f[31]) : price - (Number.isFinite(prevClose) ? prevClose : price)
    const ratioPct = Number.isFinite(Number.parseFloat(f[32])) ? Number.parseFloat(f[32]) : (Number.isFinite(prevClose) && prevClose > 0 ? (increase / prevClose) * 100 : 0)
    const amplitude = Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(prevClose) && prevClose > 0
      ? ((high - low) / prevClose) * 100
      : 0
    const ex = prefix.toUpperCase()
    return {
      code,
      type: type ?? 'stock',
      market: ex === 'HK' ? 'hk' : (ex === 'US' ? 'us' : 'cn'),
      follow_status: '0',
      amount: f[37] ?? '0',
      exchange: ex,
      name: f[1] ?? code,
      price: price.toFixed(2),
      high: Number.isFinite(high) ? high.toFixed(2) : price.toFixed(2),
      low: Number.isFinite(low) ? low.toFixed(2) : price.toFixed(2),
      increase: increase.toFixed(2),
      ratio: `${ratioPct.toFixed(2)}%`,
      amplitudeRatio: amplitude.toFixed(2),
      turnoverRatio: f[38] ?? '0',
      holdingAmount: '0',
      volume: f[36] ?? '0',
      capitalization: '0',
      peRate: f[39] ?? '0',
      pbRate: '0',
      status: sign(increase),
      stockStatus: '6',
      stockStatusInfo: 'ENDTR',
      src_loc: '',
      subType: '',
      sf_url: '',
      pv: '0',
      CNYPrice: price.toFixed(2),
    }
  }
  catch {
    return undefined
  }
}

interface EmQuoteKlt1Item {
  f57: string
  f58: string
  f43: number
  f44: number
  f45: number
  f46: number
  f47: number
  f48: number
  f50: string
  f51: string
  f52: number
  f60: number
  f116: number
  f117: number
  f162: number
  f167: number
  f168: number
  f169: number
  f170: number
  f171: number
  f177: number
  f178: string
}

function emQuoteToStock(q: EmQuoteKlt1Item, mk: number): Stock {
  const price = q.f43 / Math.pow(10, q.f52 - 0)
  const preClose = q.f60 / Math.pow(10, q.f52 - 0)
  const increase = price - preClose
  const ratio = preClose === 0 ? 0 : ((increase / preClose) * 100)
  return {
    code: q.f57,
    type: 'stock',
    market: emMarketToBaiduMarket(mk),
    follow_status: '0',
    amount: String(q.f48 / 10000),
    exchange: emMarketToBaiduExchange(mk, 'stock', q.f57),
    name: q.f58,
    price: price.toFixed(q.f52),
    high: q.f44 ? (q.f44 / Math.pow(10, q.f52 - 0)).toFixed(q.f52) : price.toFixed(q.f52),
    low: q.f45 ? (q.f45 / Math.pow(10, q.f52 - 0)).toFixed(q.f52) : price.toFixed(q.f52),
    increase: increase.toFixed(q.f52),
    ratio: `${ratio.toFixed(2)}%`,
    amplitudeRatio: q.f170 ? String(q.f170 / 100) : '0',
    turnoverRatio: q.f168 ? String(q.f168 / 100) : '0',
    holdingAmount: '0',
    volume: String(q.f47 / 100),
    capitalization: q.f116 ? String(q.f116 / 100000000) : '0',
    peRate: q.f167 ? String(q.f167 / 100) : '0',
    pbRate: q.f167 ? String(q.f167 / 100) : (q.f117 && q.f116 ? (q.f117 / q.f116 * 100 / 100).toFixed(2) : '0'),
    status: sign(increase),
    stockStatus: q.f178 === '1' ? '2' : '6',
    stockStatusInfo: emStatusToBaiduInfo(q.f178),
    src_loc: String(mk),
    subType: '',
    sf_url: '',
    pv: '0',
    CNYPrice: price.toFixed(q.f52),
  }
}

export class EastMoneyStockApi {
  static async getStock(code: string): Promise<Stock | undefined> {
    return this.getByType(code, 'stock')
  }

  static async getFund(code: string): Promise<Stock | undefined> {
    return this.getByType(code, 'fund')
  }

  private static async getGoldStock(code: string, type?: StockType): Promise<Stock | undefined> {
    const instrumentId = code.slice(5)
    try {
      const g = await GoldApi.quotations(instrumentId)
      const change = g.latestPrice - g.yesterdayClose
      const ratioPct = g.yesterdayClose > 0 ? (change / g.yesterdayClose) * 100 : 0
      const stock: Stock = {
        code,
        type: type ?? 'stock',
        market: 'gold',
        follow_status: '0',
        amount: '0',
        exchange: 'SGE',
        name: GOLD_INSTRUMENTS[code] ?? `黄金 ${instrumentId}`,
        price: g.latestPrice.toFixed(2),
        high: g.max > 0 ? g.max.toFixed(2) : g.latestPrice.toFixed(2),
        low: g.min > 0 ? g.min.toFixed(2) : g.latestPrice.toFixed(2),
        increase: change.toFixed(2),
        ratio: `${ratioPct.toFixed(2)}%`,
        amplitudeRatio:
          g.yesterdayClose > 0 && g.max > 0 && g.min > 0
            ? (((g.max - g.min) / g.yesterdayClose) * 100).toFixed(2)
            : '0',
        turnoverRatio: '0',
        holdingAmount: '0',
        volume: '0',
        capitalization: '0',
        peRate: '0',
        pbRate: '0',
        status: sign(change),
        stockStatus: '6',
        stockStatusInfo: 'ENDTR',
        src_loc: '',
        subType: '',
        sf_url: '',
        pv: '0',
        CNYPrice: g.latestPrice.toFixed(2),
      }
      if (type && stock.type !== type) return undefined
      return stock
    }
    catch {
      return undefined
    }
  }

  static async getByType<T>(code: string, type?: StockType): Promise<T | undefined> {
    if (isGoldCode(code)) {
      return (await this.getGoldStock(code, type)) as unknown as T
    }
    const secid = baiduExchangeToEmSecid(code)
    try {
      const data = await cachedGet<string>(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170,f171,f177,f178&ut=fa5fd1943c7b386f172d6893dbfba10b&invt=2&fltt=2`
      )
      let parsed = data as unknown as { data: EmQuoteKlt1Item | null }
      // 美股粉单市场（OTC）的 secid 是 153.，默认的 105. 查不到时补查一次
      if (!parsed?.data && secid.startsWith('105.')) {
        const otcData = await cachedGet<string>(
          `https://push2.eastmoney.com/api/qt/stock/get?secid=153.${code}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170,f171,f177,f178&ut=fa5fd1943c7b386f172d6893dbfba10b&invt=2&fltt=2`
        )
        parsed = otcData as unknown as { data: EmQuoteKlt1Item | null }
        if (parsed?.data) {
          const stock = emQuoteToStock(parsed.data, 153)
          if (type && stock.type !== type) return undefined
          stock.code = code
          return stock as unknown as T
        }
      }
      // 未上市代码（如招股中的新股）EM 返回占位数据（价格 0），视为无行情，保留发售价
      if (!parsed?.data || !Number.isFinite(Number(parsed.data.f43)) || Number(parsed.data.f43) <= 0) {
        return (await getTencentQuoteStock(code, type)) as unknown as T
      }
      const mk = Number.parseInt(secid.split('.')[0], 10)
      const stock = emQuoteToStock(parsed.data, mk)
      if (type && stock.type !== type) return undefined
      stock.code = code
      return stock as unknown as T
    }
    catch {
      return (await getTencentQuoteStock(code, type)) as unknown as T
    }
  }

  static async getIndex(code: string): Promise<Stock | undefined> {
    const result = await this.selfSelect(code, true)
    if (result && result.length > 0) {
      return result.find((s: Stock) => s.type === 'index') ?? result[0]
    }
    return undefined
  }

  static async getRawMinuteTrends(code: string): Promise<EmMinuteRaw | undefined> {
    const secid = baiduExchangeToEmSecid(code)
    try {
      const raw = await cachedGet<string>(
        `https://push2his.eastmoney.com/api/qt/stock/trends2/get?fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13,f14,f15,f16,f17,f18,f19,f20,f21,f22,f23,f24,f25,f26,f27,f28,f29,f30,f31,f32,f33,f34,f35,f36,f37,f38,f39,f40,f41,f42,f43,f44,f45,f46,f47,f48,f49,f50&fields2=f51,f52,f53,f54,f55,f56,f57,f58&secid=${secid}&klt=1&ndays=1&iscr=0&ut=fa5fd1943c7b386f172d6893dbfba10b`
      )
      const json = raw as any
      if (!json?.data) return undefined
      return json.data as EmMinuteRaw
    } catch {
      return undefined
    }
  }

  static async selfSelect(query: string, queryDetail = false): Promise<Stock[]> {
    if (!query || query.length < 1) return []
    try {
      const raw = await cachedGet<EmSearchSuggestResponse>(
        `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(query)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=20`
      )
      const table = raw.QuotationCodeTable
      if (!table || table.Status !== 0) return []
      const arr: EmSearchSuggestDataItem[] = table.Data ?? []
      if (arr.length === 0) return []

      const baseArr: Stock[] = arr.slice(0, 20).map((item) => {
        const mkStr = item.MktNum ?? (item.QuoteID ? String(item.QuoteID).split('.')[0] : '1')
        const mk = Number.parseInt(String(mkStr), 10)
        const st = item.SecurityTypeName ?? ''
        const classify = item.Classify ?? ''
        let type: 'index' | 'fund' | 'stock' | 'block' = 'stock'
        if (st.includes('指数') || classify === 'Index') type = 'index'
        else if (st.includes('基金') || classify === 'Fund') type = 'fund'
        else if (st.includes('板块') || classify === 'Block') type = 'block'
        return {
          code: item.Code,
          type,
          market: emMarketToBaiduMarket(mk),
          follow_status: '0',
          amount: '0',
          exchange: emMarketToBaiduExchange(mk, type === 'index' ? 'index' : 'stock', item.Code),
          name: item.Name || item.SecurityTypeName,
          price: '--',
          increase: '0',
          ratio: '0',
          amplitudeRatio: '0',
          turnoverRatio: '0',
          holdingAmount: '0',
          volume: '0',
          capitalization: '0',
          peRate: '0',
          pbRate: '0',
          status: '0',
          stockStatus: '6',
          stockStatusInfo: 'STOPT',
          src_loc: String(mk),
          subType: '',
          sf_url: '',
          pv: '0',
          CNYPrice: '--',
        }
      })

      if (!queryDetail) {
        return baseArr
      }

      const secids = arr.slice(0, 20).map((item) => item.QuoteID ?? `${item.MktNum}.${item.Code}`).join(',')
      const details = await cachedGet<{ data?: { diff?: EmQuoteKlt1Item[] } }>(
        `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170,f171,f177,f178&secids=${secids}&ut=fa5fd1943c7b386f172d6893dbfba10b`
      )
      const rows: EmQuoteKlt1Item[] = details?.data?.diff ?? []
      if (rows.length === 0) return baseArr
      const mergedArr: Stock[] = []
      for (const r of rows) {
        const meta = arr.find((m) => m.Code === r.f57)
        const base = baseArr.find((b) => b.code === r.f57)
        const mkStr = meta?.MktNum ?? (meta?.QuoteID ? String(meta.QuoteID).split('.')[0] : '1')
        const mk = Number.parseInt(String(mkStr), 10)
        const s = emQuoteToStock(r, mk)
        if (meta?.SecurityTypeName) {
          const st = meta.SecurityTypeName
          const classify = meta.Classify ?? ''
          if (st.includes('指数') || classify === 'Index') s.type = 'index'
          else if (st.includes('基金') || classify === 'Fund') s.type = 'fund'
          else if (st.includes('板块') || classify === 'Block') s.type = 'block'
          else s.type = 'stock'
        }
        s.code = r.f57
        s.sortOrder = base?.sortOrder
        s.holdingPrice = base?.holdingPrice
        s.holdingShares = base?.holdingShares
        mergedArr.push(s)
      }
      if (mergedArr.length > 0) return mergedArr
      return baseArr
    } catch {
      return []
    }
  }

  static async getQuotation(code: string): Promise<BaiDuApiResponse<QuotationResult>> {
    const secid = baiduExchangeToEmSecid(code)
    const quote = await this.getByType<Stock>(code)
    const mk = Number.parseInt(secid.split('.')[0], 10)
    const marketData: MarketData[] = []
    try {
      const minuteData = await cachedGet<string>(
        `https://push2his.eastmoney.com/api/qt/stock/trends2/get?fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&secid=${secid}&klt=1&ndays=1&iscr=0&ut=fa5fd1943c7b386f172d6893dbfba10b`
      )
      const m = minuteData as any
      const trends: string[] = m?.data?.trends ?? []
      for (const t of trends) {
        const parts = t.split(',')
        const date = parts[0] ?? ''
        const price = parts[2] ?? '0'
        const volume = parts[5] ?? '0'
        const avgPrice = parts[7] ?? '0'
        const p = `${date},${price},${avgPrice},${volume}`
        marketData.push({ date, p })
      }
    } catch {
      /* noop */
    }
    const timeText = quote?.stockStatusInfo === 'TRADE' ? '交易中' : '休市'
    return {
      QueryID: code,
      ResultCode: '0',
      Result: {
        StdStg: '',
        StdStl: '',
        _update_time: timeText,
        code,
        url: '',
        wiseUrl: '',
        encode: '',
        key: code,
        provider: 'eastmoney',
        update: {
          timezone: 'Asia/Shanghai',
          text: timeText,
          time: Math.floor(Date.now() / 1000),
          time_diff: '8',
        },
        newMarketData: {
          headers: ['时间', '价格', '均价', '成交量'],
          keys: ['date', 'p'],
          marketData,
        },
      },
    }
  }

  static async getQuotationMinute(code: string, group: QuotationGroup = 'quotation_minute_ab'): Promise<Quotation> {
    void group
    if (isGoldCode(code)) {
      return this.getGoldQuotationMinute(code)
    }
    const em = await this.getEmQuotationMinute(code)
    if (em.newMarketData?.marketData?.length) {
      return em
    }
    // 美股/OTC（字母代码）：Yahoo 有公开分钟线（粉单 ADR 腾讯/东财都没有分时）
    if (/^[A-Za-z]/.test(code)) {
      const yahoo = await withDbCache(`yahoo-min:${code}`, () => this.getYahooQuotationMinute(code), CachePolicy.minute)
      if (yahoo) return yahoo
    }
    return (await withDbCache(`tx-min:${code}`, () => this.getTencentQuotationMinute(code), CachePolicy.minute)) ?? em
  }

  private static async getYahooQuotationMinute(code: string): Promise<Quotation | undefined> {
    try {
      const response = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?range=1d&interval=5m&includePrePost=false`,
        { responseType: 'arraybuffer', timeout: 20000 },
      )
      const json = JSON.parse(new TextDecoder('utf-8').decode(response.data))
      const result = json?.chart?.result?.[0]
      const timestamps: number[] = result?.timestamp ?? []
      const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? []
      if (timestamps.length === 0) return undefined
      const timezone: string = result?.meta?.exchangeTimezoneName ?? 'America/New_York'
      const parsedPrevClose = Number(result?.meta?.chartPreviousClose ?? result?.meta?.previousClose)
      const marketData: { date: string, p: string }[] = []
      let lastPrice = 0
      for (let i = 0; i < timestamps.length; i++) {
        const price = closes[i]
        if (price == null || !Number.isFinite(price)) continue
        lastPrice = price
        const time = new Date(timestamps[i] * 1000).toLocaleTimeString('zh-CN', {
          timeZone: timezone,
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
        })
        marketData.push({ date: time, p: `${time},${price},,0,0` })
      }
      if (marketData.length === 0 || lastPrice <= 0) return undefined
      const prevClose = Number.isFinite(parsedPrevClose) && parsedPrevClose > 0 ? parsedPrevClose : lastPrice
      const change = lastPrice - prevClose
      const ratioPct = (change / prevClose) * 100
      return new Quotation({
        pankouinfos: {
          indicatorTitle: '盘口',
          indicatorUrl: '',
          list: [
            { ename: 'preClose', name: '昨收', value: prevClose.toFixed(2), originValue: String(prevClose) },
          ],
        },
        askinfos: [],
        buyinfos: [],
        update: {
          text: '',
          time: String(Math.floor(Date.now() / 1000)),
          realUpdateTime: '',
          timezone,
          shortZone: '',
          time_diff: 0,
          stockStatus: '',
          tradeStatus: 'ENDTR',
          tradeStatusCN: '',
        },
        cur: {
          time: Math.floor(Date.now() / 1000),
          price: lastPrice.toFixed(2),
          ratio: `${ratioPct.toFixed(2)}%`,
          increase: change.toFixed(2),
          volume: '0',
          avgPrice: '--',
          timeKey: '',
          amount: '--',
          show: 1,
          unit: '',
        },
        basicinfos: {
          exchange: 'US',
          code,
          name: String(result?.meta?.shortName ?? result?.meta?.longName ?? code),
          stockStatus: '',
          stock_market_code: '105',
          stockCode: code,
          tradeStatus: 'ENDTR',
          tradeStatusCN: '',
        },
        tag_list: [],
        chartTabs: [],
        tradingCounters: [],
        foreign_key: code,
        releaseDate: '',
        useWS: '0',
        financeType: 'stock',
        newMarketData: {
          headers: ['时间', '价格', '均价', '成交量', '成交额'],
          keys: ['date', 'p'],
          marketData,
        },
      })
    }
    catch {
      return undefined
    }
  }

  private static async getGoldQuotationMinute(code: string): Promise<Quotation> {
    const instrumentId = code.slice(5)
    const g = await GoldApi.quotations(instrumentId)
    const marketData = g.times.map((t, i) => ({
      date: t,
      p: `${t},${g.data[i] ?? g.latestPrice.toFixed(2)},,0,0`,
    }))
    const change = g.latestPrice - g.yesterdayClose
    const ratioPct = g.yesterdayClose > 0 ? (change / g.yesterdayClose) * 100 : 0
    return new Quotation({
      pankouinfos: {
        indicatorTitle: '盘口',
        indicatorUrl: '',
        list: [
          { ename: 'preClose', name: '昨收', value: g.yesterdayClose.toFixed(2), originValue: String(g.yesterdayClose) },
        ],
      },
      askinfos: [],
      buyinfos: [],
      update: {
        text: '',
        time: String(Math.floor(Date.now() / 1000)),
        realUpdateTime: g.delaystr,
        timezone: 'Asia/Shanghai',
        shortZone: 'CST',
        time_diff: 8,
        stockStatus: '',
        tradeStatus: 'ENDTR',
        tradeStatusCN: '',
      },
      cur: {
        time: Math.floor(Date.now() / 1000),
        price: g.latestPrice.toFixed(2),
        ratio: `${ratioPct.toFixed(2)}%`,
        increase: change.toFixed(2),
        volume: '0',
        avgPrice: '--',
        timeKey: '',
        amount: '--',
        show: 1,
        unit: '',
      },
      basicinfos: {
        exchange: 'SGE',
        code,
        name: GOLD_INSTRUMENTS[code] ?? instrumentId,
        stockStatus: '',
        stock_market_code: '118',
        stockCode: code,
        tradeStatus: 'ENDTR',
        tradeStatusCN: '',
      },
      tag_list: [],
      chartTabs: [],
      tradingCounters: [],
      foreign_key: code,
      releaseDate: '',
      useWS: '0',
      financeType: 'stock',
      newMarketData: {
        headers: ['时间', '价格', '均价', '成交量', '成交额'],
        keys: ['date', 'p'],
        marketData,
      },
    })
  }

  private static async getEmQuotationMinute(code: string): Promise<Quotation> {
    const secid = baiduExchangeToEmSecid(code)
    const mk = Number.parseInt(secid.split('.')[0], 10)

    let quoteInfo: EmQuoteKlt1Item | null = null
    try {
      const qData = await cachedGet<string>(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170,f171,f177,f178&ut=fa5fd1943c7b386f172d6893dbfba10b&invt=2&fltt=2`
      )
      const json = qData as unknown as { data: EmQuoteKlt1Item | null }
      quoteInfo = json?.data ?? null
    } catch {
      quoteInfo = null
    }

    const marketData: MarketData[] = []
    let preClose = 0
    const fetchTrends = async (trendsSecid: string) => {
      const minuteData = await cachedGet<string>(
        `https://push2his.eastmoney.com/api/qt/stock/trends2/get?fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&secid=${trendsSecid}&klt=1&ndays=1&iscr=0&ut=fa5fd1943c7b386f172d6893dbfba10b`
      )
      const m = minuteData as any
      preClose = Number(m?.data?.preKClose ?? 0) / 100 || Number(m?.data?.jqPreClose ?? 0) / 100 || 0
      const trends: string[] = m?.data?.trends ?? []
      for (const t of trends) {
        const parts = t.split(',')
        const date = parts[0] ?? ''
        const price = parts[2] ?? '0'
        const avgPrice = parts[7] ?? '0'
        const volume = parts[5] ?? '0'
        const amount = parts[6] ?? '0'
        const p = `${date},${price},${avgPrice},${volume},${amount}`
        marketData.push({ date, p })
      }
      return trends.length
    }
    try {
      let count = await fetchTrends(secid)
      // 美股粉单市场（OTC）的 secid 是 153.，默认 105. 查不到分时时补查一次
      if (count === 0 && secid.startsWith('105.')) {
        count = await fetchTrends(`153.${code}`)
      }
    } catch {
      /* noop */
    }

    const dp = quoteInfo?.f52 ?? 2
    const priceRaw = quoteInfo?.f43 ?? 0
    const price = priceRaw / Math.pow(10, dp)
    const vol = quoteInfo?.f47 ?? 0
    const amount = quoteInfo?.f48 ?? 0
    const close = quoteInfo?.f60 ?? preClose * Math.pow(10, dp)
    const preClosePrice = close / Math.pow(10, dp) || preClose
    const increase = price - preClosePrice
    const ratioPct = preClosePrice === 0 ? 0 : (increase / preClosePrice) * 100
    const info = emStatusToBaiduInfo(quoteInfo?.f178 ?? '')
    const exchange = emMarketToBaiduExchange(mk, 'stock', quoteInfo?.f57)

    return new Quotation({
      pankouinfos: {
        indicatorTitle: '盘口',
        indicatorUrl: '',
        list: [
          { ename: 'preClose', name: '昨收', value: preClosePrice.toFixed(dp), originValue: String(close) },
          { ename: 'open', name: '今开', value: quoteInfo ? (quoteInfo.f46 / Math.pow(10, dp)).toFixed(dp) : '--', originValue: String(quoteInfo?.f46 ?? 0) },
          { ename: 'high', name: '最高', value: quoteInfo ? (quoteInfo.f44 / Math.pow(10, dp)).toFixed(dp) : '--', originValue: String(quoteInfo?.f44 ?? 0) },
          { ename: 'low', name: '最低', value: quoteInfo ? (quoteInfo.f45 / Math.pow(10, dp)).toFixed(dp) : '--', originValue: String(quoteInfo?.f45 ?? 0) },
          { ename: 'volume', name: '成交量', value: `${(vol / 10000).toFixed(2)}万手`, originValue: String(vol) },
          { ename: 'amount', name: '成交额', value: amount >= 100000000 ? `${(amount / 100000000).toFixed(2)}亿` : `${(amount / 10000).toFixed(2)}万`, originValue: String(amount) },
          { ename: 'turnoverRate', name: '换手', value: quoteInfo?.f168 ? `${(quoteInfo.f168 / 100).toFixed(2)}%` : '--', originValue: String(quoteInfo?.f168 ?? 0) },
          { ename: 'amplitude', name: '振幅', value: quoteInfo?.f170 ? `${(quoteInfo.f170 / 100).toFixed(2)}%` : '--', originValue: String(quoteInfo?.f170 ?? 0) },
        ],
      },
      askinfos: [],
      buyinfos: [],
      update: {
        text: info === 'TRADE' ? '交易中' : '休市',
        time: String(Math.floor(Date.now() / 1000)),
        realUpdateTime: new Date().toLocaleString('zh-CN', { hour12: false }),
        timezone: 'Asia/Shanghai',
        shortZone: 'CST',
        time_diff: 8,
        stockStatus: quoteInfo?.f178 ?? '',
        tradeStatus: info,
        tradeStatusCN: info === 'TRADE' ? '交易中' : (info === 'ENDTR' ? '已收盘' : '休市'),
      },
      cur: {
        time: Math.floor(Date.now() / 1000),
        price: price.toFixed(dp),
        ratio: `${ratioPct.toFixed(2)}%`,
        increase: increase.toFixed(dp),
        volume: String(Math.floor(vol / 100)),
        avgPrice: '--',
        timeKey: '',
        amount: amount >= 100000000 ? `${(amount / 100000000).toFixed(2)}亿` : `${(amount / 10000).toFixed(2)}万`,
        show: 1,
        unit: '',
      },
      basicinfos: {
        exchange,
        code,
        name: quoteInfo?.f58 ?? code,
        stockStatus: quoteInfo?.f178 ?? '',
        stock_market_code: String(mk),
        stockCode: code,
        tradeStatus: info,
        tradeStatusCN: info === 'TRADE' ? '交易中' : (info === 'ENDTR' ? '已收盘' : '休市'),
      },
      tag_list: [],
      chartTabs: [],
      tradingCounters: [],
      foreign_key: code,
      releaseDate: '',
      useWS: '0',
      financeType: 'stock',
      newMarketData: {
        headers: ['时间', '价格', '均价', '成交量', '成交额'],
        keys: ['date', 'p'],
        marketData,
      },
    })
  }

  static async getOpenData(query: string, month: number): Promise<OpenDataResult | undefined> {
    void query
    void month
    return undefined
  }

  // 东方财富分时接口不可用时，用腾讯分时数据兜底，保证分时图有内容
  private static async getTencentQuotationMinute(code: string): Promise<Quotation | undefined> {
    const prefix = tencentPrefixFor(code)
    if (!prefix) return undefined
    try {
      const response = await axios.get(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${prefix}${code}`, { responseType: 'arraybuffer' })
      const json = JSON.parse(new TextDecoder('utf-8').decode(response.data))
      const symbol = `${prefix}${code}`
      const rows: string[] = json?.data?.[symbol]?.data?.data ?? []
      const qtRow: string[] = json?.data?.[symbol]?.qt?.[symbol] ?? []
      if (rows.length === 0) return undefined
      const marketData: { date: string, p: string }[] = []
      let lastPrice = 0
      for (const row of rows) {
        const parts = row.trim().split(/\s+/)
        if (parts.length < 3) continue
        const price = Number.parseFloat(parts[1])
        if (!Number.isFinite(price)) continue
        lastPrice = price
        const hhmm = parts[0]
        const time = `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`
        marketData.push({ date: time, p: `${time},${parts[1]},,${parts[2] ?? '0'},${parts[3] ?? '0'}` })
      }
      if (marketData.length === 0 || lastPrice <= 0) return undefined
      const parsedPrevClose = Number.parseFloat(qtRow[4])
      const prevClose = Number.isFinite(parsedPrevClose) && parsedPrevClose > 0 ? parsedPrevClose : lastPrice
      const increase = lastPrice - prevClose
      const ratioPct = (increase / prevClose) * 100
      const ex = prefix.toUpperCase()
      return new Quotation({
        pankouinfos: {
          indicatorTitle: '盘口',
          indicatorUrl: '',
          list: [
            { ename: 'preClose', name: '昨收', value: prevClose.toFixed(2), originValue: String(prevClose) },
          ],
        },
        askinfos: [],
        buyinfos: [],
        update: {
          text: '交易中',
          time: String(Math.floor(Date.now() / 1000)),
          realUpdateTime: new Date().toLocaleString('zh-CN', { hour12: false }),
          timezone: 'Asia/Shanghai',
          shortZone: 'CST',
          time_diff: 8,
          stockStatus: '',
          tradeStatus: 'ENDTR',
          tradeStatusCN: '',
        },
        cur: {
          time: Math.floor(Date.now() / 1000),
          price: lastPrice.toFixed(2),
          ratio: `${ratioPct.toFixed(2)}%`,
          increase: increase.toFixed(2),
          volume: '0',
          avgPrice: '--',
          timeKey: '',
          amount: '--',
          show: 1,
          unit: '',
        },
        basicinfos: {
          exchange: ex,
          code,
          name: String(qtRow[1] ?? code),
          stockStatus: '',
          stock_market_code: ex === 'HK' ? '116' : (ex === 'SH' ? '1' : '0'),
          stockCode: code,
          tradeStatus: 'ENDTR',
          tradeStatusCN: '',
        },
        tag_list: [],
        chartTabs: [],
        tradingCounters: [],
        foreign_key: code,
        releaseDate: '',
        useWS: '0',
        financeType: 'stock',
        newMarketData: {
          headers: ['时间', '价格', '均价', '成交量', '成交额'],
          keys: ['date', 'p'],
          marketData,
        },
      })
    }
    catch {
      return undefined
    }
  }
}

export type QuotationGroup = 'quotation_minute_ab' | 'quotation_index_fiveday' | 'quotation_block_minute'
export type StockType = 'index' | 'fund' | 'stock' | 'block'

export interface EmMinuteRaw {
  code: string
  market: number
  type: number
  status: number
  name: string
  decimal: number
  preSettlement: number
  preClose: number
  beticks: string
  trendsTotal: number
  time: number
  kind: number
  prePrice: number
  trends: string[]
}

export interface LabelMap {
  text: string
  ename: string
}

export interface EmSearchSuggestDataItem {
  Code: string
  Name: string
  PinYin: string
  ID: string
  JYS: string
  Classify: string
  MarketType: string
  SecurityTypeName: string
  SecurityType: string
  MktNum: string
  TypeUS: string
  QuoteID: string
  UnifiedCode: string
  InnerCode: string
}

export interface EmSearchSuggestResponse {
  QuotationCodeTable: {
    Data: EmSearchSuggestDataItem[]
    Status: number
    Message: string
    TotalCount: number
    BizCode: string
    BizMsg: string
  }
}

export interface StockStatus {
  is_trend: string
  time_sort: string
}

export interface Result {
  stock: Stock[]
  index: any[]
  deal_status: string
  stock_status: StockStatus
  refresh_time: string
  labelMap: LabelMap[]
  isNew: string
  follow_num: string
}

export interface BaiDuApiResponse<T> {
  QueryID: string
  ResultCode: string | number
  Result: T
}

interface MarketData {
  date: string
  p: string
}

export interface QuotationResult {
  StdStg: string
  StdStl: string
  _update_time: string
  code: string
  url: string
  wiseUrl: string
  encode: string
  key: string
  provider: string
  update: {
    timezone: string
    text: string
    time: number
    time_diff: string
  }
  newMarketData: NewMarketData
}

export interface NewMarketData {
  headers: string[]
  keys: string[]
  marketData: MarketData[]
}
