import * as React from 'react'
import { useState, useRef, useEffect } from 'react'
import { TrendingUp, TrendingDown, Loader2 } from 'lucide-react'
import type { Stock } from '@/model/stock'
import { EastMoneyStockApi, goldSearchOptions } from '@/api/eastmoney-stock-api'
import { Input } from '@/components/ui/input'
import { ExchangeTag } from '@/components/exchange-tag'
import { useStockColorStore } from '@/store/use-stock-color-store'
import { cn } from '@/lib/utils'

interface StockSelectProps {
  onSelect: (stock: Stock) => void
  placeholder?: string
  className?: string
  existingCodes?: string[]
  clearOnSelect?: boolean
}

export function StockSelect({
  onSelect,
  placeholder = '输入代码或名称',
  className,
  existingCodes = [],
  clearOnSelect = true,
}: StockSelectProps) {
  const [keyword, setKeyword] = useState('')
  const [options, setOptions] = useState<Stock[]>([])
  const [loading, setLoading] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { getColorByValue } = useStockColorStore()

  const search = async (query: string) => {
    if (!query.trim()) {
      setOptions([])
      setShowDropdown(false)
      return
    }

    setLoading(true)
    try {
      const emResults: Stock[] = await EastMoneyStockApi.selfSelect(query)
      const results: Stock[] = [...emResults, ...goldSearchOptions(query)]
      setOptions(results)
      setShowDropdown(results.length > 0)
    }
    catch {
      setOptions([])
      setShowDropdown(false)
    }
    finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    if (keyword.trim()) {
      debounceRef.current = setTimeout(() => {
        search(keyword)
      }, 300)
    }
    else {
      setOptions([])
      setShowDropdown(false)
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [keyword])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSelect = (stock: Stock) => {
    onSelect(stock)
    if (clearOnSelect) {
      setKeyword('')
      setOptions([])
      setShowDropdown(false)
    }
  }

  return (
    <div
      ref={containerRef}
      className={cn('relative shrink-0', className)}
      style={{ width: 200, minWidth: 200, maxWidth: 200 }}
    >
      <div style={{ position: 'relative' }}>
        <Input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onFocus={() => options.length > 0 && setShowDropdown(true)}
          placeholder={placeholder}
          className="pr-9"
        />
        {loading && (
          <Loader2
            className="pointer-events-none animate-spin text-muted-foreground"
            style={{
              position: 'absolute',
              top: '50%',
              right: 8,
              width: 14,
              height: 14,
              transform: 'translateY(-50%)',
            }}
            aria-label="搜索中"
          />
        )}
      </div>

      {showDropdown && options.length > 0 && (
        <div
          className="absolute z-50 mt-1 w-full overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
          style={{ maxHeight: 240 }}
        >
          {options.map((stock) => {
            const exists = existingCodes.includes(stock.code)

            return (
              <div
                key={stock.code}
                className={cn(
                  'flex items-center gap-2 px-2 py-2 transition-colors',
                  exists
                    ? 'opacity-50 cursor-not-allowed'
                    : 'cursor-pointer hover:bg-accent'
                )}
                onClick={() => !exists && handleSelect(stock)}
              >
                <ExchangeTag
                  exchange={stock.exchange}
                  style={{ width: 18, height: 12 }}
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{stock.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{stock.code}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
