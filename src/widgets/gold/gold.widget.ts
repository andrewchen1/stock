import { Widget, WidgetKeyword } from '@widget-js/core'

const GoldWidget = new Widget({
  name: 'cn.stocks.widget.gold',
  title: { 'zh-CN': '黄金价格', 'en-US': 'Gold Price' },
  description: { 'zh-CN': 'AU99.99价格，每分钟刷新一次', 'en-US': 'AU99.99 price, refresh every minute' },
  keywords: [WidgetKeyword.RECOMMEND],
  categories: ['finance'],
  lang: 'zh-CN',
  width: 2,
  height: 2,
  minWidth: 2,
  maxWidth: 2,
  minHeight: 2,
  maxHeight: 2,
  previewImage: '/preview_gold.png',
  socialLinks: [
    { name: 'github', link: 'https://github.com/rtugeek/stock' },
  ],
  path: '/widget/gold',
  configPagePath:
    '/widget/config/gold?width=600&height=500&frame=true&transparent=false',
})

export default GoldWidget
