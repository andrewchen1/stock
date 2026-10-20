import { useEffect, useState } from 'react'
import axios from 'axios'
import { CachePolicy, withDbCache } from '@/api/http-cache'
import { useStockColorStore } from '@/store/use-stock-color-store'

interface TickerItem {
  name: string
  price: number
  changePct: number
}

// 新浪跑马灯条目：全球主要市场指数 + 大宗期货
const SINA_TICKER_CODES: Array<{ code: string; name: string; kind: 's' | 'hk' | 'int' | 'hf' | 'fx' }> = [
  { code: 's_sh000001', name: '上证指数', kind: 's' },
  { code: 's_sz399001', name: '深证成指', kind: 's' },
  { code: 'rt_hkHSI', name: '恒生指数', kind: 'hk' },
  { code: 'int_nikkei', name: '日经225', kind: 'int' },
  { code: 'int_dji', name: '道琼斯', kind: 'int' },
  { code: 'int_nasdaq', name: '纳斯达克', kind: 'int' },
  { code: 'int_sp500', name: '标普500', kind: 'int' },
  { code: 'hf_GC', name: 'COMEX黄金', kind: 'hf' },
  { code: 'hf_OIL', name: '布伦特原油', kind: 'hf' },
  { code: 'DINIW', name: '美元指数', kind: 'fx' },
]

function parseSinaNumber(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function parseSinaTicker(kind: string, fields: string[]): Omit<TickerItem, 'name'> | undefined {
  switch (kind) {
    case 's': {
      const price = parseSinaNumber(fields[1])
      const changePct = parseSinaNumber(fields[3])
      if (!Number.isFinite(price)) return undefined
      return { price, changePct: Number.isFinite(changePct) ? changePct : 0 }
    }
    case 'hk': {
      const price = parseSinaNumber(fields[6])
      const changePct = parseSinaNumber(fields[8])
      if (!Number.isFinite(price)) return undefined
      return { price, changePct: Number.isFinite(changePct) ? changePct : 0 }
    }
    case 'int': {
      const price = parseSinaNumber(fields[1])
      const changePct = parseSinaNumber(fields[3])
      if (!Number.isFinite(price)) return undefined
      return { price, changePct: Number.isFinite(changePct) ? changePct : 0 }
    }
    case 'hf': {
      const price = parseSinaNumber(fields[0])
      const prevSettle = parseSinaNumber(fields[2])
      if (!Number.isFinite(price)) return undefined
      const changePct = Number.isFinite(prevSettle) && prevSettle > 0 ? ((price - prevSettle) / prevSettle) * 100 : 0
      return { price, changePct }
    }
    case 'fx': {
      const price = parseSinaNumber(fields[1])
      const prevClose = parseSinaNumber(fields[3])
      if (!Number.isFinite(price)) return undefined
      const changePct = Number.isFinite(prevClose) && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0
      return { price, changePct }
    }
    default:
      return undefined
  }
}

async function fetchSinaTickers(): Promise<TickerItem[]> {
  const codes = SINA_TICKER_CODES.map(item => item.code).join(',')
  const response = await axios.get(`https://hq.sinajs.cn/list=${codes}`, { responseType: 'arraybuffer' })
  const text = new TextDecoder('gbk').decode(response.data)
  const segments = text.split(';').map((segment) => {
    const m = segment.match(/hq_str_(\S+)="(.*)"/)
    return m ? { code: m[1], payload: m[2] } : null
  }).filter(Boolean) as Array<{ code: string, payload: string }>
  const items: TickerItem[] = []
  for (const meta of SINA_TICKER_CODES) {
    const segment = segments.find(segment => segment.code === meta.code)
    if (!segment) continue
    const item = parseSinaTicker(meta.kind, segment.payload.split(','))
    if (item) {
      items.push({ name: meta.name, price: item.price, changePct: item.changePct })
    }
  }
  return items
}

async function fetchEastmoneyTickers(): Promise<TickerItem[]> {
  const secids = '1.000001,0.399001,100.HSI,100.N225,100.DJIA,100.NDX,100.SPX,101.GC00Y,102.CL00Y,100.UDI'
  const res = await axios.get(
    `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f14&secids=${secids}&ut=fa5fd1943c7b386f172d6893dbfba10b`,
  )
  const rows: any[] = res.data?.data?.diff ?? []
  return rows
    .map(row => ({ name: String(row.f14 ?? ''), price: Number(row.f2), changePct: Number(row.f3) }))
    .filter(item => item.name && Number.isFinite(item.price))
}

// 顶部跑马灯：全球主要市场指数 + 大宗期货涨跌（新浪主源，东财备用）
export function MarketTicker({ refreshInterval = 60000 }: { refreshInterval?: number }) {
  const [items, setItems] = useState<TickerItem[]>([])
  const getColorByValue = useStockColorStore(state => state.getColorByValue)

  useEffect(() => {
    let cancelled = false
    const fetchTickers = async () => {
      let next: TickerItem[] = []
      try {
        next = await withDbCache('ticker:sina', fetchSinaTickers, CachePolicy.ticker)
      }
      catch {
        /* fallback below */
      }
      if (next.length === 0) {
        try {
          next = await withDbCache('ticker:em', fetchEastmoneyTickers, CachePolicy.ticker)
        }
        catch {
          /* 保留上一次数据 */
        }
      }
      if (!cancelled && next.length > 0) {
        setItems(next)
      }
    }
    fetchTickers()
    const timer = setInterval(fetchTickers, refreshInterval)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refreshInterval])

  if (items.length === 0) return null
  const strip = [...items, ...items]
  return (
    <div className="ticker-strip mx-3 mb-1 overflow-hidden rounded-lg border border-white/10 bg-black/20 py-1">
      <div className="ticker-track flex w-max whitespace-nowrap">
        {strip.map((item, index) => {
          const { color } = getColorByValue(item.changePct)
          return (
            <span key={index} className="mx-3 inline-flex items-baseline gap-1.5 text-[10px] tabular-nums leading-none">
              <span className="opacity-70" style={{ color: 'var(--widget-color, inherit)' }}>{item.name}</span>
              <span className="font-semibold" style={{ color: 'var(--widget-color, inherit)' }}>
                {item.price.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}
              </span>
              <span className="font-semibold" style={{ color }}>
                {item.changePct >= 0 ? '+' : ''}
                {item.changePct.toFixed(2)}%
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}
