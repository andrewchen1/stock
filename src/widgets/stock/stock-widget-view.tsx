import { useCallback, useEffect, useRef, useState } from 'react'
import { useWidget, useWidgetStorage, WidgetWrapper } from '@widget-js/react'
import styled, { createGlobalStyle, keyframes } from 'styled-components'
import { ChevronLeft, ChevronRight, GripHorizontal, RefreshCw, Settings } from 'lucide-react'
import { useSelfSelectStockStore } from '@/store/use-self-select-stock-store'
import { useStockColorStore } from '@/store/use-stock-color-store'
import type { Stock } from '@/model/stock'
import Sortable from 'sortablejs'
import { WidgetApi } from '@widget-js/core'
import { EastMoneyStockApi } from '@/api/eastmoney-stock-api'
import { onCacheStatus, dbCacheGet, dbCacheSet } from '@/api/http-cache'
import { fetchActiveHkIpos, getHkdcnyRate, hkIpoToStock, type HkIpoInfo } from '@/api/hk-ipo-api'
import { selfSelectStockRepository } from '@/data/self-select-stock-repository'
import { useInterval } from '@/hooks/use-interval'
import { MarketTicker } from '@/components/market-ticker'
import { useNetworkStatusStore } from '@/store/use-network-status-store'
import StockItem, { type StockMetricMode } from './stock-item'

const StockGlobalStyle = createGlobalStyle`
  body {
    background-color: transparent;
    color: 'var(--widget-color, inherit)';
  }
  *{
    user-select: none;
  }
`

const WidgetTitle = styled.div`
  color: var(--widget-color, inherit);
  font-size: 18px;
  font-weight: 600;
  line-height: 1;
`

const spin = keyframes`
  to {
    transform: rotate(360deg);
  }
`

const RefreshIndicator = styled(RefreshCw)`
  display: inline-block;
  width: 13px;
  height: 13px;
  margin-left: 8px;
  vertical-align: -1px;
  opacity: 0.5;
  animation: ${spin} 0.8s linear infinite;
`

const REFRESH_OPTIONS = [
  { label: '30 秒', value: 30000 },
  { label: '1 分钟', value: 60000 },
  { label: '3 分钟', value: 180000 },
  { label: '5 分钟', value: 300000 },
]

const METRIC_MODE_OPTIONS: Array<{ value: StockMetricMode; label: string }> = [
  { value: 'changePercent', label: '涨跌幅' },
  { value: 'returnRate', label: '收益率' },
  { value: 'returnAmount', label: '收益额' },
]


export default function StockWidgetView() {
  const { stocks, loadAll, saveOrder } = useSelfSelectStockStore()
  const { getColorByValue, getUpColor, getDownColor, toggleStockColor, isUpColorRed } = useStockColorStore()
  const sortableRef = useRef<HTMLDivElement>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [refreshInterval, setRefreshInterval] = useState<number>(60000)
  const [localStocks, setLocalStocks] = useState<Stock[]>([])
  const [loading, setLoading] = useState(false)
  const [metricMode] = useState<StockMetricMode>('changePercent')
  const [widgetTitle] = useWidgetStorage('stock-widget-title', '自选股票')
  const lastOkAt = useNetworkStatusStore(state => state.lastOkAt)
  const lastFailAt = useNetworkStatusStore(state => state.lastFailAt)

  useEffect(() => onCacheStatus((event) => {
    if (event.type === 'ok') {
      useNetworkStatusStore.getState().markOk()
    }
    else {
      useNetworkStatusStore.getState().markFail()
    }
  }), [])

  // 缓存兜底晚于最近一次实时成功 → 提示网络异常
  const netStale = (lastFailAt ?? 0) > (lastOkAt ?? 0)

  // 点击穿透模式下的智能放行：悬停在按钮等交互元素上时暂停穿透，保证可点
  useEffect(() => {
    let lastSent = 0
    const onMove = (event: MouseEvent) => {
      const now = Date.now()
      if (now - lastSent < 120) return
      lastSent = now
      const target = event.target as HTMLElement | null
      const interactive = !!target?.closest('button, input, a, [data-interactive]')
      window.stockShell?.setIgnoreMouseEvents?.(interactive)?.catch(() => {})
    }
    document.addEventListener('mousemove', onMove)
    return () => document.removeEventListener('mousemove', onMove)
  }, [])

  // 拖动把手：平时是普通按钮（可 hover 高亮），按下后由主进程轮询光标移动窗口（跟手）
  const onGripMouseDown = useCallback(() => {
    window.stockShell?.startWindowDrag?.()?.catch(() => {})
    const onUp = () => {
      window.stockShell?.stopWindowDrag?.()?.catch(() => {})
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mouseup', onUp)
  }, [])

  const [hkIpos, setHkIpos] = useState<HkIpoInfo[]>([])
  const [fxRate, setFxRate] = useState<number | undefined>()
  const [page, setPage] = useState(0)
  const [listViewportH, setListViewportH] = useState(0)
  const [ipoTick, setIpoTick] = useState(0)

  // 港股“今天”（HKT）
  const todayHk = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  // 招股中：待上市（含发售价未公布的），尚未上市，或截止时间未过
  const subscribing = hkIpos.filter(ipo =>
    ipo.listingDate && ipo.listingDate >= todayHk
    && (ipo.listingStatus === '待上市' || (ipo.subEndAt ?? 0) > Date.now()))
  const subItem = subscribing.length > 0 ? subscribing[ipoTick % subscribing.length] : undefined

  // 轮播 30 秒（招股中行 / 首日横幅共用节拍）
  const firstDayCount = localStocks.filter(stock => stock.autoAdded).length
  useEffect(() => {
    if (subscribing.length <= 1 && firstDayCount <= 1) return
    const timer = setInterval(() => setIpoTick(tick => tick + 1), 30000)
    return () => clearInterval(timer)
  }, [subscribing.length, firstDayCount])

  // 招股副标题：暗盘日显示暗盘时间，否则显示距截止的倒计时
  const subExtraText = (() => {
    if (!subItem) return ''
    const tomorrowHk = new Date(Date.now() + 24 * 3600 * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
    if (subItem.listingDate === tomorrowHk) {
      return '今日暗盘 16:15-18:30'
    }
    const remainMs = (subItem.subEndAt ?? 0) - Date.now()
    if (remainMs > 0) {
      const remainHours = Math.floor(remainMs / 3600000)
      const days = Math.floor(remainHours / 24)
      const minutes = Math.floor((remainMs % 3600000) / 60000)
      const text = days > 0 ? `${days}天${remainHours % 24}小时` : `${remainHours}小时${minutes}分`
      return `距截止 ${text}`
    }
    return '已截止'
  })()

  // 每 4 小时扫描 cibo.hk 港股新股：
  // 招股中/今日上市信息进入轮播行；
  // 自动加入面板的时机 = 上市首日当天（展示首日表现），首日收盘后自动移除；手动加入的不处理
  const scanHkIpos = useCallback(async () => {
    try {
      const ipos = await fetchActiveHkIpos()
      // 合并已知记录：新股离开招股列表后，其记录保留至上市日过后，供“首日当天自动加入”使用
      const knownHit = await dbCacheGet('hk-ipo:known', 30 * 24 * 3600 * 1000)
      const known: HkIpoInfo[] = knownHit ? JSON.parse(knownHit.payload) : []
      const byCode = new Map(known.map(record => [record.code, record]))
      for (const ipo of ipos) {
        byCode.set(ipo.code, { ...byCode.get(ipo.code), ...ipo })
      }
      const records = [...byCode.values()]
      dbCacheSet('hk-ipo:known', records)
      setHkIpos(records)

      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
      const state = useSelfSelectStockStore.getState()
      await state.loadAll()

      // 自动移除：非首日当天的自动加入行（含首日已收盘的）
      const now = Date.now()
      for (const stock of state.stocks) {
        if (!stock.autoAdded) continue
        const record = records.find(record => record.code === stock.code)
        const listingToday = record ? record.listingDate === today : (stock.autoRemoveAt ?? 0) > now
        if (!listingToday || (stock.autoRemoveAt ?? 0) < now) {
          await useSelfSelectStockStore.getState().deleteStock(stock.code)
        }
      }

      // 名称迁移：修复早期自动加入时名称被存成代码的情况（手动加入的不动）
      for (const record of records) {
        const existingStock = useSelfSelectStockStore.getState().stocks.find(stock => stock.code === record.code)
        if (existingStock?.autoAdded && (!existingStock.name || existingStock.name === existingStock.code) && record.name) {
          await useSelfSelectStockStore.getState().saveStock({ ...existingStock, name: record.name })
        }
      }

      // 自动加入：仅上市首日当天
      await useSelfSelectStockStore.getState().loadAll()
      for (const record of records) {
        if (record.listingDate !== today || record.offerPrice <= 0) continue
        if (useSelfSelectStockStore.getState().stocks.some(stock => stock.code === record.code)) continue
        if (await selfSelectStockRepository.exists(record.code)) continue
        await useSelfSelectStockStore.getState().saveStock(hkIpoToStock(record))
      }
    }
    catch (error) {
      console.warn('[hk-ipo] scan failed:', error)
    }
  }, [])

  useEffect(() => {
    scanHkIpos()
    const timer = setInterval(scanHkIpos, 4 * 3600 * 1000)
    return () => clearInterval(timer)
  }, [scanHkIpos])

  // 港元兑人民币实时汇率，30 分钟刷新
  useEffect(() => {
    getHkdcnyRate().then(setFxRate).catch(() => {})
    const timer = setInterval(() => getHkdcnyRate().then(setFxRate).catch(() => {}), 30 * 60 * 1000)
    return () => clearInterval(timer)
  }, [])

  // A+H：A 股自选匹配同名招股中的 H 股
  const findHkIpo = useCallback((stock: Stock) => {
    if (stock.market !== 'cn' || !stock.name) return undefined
    const name = stock.name.trim()
    if (!name) return undefined
    return hkIpos.find(ipo => ipo.name && (ipo.name === name || ipo.name.includes(name) || name.includes(ipo.name)))
  }, [hkIpos])

  const refreshAllStocks = useCallback(async (stockList: Stock[]) => {
    if (stockList.length === 0) return
    setLoading(true)
    try {
      const results = await Promise.allSettled(
        stockList.map((stock) => EastMoneyStockApi.getByType<Stock>(stock.code, stock.type))
      )
      const refreshed = stockList.map((original, index) => {
        const result = results[index]
        if (result.status === 'fulfilled' && result.value) {
          return {
            ...original,
            ...result.value,
            // 回退数据源（如腾讯）返回的是英文名，保留用户添加时看到的名称
            name: original.name || result.value.name,
            sortOrder: original.sortOrder,
            holdingPrice: original.holdingPrice,
            holdingShares: original.holdingShares,
          }
        }
        return original
      })
      setLocalStocks(refreshed)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  useWidget()

  useEffect(() => {
    if (stocks.length > 0) {
      setLocalStocks(stocks)
      refreshAllStocks(stocks)
    } else {
      setLocalStocks([])
    }
  }, [stocks, refreshAllStocks])

  useInterval(() => {
    if (localStocks.length > 0) {
      refreshAllStocks(localStocks)
    }
  }, refreshInterval)

  // 分页：普通自选行按组件高度自适应；自动加入的首日行合并为一条轮播横幅
  const ROW_HEIGHT = 74
  const PAGER_HEIGHT = 26
  const firstDayStocks = localStocks.filter(stock => stock.autoAdded)
  const normalStocks = localStocks.filter(stock => !stock.autoAdded)
  const rowsPerPage = Math.max(1, Math.floor(Math.max(listViewportH - PAGER_HEIGHT, ROW_HEIGHT) / ROW_HEIGHT))
  const totalPages = Math.max(1, Math.ceil(normalStocks.length / rowsPerPage))
  const safePage = Math.min(page, totalPages - 1)
  const pageStocks = normalStocks.slice(safePage * rowsPerPage, safePage * rowsPerPage + rowsPerPage)

  useEffect(() => {
    const el = sortableRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setListViewportH(entry.contentRect.height)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (sortableRef.current && pageStocks.length > 0) {
      const sortable = Sortable.create(sortableRef.current, {
        animation: 200,
        handle: '.drag-handle',
        onEnd: async (evt) => {
          if (evt.oldIndex !== undefined && evt.newIndex !== undefined && evt.oldIndex !== evt.newIndex) {
            const base = safePage * rowsPerPage
            const oldIndex = base + evt.oldIndex
            const newIndex = base + evt.newIndex
            const autos = localStocks.filter(stock => stock.autoAdded)
            const normals = localStocks.filter(stock => !stock.autoAdded)
            if (oldIndex >= normals.length || newIndex >= normals.length) return
            const newNormals = [...normals]
            const [removed] = newNormals.splice(oldIndex, 1)
            newNormals.splice(newIndex, 0, removed)
            const final = [...newNormals, ...autos]
            setLocalStocks(final)
            await saveOrder(final)
          }
        },
      })
      return () => sortable.destroy()
    }
  }, [pageStocks, localStocks, saveOrder, safePage, rowsPerPage])


  return (
    <WidgetWrapper>
      <StockGlobalStyle />
      <div
        className="stock-widget-root w-full h-full text-white flex flex-col rounded-2xl overflow-hidden pt-2"
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
          <WidgetTitle>
            {widgetTitle}
            {loading && <RefreshIndicator aria-label="刷新中" />}
            {netStale && (
              <span
                className="ml-2 text-[10px] font-normal align-middle text-amber-300/90"
                title="网络异常，当前显示缓存数据（超过 5 分钟）"
              >
                · 网络异常
              </span>
            )}
          </WidgetTitle>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onMouseDown={onGripMouseDown}
              className="opacity-40 hover:opacity-100 hover:bg-white/20 transition-all rounded-lg cursor-move"
              title="按住拖动组件"
              aria-label="拖动组件"
              style={{ WebkitAppRegion: 'no-drag' } as any}
            >
              <GripHorizontal className="h-5 w-5 opacity-100" style={{ color: 'var(--widget-color, inherit)' }} />
            </button>
            <button
                type="button"
                className="opacity-40 hover:opacity-100 transition-all rounded-lg hover:bg-white/10"
                title="设置"
                onClick={() => WidgetApi.openConfigPage()}
              >
                <Settings className="h-5 w-5 opacity-80" style={{ color: 'var(--widget-color, inherit)' }} />
            </button>
          </div>
        </div>

        <MarketTicker refreshInterval={60000} />

        {subItem && (
          <div
            className="mx-3 mb-1 flex items-center justify-between overflow-hidden rounded-lg border border-amber-300/20 bg-amber-400/10 px-3 py-1.5 text-[11px]"
            title="港股招股中"
          >
            <span className="truncate text-amber-100/90">
              <span className="mr-1">📢</span>招股中 {subItem.name} {subItem.code}
            </span>
            <span className="ml-2 shrink-0 tabular-nums text-amber-100/90">
              {subscribing.length > 1 && <span className="mr-1 opacity-80">({subscribing.indexOf(subItem) + 1}/{subscribing.length})</span>}
              {subItem.entryFee ? `一手 HK$${subItem.entryFee.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} · ` : ''}
              {subExtraText}
            </span>
          </div>
        )}

        {firstDayStocks.length > 0 && (() => {
          const idx = ipoTick % firstDayStocks.length
          const stock = firstDayStocks[idx]
          const price = Number.parseFloat(stock.price ?? '') || 0
          const ratio = Number.parseFloat(stock.ratio ?? '') || 0
          const offer = Number.parseFloat(stock.high ?? '')
          return (
            <div
              className="mx-2 mt-1 mb-1 flex items-center justify-between overflow-hidden rounded-lg border border-amber-300/20 bg-amber-400/10 px-3 py-1.5 text-[11px]"
              title="今日上市新股首日表现（收盘后自动移出面板）"
            >
              <span className="truncate text-amber-100/90">
                <span className="mr-1">🚀</span>今日上市 ({idx + 1}/{firstDayStocks.length}) {stock.name} {stock.code}
              </span>
              <span className="ml-2 shrink-0 font-semibold tabular-nums" style={{ color: price > 0 ? getColorByValue(ratio).color : 'var(--widget-color, inherit)' }}>
                {price > 0 ? `${price.toFixed(2)} ${ratio >= 0 ? '+' : ''}${ratio.toFixed(2)}%` : (Number.isFinite(offer) ? `发行价 ${offer}` : '待上市')}
              </span>
            </div>
          )
        })()}

        <div ref={sortableRef} className="flex-1 overflow-y-auto px-2 pb-1 space-y-1.5 mt-1">
          {pageStocks.map((stock, idx) => (
            <StockItem
              key={stock.code}
              stock={stock}
              idx={idx}
              isLast={idx === pageStocks.length - 1}
              metricMode={metricMode}
              getColorByValue={getColorByValue}
              hkIpo={findHkIpo(stock)}
              fxRate={fxRate}
            />
          ))}

          {localStocks.length === 0 && !loading && (
            <div className="text-center py-12 opacity-50 text-sm">
              暂无自选股票
            </div>
          )}

          {localStocks.length === 0 && loading && (
            <div className="text-center py-12 opacity-50 text-sm">
              加载中...
            </div>
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 pb-2 text-[11px]" style={{ color: 'var(--widget-color, inherit)' }}>
            <button
              type="button"
              aria-label="上一页"
              className="opacity-50 hover:opacity-100 disabled:opacity-20"
              disabled={safePage === 0}
              onClick={() => setPage(Math.max(0, safePage - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="tabular-nums opacity-80">{safePage + 1} / {totalPages}</span>
            <button
              type="button"
              aria-label="下一页"
              className="opacity-50 hover:opacity-100 disabled:opacity-20"
              disabled={safePage >= totalPages - 1}
              onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </WidgetWrapper>
  )
}
