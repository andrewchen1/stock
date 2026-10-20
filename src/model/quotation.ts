import type { NewMarketData } from '@/api/eastmoney-stock-api'

export interface PankouInfos {
  indicatorTitle: string
  indicatorUrl: string
  list: PankouInfo[]
}

export interface PankouInfo {
  ename: string
  name: string
  value: string
  status?: 'up' | 'down'
  originValue: string
}

export interface BuyInfo {
  bidprice: string
  bidvolume: string
}

export interface AskInfo {
  askprice: string
  askvolume: string
}

export interface UpdateInfo {
  text: string
  time: string
  realUpdateTime: string
  timezone: string
  shortZone: string
  time_diff: number
  stockStatus: string
  tradeStatus: string
  tradeStatusCN: string
}

export interface CurrentInfo {
  time: number
  price: string
  ratio: string
  increase: string
  volume: string
  avgPrice: string
  timeKey: string
  amount: string
  show: number
  unit: string
}

export interface BasicInfo {
  exchange: string
  code: string
  name: string
  stockStatus: string
  stock_market_code: string
  stockCode: string
  tradeStatus: string
  tradeStatusCN: string
  logo?: string
  logoType?: string
}

export interface TagInfo {
  desc: string
  imageUrl: string
}

export interface ChartTab {
  text: string
  type: string
  isK: string
  asyncUrl: string
  options?: ChartTab[]
}

export interface TradingCounter {
  code: string
  name: string
  market: string
  counterType: string
  counterTypeCN: string
  selected: number
  url: string
  asyncUrl: string
}

export class Quotation {
  pankouinfos: PankouInfos
  askinfos: AskInfo[]
  buyinfos: BuyInfo[]
  update: UpdateInfo
  cur: CurrentInfo
  basicinfos: BasicInfo
  tag_list: TagInfo[]
  chartTabs: ChartTab[]
  tradingCounters: TradingCounter[]
  foreign_key: string
  releaseDate: string
  useWS: string
  financeType: string
  newMarketData: NewMarketData

  constructor(data: any) {
    this.pankouinfos = data.pankouinfos
    this.askinfos = data.askinfos || []
    this.buyinfos = data.buyinfos || []
    this.update = data.update
    this.cur = data.cur
    this.basicinfos = data.basicinfos
    this.tag_list = data.tag_list || []
    this.chartTabs = data.chartTabs || []
    this.tradingCounters = data.tradingCounters || []
    this.foreign_key = data.foreign_key
    this.releaseDate = data.releaseDate
    this.useWS = data.useWS
    this.financeType = data.financeType
    this.newMarketData = data.newMarketData
  }

  /**
   * 获取当前价格
   */
  getCurrentPrice(): number {
    return Number.parseFloat(this.cur.price)
  }

  /**
   * 获取昨日收盘价格
   */
  getPreClose(): number {
    const preClose = this.pankouinfos.list.find(info => info.ename === 'preClose')
    return Number.parseFloat(preClose?.value ?? '0')
  }

  /**
   * 获取涨跌幅
   */
  getRatio(): number {
    return Number.parseFloat(this.cur.ratio.replace('%', ''))
  }

  /**
   * 获取涨跌额
   */
  getIncrease(): number {
    return Number.parseFloat(this.cur.increase)
  }

  /**
   * 获取成交量
   */
  getVolume(): number {
    return Number.parseFloat(this.cur.volume)
  }

  /**
   * 获取成交额
   */
  getAmount(): string {
    return this.cur.amount
  }

  /**
   * 获取股票状态
   */
  getTradeStatus(): string {
    return this.update.tradeStatusCN
  }

  /**
   * 是否在交易中
   */
  isTrading(): boolean {
    return this.update.tradeStatus === 'TRADE'
  }

  /**
   * 获取买盘价格列表
   */
  getBuyPrices(): number[] {
    return this.buyinfos.map(info => Number.parseFloat(info.bidprice)).filter(price => price > 0)
  }

  /**
   * 获取卖盘价格列表
   */
  getAskPrices(): number[] {
    return this.askinfos.map(info => Number.parseFloat(info.askprice)).filter(price => price > 0)
  }

  /**
   * 获取股票基本信息
   */
  getBasicInfo(): BasicInfo {
    return this.basicinfos
  }

  /**
   * 获取更新时间
   */
  getUpdateTime(): string {
    return this.update.text
  }
}
