import styled from 'styled-components'
import { ExchangeTag } from '@/components/exchange-tag'
import { StockChart } from '@/components/stock-chart'
import { cn, formatMoney, formatNumber, formatPercent } from '@/lib/utils'
import type { Stock } from '@/model/stock'

const RatioBadge = styled.span<{ $backgroundColor: string }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 64px;
  height: 24px;
  border-radius: 6px;
  color: white;
  background-color: ${({ $backgroundColor }) => $backgroundColor};
  font-size: 16px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
`

interface StockItemProps {
  stock: Stock
  idx: number
  isLast: boolean
  metricMode: StockMetricMode
  getColorByValue: (value: number) => { color: string }
  /** A+H：同名 H 股招股信息（发售价为港元） */
  hkIpo?: { code: string, name: string, offerPrice: number, listingDate: string }
  /** 港元兑人民币实时汇率 */
  fxRate?: number
}

export type StockMetricMode = 'changePercent' | 'returnRate' | 'returnAmount'

export default function StockItem({ stock, idx, isLast, metricMode, getColorByValue, hkIpo, fxRate }: StockItemProps) {
  const ratio = Number.parseFloat(stock.ratio) || 0
  const increase = Number.parseFloat(stock.increase) || 0
  const price = Number.parseFloat(stock.price) || 0
  const holdingPrice = stock.holdingPrice || 0
  const holdingShares = stock.holdingShares || 0
  const returnRate = holdingPrice > 0 ? ((price - holdingPrice) / holdingPrice) * 100 : 0
  const returnAmount = holdingPrice > 0 && holdingShares > 0
    ? (price - holdingPrice) * holdingShares
    : 0
  const metricValue = metricMode === 'changePercent'
    ? ratio
    : metricMode === 'returnRate'
      ? returnRate
      : returnAmount
  const metricText = metricMode === 'changePercent'
    ? formatPercent(ratio)
    : metricMode === 'returnRate'
      ? formatPercent(returnRate)
      : `${returnAmount >= 0 ? '+' : ''}${formatMoney(returnAmount)}`
  const { color: marketColor } = getColorByValue(ratio)
  const { color: metricColor } = getColorByValue(metricValue)

  // A+H：同名 H 股招股的发售价（港元）折算人民币并计算相对 A 股现价的折价
  const hkOffer = hkIpo?.offerPrice
  const hkOfferCny = hkOffer && fxRate ? hkOffer * fxRate : undefined
  const hkDiscount = hkOfferCny !== undefined && price > 0 ? (1 - hkOfferCny / price) * 100 : undefined

  // IPO 扫描自动加入的行（上市首日）：以琥珀横幅形式展示首日表现
  // 未上市前（发售价未公布等）显示 发行价 / 待上市
  const isPreListing = !!stock.autoAdded && !(price > 0)
  const offerPriceNum = Number.parseFloat(stock.high ?? '')

  // 自动加入的首日行：琥珀横幅形式（与“招股中”提示行同款样式）
  if (stock.autoAdded) {
    return (
      <div
        className="mb-1 flex items-center justify-between overflow-hidden rounded-lg border border-amber-300/20 bg-amber-400/10 px-3 py-1.5 text-[11px]"
        title="今日上市新股首日表现（收盘后自动移出面板）"
      >
        <span className="truncate text-amber-100/90">
          <span className="mr-1">🚀</span>今日上市 {stock.name} {stock.code}
        </span>
        <span className="ml-2 shrink-0 font-semibold tabular-nums" style={{ color: price > 0 ? getColorByValue(ratio).color : 'var(--widget-color, inherit)' }}>
          {price > 0
            ? `${price.toFixed(2)} ${ratio >= 0 ? '+' : ''}${ratio.toFixed(2)}%`
            : (Number.isFinite(offerPriceNum) ? `发行价 ${offerPriceNum}` : '待上市')}
        </span>
      </div>
    )
  }

  return (
    <div
      key={stock.code}
      className={cn(
        'drag-handle grid grid-cols-[100px_60px_minmax(52px,1fr)_64px] items-center gap-x-2 py-2 px-2 rounded-xl cursor-grab active:cursor-grabbing transition-colors hover:bg-white/5',
        !isLast && ''
      )}
    >
      <div className="flex min-w-0 flex-col justify-center gap-1">
        <span className="text-[16px] font-semibold leading-[1] truncate text-white" style={{ color: 'var(--widget-color, inherit)' }}>
          {stock.name}
        </span>
        <div className="flex items-center gap-1.5 mt-1">
          {stock.market === 'gold' ? (
            <span
              className="text-[9px] font-bold leading-none px-1 py-[2px] rounded border border-amber-300/50 bg-amber-400/35 text-amber-200 shrink-0"
              title="上海黄金交易所"
            >
              SGE
            </span>
          ) : (
            <ExchangeTag
              exchange={stock.market || 'us'}
              size="xs"
              style={{ height: '10px', width: 'auto' }}
              className="!w-auto"
            />
          )}
          <span className="text-[12px] leading-none tracking-wide" style={{ color: 'var(--widget-color, inherit)' }}>
            {stock.code}
          </span>
        </div>
      </div>

      <div className="flex justify-center">
        {!isPreListing && <StockChart code={stock.code} height={32} />}
      </div>

      <div className="flex min-w-0 flex-col items-end justify-center gap-1">
        {isPreListing ? (
          <span className="text-[12px] font-semibold tabular-nums leading-none" style={{ color: 'var(--widget-color, inherit)' }}>
            {Number.isFinite(offerPriceNum) ? `发行价 ${offerPriceNum}` : '待上市'}
          </span>
        ) : (
          <span className="text-[12px] font-semibold tabular-nums leading-none" style={{ color: 'var(--widget-color, inherit)' }}>
            {formatNumber(stock.price, 3)}
          </span>
        )}
        {!isPreListing && (
          <span
            className="text-[12px] font-semibold tabular-nums leading-none"
            style={{ color: marketColor }}
          >
            {increase >= 0 ? '+' : ''}
            {formatNumber(String(increase), 2)}
          </span>
        )}
        {!isPreListing && (
          <span
            className="text-[10px] font-normal tabular-nums leading-none whitespace-nowrap truncate max-w-full opacity-60"
            style={{ color: 'var(--widget-color, inherit)' }}
            title={`盘中最高 ${stock.high ?? '--'} / 盘中最低 ${stock.low ?? '--'}`}
          >
            高 {stock.high ?? '--'}  低 {stock.low ?? '--'}
          </span>
        )}
        {hkIpo && (
          <span
            className="text-[10px] font-semibold leading-none whitespace-nowrap truncate max-w-full"
            style={{ color: '#f5c451' }}
            title={`A+H：H股发售价 HK$${hkIpo.offerPrice.toFixed(2)} ≈¥${(hkOfferCny ?? 0).toFixed(2)}，相对现价折价 ${Math.abs(hkDiscount ?? 0).toFixed(1)}%${hkIpo.listingDate ? `（${hkIpo.listingDate} 上市）` : ''}`}
          >
            {`H发 ${hkOfferCny !== undefined ? `¥${hkOfferCny.toFixed(2)}` : `HK$${(hkOffer ?? 0).toFixed(2)}`} · 折价${Math.abs(hkDiscount ?? 0).toFixed(0)}%`}
          </span>
        )}
      </div>

      <div className="flex justify-end">
        <RatioBadge $backgroundColor={isPreListing ? 'rgba(156,163,175,0.35)' : metricColor} title={isPreListing ? '待上市' : metricText}>
          {isPreListing ? '待上市' : metricText}
        </RatioBadge>
      </div>
    </div>
  )
}
