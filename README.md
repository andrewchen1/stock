# StockWidget — Windows 桌面股票/黄金/港股 IPO 组件

常驻桌面的半透明行情小组件（类 Apple Widget 风格），自选股票 + 上金所黄金 + 港股 IPO 打新信息一屏掌握。

> 基于 [rtugeek/stock](https://github.com/rtugeek/stock)（widget-js 生态的股票组件）二次开发：更换数据源、修复搜索、扩展黄金与港股 IPO 打新功能。

![screenshot](public/screenshot.png)

## ✨ 功能

### 行情自选
- **A股 / 港股 / 美股（含粉单 OTC）** 搜索添加：支持代码、拼音缩写、中文名称（如 `002384`、`DSJM`、`腾讯`）
- 实时价格、涨跌额、涨跌幅、盘中最高/最低
- **真实分时图**（每 60 秒刷新），拖动排序，分页显示（每页行数随窗口高度自适应）
- 平盘灰色显示，涨跌配色可切换（红涨绿跌 / 绿涨红跌）
- 持仓份额 / 持仓价 → 收益率 / 收益额展示

### 黄金（上海黄金交易所）
- `Au99.99`、`Au(T+D)`、`mAu(T+D)` 等 SGE 合约，**人民币/克**计价
- 搜索 `黄金` 或 `au` 即可添加，显示现价/最高/最低

### 港股 IPO 打新（数据源：[cibo.hk](https://cibo.hk/zh-CN/index.html)）
- 每 4 小时自动扫描港交所招股中的新股
- **招股中轮播行**：公司名、一手入场费、招股截止倒计时（暗盘日自动切换显示暗盘时间），多只 30 秒轮播并显示 (1/N) 计数
- **A+H 折价**：A+H 两地上市的自选股，行内直接显示 H 股发售价（港元 → 人民币实时汇率折算）与相对 A 股现价的折价比例
- **上市首日**自动加入面板，以琥珀横幅展示首日表现（多只 30 秒轮播 + 1/N 计数），首日收盘后自动移除（手动加入的不受影响）

### 桌面体验
- 半透明玻璃底、置顶、不占任务栏，右上角六点把手**按住拖动**（hover 高亮提示）
- 托盘常驻：显示/隐藏、设置、点击穿透、开机自启
- **点击穿透**：开启后鼠标点击穿过组件直达下层窗口；悬停在按钮上时自动放行
- 顶部**跑马灯**：上证 / 深成 / 恒指 / 日经 / 道指 / 纳指 / 标普 / COMEX黄金 / 布伦特原油 / 美元指数
- 网络异常自动提示（缓存数据超 5 分钟时）
- SQLite 本地缓存兜底：断网 / 数据源限流时不白屏（行情 7 天、黄金 30 天、跑马灯 1 天有效期）
- 代理可配置：自动探测本机 clash（fclash）/ 直连 / 自定义

## 📦 下载安装

从 [Releases](../../releases) 页面下载对应平台的安装包：

| 平台 | 格式 |
|---|---|
| Windows x64 | `StockWidget Setup x64.exe`（安装版）/ 便携版 exe |
| Windows ARM64 | 同上（arm64） |
| macOS Apple Silicon | `.dmg`（arm64） |
| macOS Intel | `.dmg`（x64） |
| Linux | `.AppImage` / `.deb`（x64 / arm64） |

> 推送 `v*` 标签后由 GitHub Actions 自动构建全平台安装包并发布到 Release。

## 🚀 使用

1. 启动后组件出现在桌面，右上角**六点把手**按住可拖动位置
2. 点击 **⚙️ 设置** → 搜索框输入代码/拼音/名称添加自选（如 `002384`、`00700`、`黄金`）
3. 托盘图标右键：显示/隐藏、设置、点击穿透、开机自启、退出
4. 设置窗口内可切换涨跌颜色、刷新间隔、网络代理、点击穿透

## 🔨 从源码构建

```bash
pnpm install
pnpm build                                  # 前端构建（tsc + vite）
pnpm exec electron-builder --win            # Windows 包
pnpm exec electron-builder --mac            # macOS 包
pnpm exec electron-builder --linux          # Linux 包
```

多平台产物也可直接推 `v*` 标签，由 GitHub Actions 自动构建并发布到 Release（见 `.github/workflows/build.yml`）。

## 🌐 数据源与致谢

- 行情/搜索：[东方财富](https://eastmoney.com)（主）、[腾讯财经](https://gu.qq.com)（回退）、[新浪财经](https://finance.sina.com.cn)（黄金/汇率/跑马灯）
- 港股 IPO：[cibo.hk](https://cibo.hk/zh-CN/index.html)
- 黄金：上海黄金交易所（经东财/新浪行情接口）
- 组件框架：[widget-js](https://widgetjs.cn) 生态 · 原始组件 [rtugeek/stock](https://github.com/rtugeek/stock)
- 图标：[fafa.hk](https://fafa.hk)

## ⚠️ 声明

- 本项目仅供个人学习与盯盘辅助，行情数据来自第三方公开接口，不保证实时性与准确性，不构成任何投资建议
- 原始项目未声明开源许可证，本仓库内容仅供个人使用，请勿商用
