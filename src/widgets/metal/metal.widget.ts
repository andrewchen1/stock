import { Widget, WidgetKeyword } from '@widget-js/core'

const MetalWidget = new Widget({
  name: 'cn.stocks.widget.metal',
  title: { 'zh-CN': '国际贵金属价格', 'en-US': 'Metals Prices' },
  description: { 'zh-CN': '金/银/铜/铂金价格，每分钟刷新一次', 'en-US': 'Gold / Silver / Copper / Platinum prices, updated every minute' },
  keywords: [WidgetKeyword.RECOMMEND],
  categories: ['finance'],
  lang: 'zh-CN',
  width: 4,
  height: 2,
  minWidth: 4,
  maxWidth: 4,
  minHeight: 2,
  maxHeight: 4,
  previewImage: '/preview_metal.png',
  path: '/widget/metal',
  socialLinks: [
    { name: 'github', link: 'https://github.com/rtugeek/stock' },
  ],
  configPagePath:
    '/widget/config/metal?width=600&height=500&frame=true&transparent=false',
})

export default MetalWidget
