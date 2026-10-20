import axios from 'axios'
import { CachePolicy, withDbCache } from '@/api/http-cache'
import type { Stock } from '@/model/stock'

const DAY_MS = 24 * 3600 * 1000

export interface HkIpoInfo {
  /** 港股代码，如 '02384' */
  code: string
  name: string
  /** 发售价（港元/股） */
  offerPrice: number
  /** 上市日期 'YYYY-MM-DD' */
  listingDate: string
  /** 上市首日结束时间（HKT 16:00）的时间戳，用于自动移除 */
  firstDayEnd: number
  /** 每手股数 */
  lotSize?: number
  /** 一手入场费（港元） */
  entryFee?: number
  /** 招股截止时间（截止日中午 12:00 HKT） */
  subEndAt?: number
  /** 上市状态：待上市 / 已上市 */
  listingStatus?: string
}

const BASE = 'https://cibo.hk/zh-CN'

// 首页“资金冻结时间表”区的招股中新股链接（锚文本 = 代码 + 名称）
async function fetchActiveIpoLinks(): Promise<Array<{ code: string, name: string }>> {
  const res = await axios.get(`${BASE}/index.html`, { responseType: 'arraybuffer', timeout: 20000 })
  const html = new TextDecoder('utf-8').decode(res.data)
  const results: Array<{ code: string, name: string }> = []
  const re = /<a[^>]*href="\/zh-CN\/ipo-allotment-predict-(\d{5})\.html"[^>]*>\s*(\d{5})\s*([^<]+)</g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const code = m[1]
    const name = m[2].trim()
    if (!results.some(item => item.code === code)) {
      results.push({ code, name })
    }
  }
  return results
}

function parseField(html: string, field: string): string {
  const re = new RegExp(`data-field="${field}"[^>]*><th>[^<]*(?:<span[^>]*>[^<]*</span>)?</th><td>([^<]+)`)
  const m = html.match(re)
  return m ? m[1].trim() : ''
}

function parseHkAmount(value: string): number {
  const m = value.replace(/,/g, '').match(/([\d.]+)/)
  return m ? Number.parseFloat(m[1]) : Number.NaN
}

// 招股信息页的结构化字段：名称/发售价/每手/入场费/招股期间/上市日期/上市状态
// 注意：招股早期发售价可能未公布（为空），此时 offerPrice 记 0，不影响其余字段
async function fetchIpoDetail(code: string): Promise<{ name: string } & Omit<HkIpoInfo, 'code' | 'name'> | undefined> {
  try {
    const res = await axios.get(`${BASE}/prospectus-${code}.html`, { responseType: 'arraybuffer', timeout: 20000 })
    const html = new TextDecoder('utf-8').decode(res.data)
    const name = parseField(html, 'field_stock_name')
    const listingDate = parseField(html, 'field_listing_date')
    const offerPriceRaw = parseHkAmount(parseField(html, 'field_offer_price'))
    // 发售价未公布时，用招股价区间的上限替代
    const rangeStr = parseField(html, 'field_price_range')
    const rangeNums = (rangeStr.match(/[\d.]+/g) || []).map(Number.parseFloat).filter(n => Number.isFinite(n))
    const offerPrice = Number.isFinite(offerPriceRaw) && offerPriceRaw > 0
      ? offerPriceRaw
      : (rangeNums.length > 0 ? Math.max(...rangeNums) : 0)
    if (!name && offerPrice <= 0) return undefined
    const lotSize = parseHkAmount(parseField(html, 'field_lot_size'))
    const entryFee = parseHkAmount(parseField(html, 'field_entry_threshold'))
    const period = parseField(html, 'field_offer_period')
    let subEndAt: number | undefined
    const rangeMatch = period.match(/(\d{4}-\d{2}-\d{2})\s*至\s*(\d{4}-\d{2}-\d{2})/)
    if (rangeMatch) {
      // 招股截止日中午 12:00（HKT）
      const parsed = Date.parse(`${rangeMatch[2]}T12:00:00+08:00`)
      if (Number.isFinite(parsed)) subEndAt = parsed
    }
    let firstDayEnd = Date.now() + 7 * DAY_MS
    if (listingDate) {
      const parsed = Date.parse(`${listingDate}T16:00:00+08:00`)
      if (Number.isFinite(parsed)) firstDayEnd = parsed
    }
    return {
      name: name || '',
      offerPrice,
      listingDate,
      firstDayEnd,
      lotSize: Number.isFinite(lotSize) ? lotSize : undefined,
      entryFee: Number.isFinite(entryFee) ? entryFee : undefined,
      subEndAt,
      listingStatus: parseField(html, 'field_listing_status') || undefined,
    }
  }
  catch {
    return undefined
  }
}

export async function fetchActiveHkIpos(): Promise<HkIpoInfo[]> {
  return withDbCache('hk-ipo:active', async () => {
    const links = await fetchActiveIpoLinks()
    const out: HkIpoInfo[] = []
    for (const link of links) {
      const detail = await fetchIpoDetail(link.code)
      out.push({
        code: link.code,
        name: detail?.name || link.name,
        offerPrice: detail?.offerPrice ?? 0,
        listingDate: detail?.listingDate ?? '',
        firstDayEnd: detail?.firstDayEnd ?? 0,
        lotSize: detail?.lotSize,
        entryFee: detail?.entryFee,
        subEndAt: detail?.subEndAt,
        listingStatus: detail?.listingStatus,
      })
    }
    return out
  }, { freshMs: 4 * 3600 * 1000, staleMs: 30 * DAY_MS })
}

// 港元兑人民币实时汇率（新浪）
export async function fetchHkdcnyRate(): Promise<number | undefined> {
  const response = await axios.get('https://hq.sinajs.cn/list=fx_shkdcny', {
    responseType: 'arraybuffer',
    timeout: 10000,
  })
  const text = new TextDecoder('gbk').decode(response.data)
  const m = text.match(/="(.*)"/)
  if (!m) return undefined
  const rate = Number.parseFloat(m[1].split(',')[1])
  return Number.isFinite(rate) && rate > 0 ? rate : undefined
}

export async function getHkdcnyRate(): Promise<number> {
  try {
    return await withDbCache('fx:hkdcny', async () => {
      const rate = await fetchHkdcnyRate()
      if (rate === undefined) throw new Error('rate unavailable')
      return rate
    }, { freshMs: 3600 * 1000, staleMs: 30 * DAY_MS })
  }
  catch {
    return 0.92
  }
}

/** 将招股中的港股 IPO 转成自选列表条目（上市前先显示发售价） */
export function hkIpoToStock(ipo: HkIpoInfo): Stock {
  const price = ipo.offerPrice > 0 ? ipo.offerPrice.toFixed(2) : '--'
  return {
    code: ipo.code,
    type: 'stock',
    market: 'hk',
    follow_status: '0',
    amount: '0',
    exchange: 'HK',
    name: ipo.name,
    price,
    high: ipo.offerPrice > 0 ? ipo.offerPrice.toFixed(2) : '--',
    low: ipo.offerPrice > 0 ? ipo.offerPrice.toFixed(2) : '--',
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
    src_loc: '',
    subType: '',
    sf_url: '',
    pv: '0',
    CNYPrice: price,
    autoAdded: true,
    autoRemoveAt: ipo.firstDayEnd > 0 ? ipo.firstDayEnd : Date.now() + 7 * DAY_MS,
  }
}
