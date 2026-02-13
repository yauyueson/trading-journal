# Polygon.io 数据源集成说明

## 概述

本项目已从 **MarketData.app** 迁移至 **Polygon.io (MASSIVE)** 作为主要期权数据源。Polygon.io 提供高质量的期权市场数据，包括实时报价、Greeks、隐含波动率等。

---

## 环境配置

### 1. 获取 API Key

1. 访问 [Polygon.io Dashboard](https://polygon.io/dashboard)
2. 注册账号并订阅 **Options Data** plan (建议 Starter 或以上)
3. 复制您的 API Key

### 2. 配置环境变量

在项目根目录的 `.env.local` 文件中添加：

```bash
# 激活 Polygon.io 数据源
DATA_SOURCE=POLYGON

# 填入您的 Polygon.io API Key
POLYGON_API_KEY=your_polygon_api_key_here
```

> **重要提示**：
> - 确保您的 subscription plan 包含 **Options Advanced Features** (Greeks、IV)
> - 查看您的速率限制，避免在高频场景下触发限流

---

## API 功能支持

Polygon.io 通过以下端点提供期权数据：

### 核心端点

| 功能 | Polygon.io 端点 | 说明 |
|------|----------------|------|
| **期权链** | `GET /v3/reference/options/contracts` | 获取可用的期权合约列表 |
| **期权快照** | `GET /v3/snapshot/options/{underlying}/{contract}` | 获取单个期权的实时数据、Greeks、IV |
| **批量快照** | 多次调用 snapshot 端点 | Polygon 不支持真正的批量查询 |
| **历史K线** | `GET /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}` | 用于计算 Realized Volatility |

### 数据字段映射

| 数据 | Polygon.io 路径 | 内部标准化格式 |
|------|----------------|---------------|
| OCC 符号 | `details.ticker` | `symbol` |
| 行权价 | `details.strike_price` | `strike` (Number) |
| 类型 | `details.contract_type` ("call"/"put") | `type` ("Call"/"Put") |
| 到期日 | `details.expiration_date` (YYYY-MM-DD) | `expiration` (YYYY-MM-DD) |
| Bid/Ask | `last_quote.bid` / `last_quote.ask` | `bid` / `ask` |
| 最新价 | `last_trade.price` | `last` |
| Delta | `greeks.delta` | `delta` |
| Gamma | `greeks.gamma` | `gamma` |
| Theta | `greeks.theta` | `theta` |
| Vega | `greeks.vega` | `vega` |
| IV | `greeks.implied_volatility` | `iv` |
| 成交量 | `day.volume` | `volume` |
| 持仓量 | `open_interest` | `openInterest` |
| 标的价格 | `underlying_asset.price` | `underlyingPrice` |

---

## API 用量优化（仅请求所需到期/行权 + 缓存）

为减少 payload 与 API 调用量，以下行为已落地：

| API | 行为 |
|-----|------|
| **strategy-recommend** | 先 `getUnderlyingPrice(ticker)`，再仅请求 **DTE 30** 与 **DTE 90** 两段 + **行权价 ±20%**（minStrike/maxStrike），满足 IV 期限结构与策略构建即可。 |
| **scan-options** | 先 `getUnderlyingPrice(ticker)`，再按 `dteMin`/`dteMax` 与 `strikeRange` 传 **minStrike/maxStrike** 给 `getOptionChain`，只拉会用到的行权范围。 |
| **期权链缓存** | `getOptionChain` 对同一 `(ticker, filters)` 结果做 **1 分钟内存缓存**，同一用户短时间重复请求直接命中，降低成本并保持算法一致。 |

详见 `api/polygon-client.js`（`getUnderlyingPrice`、`optionChainCache`、`OPTION_CHAIN_CACHE_TTL_MS`）。

---

## 客户端实现

### 文件路径
`api/polygon-client.js`

### 主要函数

#### `getUnderlyingPrice(ticker)`
获取标的股票当前价格，用于在请求期权链前计算行权范围，从而**仅请求会用到的合约**，减少 payload 与 API 用量。

**实现**：调用 Polygon 股票快照 `GET /v2/snapshot/locale/us/markets/stocks/tickers/{ticker}`，优先使用 `lastTrade` / `lastQuote`，否则使用 `prevDay.close`。

**使用场景**：`strategy-recommend` 与 `scan-options` 在 Polygon 路径下先调用此函数，再按 `minStrike` / `maxStrike` 调用 `getOptionChain`。

---

#### `getExpirations(ticker)`
获取指定股票的所有期权到期日列表。

**实现原理**：
- 调用 `/v3/reference/options/contracts?underlying_ticker={ticker}&limit=1000`
- 从返回的合约中提取唯一的 `expiration_date`
- 按日期排序返回

**示例**：
```javascript
import { getExpirations } from './polygon-client.js';
const expirations = await getExpirations('AAPL');
// 返回: ["2025-03-21", "2025-03-28", "2025-04-18", ...]
```

---

#### `getOptionChain(ticker, filters)`
获取期权链，支持多种过滤条件。

**支持的过滤器**：
```javascript
{
  expiration: "2025-03-21",           // 特定到期日
  minDte: 30,                         // 最小 DTE
  maxDte: 60,                         // 最大 DTE
  dte: 45,                            // 精确 DTE（±1天容差）
  side: "call" | "put",               // 合约类型
  minStrike: 100,                     // 最小行权价
  maxStrike: 200                      // 最大行权价
}
```

**数据增强**：
- 基础数据来自 contracts API（可按 minDte/maxDte、minStrike/maxStrike 过滤）
- 调用 snapshot API 获取实时价格和 Greeks
- 自动计算 DTE（距离到期天数）

**期权链缓存（1 分钟）**：同一 `(ticker, filters)` 的请求结果在内存中缓存 60 秒。同一用户短时间重复请求（如同一 ticker 多次扫描/策略推荐）直接命中缓存，减少 API 调用并保持算法一致。缓存键为 ticker + minDte/maxDte/dte/expiration/side/minStrike/maxStrike。

**示例**：
```javascript
import { getOptionChain } from './polygon-client.js';

// 获取 DTE 30-45 天的 Call 期权
const chain = await getOptionChain('SPY', {
  minDte: 30,
  maxDte: 45,
  side: 'call'
});

// 返回标准化数据
// [{ symbol, strike, type, expiration, dte, bid, ask, delta, gamma, iv, ... }]
```

---

#### `getQuotes(occSymbols[])`
批量获取期权报价。

**注意事项**：
- Polygon.io **不支持**真正的批量查询 API
- 实现方式：并发调用多个 `getOptionSnapshot`
- CHUNK_SIZE = 10（避免触发速率限制）

**示例**：
```javascript
import { getQuotes } from './polygon-client.js';

const symbols = [
  'SPY250321C00580000',
  'SPY250321P00580000',
  'AAPL250321C00175000'
];

const quotes = await getQuotes(symbols);
// 返回: [{ symbol, strike, bid, ask, delta, iv, ... }, ...]
```

---

#### `getCandles(ticker, from, to, timespan)`
获取历史K线数据（用于计算 RV30）。

**参数**：
- `ticker`: 股票代码（如 "AAPL"）
- `from`: 起始日期 "YYYY-MM-DD"
- `to`: 结束日期 "YYYY-MM-DD"
- `timespan`: "day" | "hour" | "minute"

**示例**：
```javascript
import { getCandles } from './polygon-client.js';

const candles = await getCandles('SPY', '2025-01-01', '2025-02-12', 'day');
// 返回: [{ date, open, high, low, close, volume }, ...]
```

---

#### `getOptionSnapshot(underlying, occSymbol)`
获取单个期权的完整快照数据。

**示例**：
```javascript
import { getOptionSnapshot } from './polygon-client.js';

const snapshot = await getOptionSnapshot('SPY', 'SPY250321C00580000');
// 返回: { symbol, strike, bid, ask, delta, gamma, theta, vega, iv, ... }
```

---

## IV Rank 历史回填 (RV30 Proxy)

由于项目从 MarketData 迁移到 Polygon，历史 IV 数据在新表中不再自动可用。本项目采用 **30日已实现波动率 (RV30)** 作为历史 **IV30** 的代理指标（Proxy）来生成初始 IV Rank 历史。

### 回填脚本
`api/setup-iv-rank.js`

### 核心逻辑
1. **获取历史 K 线**：调用 Polygon `getCandles` 获取过去 400 天的每日收盘价。
2. **计算 RV30**：使用 30 日对数收益率的年化波动率（Standard Deviation of Log Returns）。
3. **Upsert 到 Supabase**：将计算出的 RV30 存入 `ticker_iv_snapshots` 表的 `iv30` 字段。

### 使用方法
由于 Polygon 免费/入门版 API 有速率限制 (5 req/min)，脚本内置了 15 秒延时和逐条 UPSERT 机制以确保 100% 成功率。

```bash
# 修改脚本中的 tickers 列表
# 运行回填
node api/setup-iv-rank.js
```

### 已覆盖标的
已成功回填以下标的各 200+ 天的历史数据：
`SPY`, `QQQ`, `MSFT`, `META`, `TSLA`, `AMD`, `COST`, `IREN`

---

## 速率限制与优化

### 当前策略

1. **缓存机制**：
   - 内存缓存（5 秒 TTL）
   - 相同请求在 5 秒内返回缓存数据

2. **并发控制**：
   - 批量请求分块处理（CHUNK_SIZE = 10）
   - 使用 `Promise.all()` 并发执行

3. **降级处理**：
   - Polygon 失败时自动 fallback 到 CBOE 免费延迟数据

### 建议优化（生产环境）

```javascript
// 实现请求队列（防止突发流量）
class RateLimiter {
  constructor(maxPerSecond) {
    this.maxPerSecond = maxPerSecond;
    this.queue = [];
    this.processing = false;
  }

  async execute(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    const { fn, resolve, reject } = this.queue.shift();
    
    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      setTimeout(() => {
        this.processing = false;
        this.processQueue();
      }, 1000 / this.maxPerSecond);
    }
  }
}
```

---

## 错误处理

### 常见错误码

| 错误码 | 含义 | 解决方案 |
|--------|------|---------|
| **401** | API Key 无效或未授权 | 检查 `.env.local` 中的 `POLYGON_API_KEY` |
| **429** | 超出速率限制 | 升级 subscription plan 或优化请求频率 |
| **404** | 期权合约不存在 | 验证 OCC 符号格式和到期日 |
| **500** | Polygon 服务器错误 | 启用 CBOE fallback 或稍后重试 |

### 示例：API Key 未配置

**错误信息**：
```json
{
  "error": "POLYGON_API_KEY not configured",
  "message": "Set POLYGON_API_KEY in .env.local"
}
```

**解决方案**：
1. 确认 `.env.local` 文件存在
2. 添加 `POLYGON_API_KEY=your_key_here`
3. 重启开发服务器 `npm run dev`

---

## 数据质量对比

### Polygon.io vs MarketData.app vs CBOE

| 特性 | Polygon.io | MarketData.app | CBOE (免费) |
|------|-----------|----------------|-------------|
| **实时性** | 实时（付费） | 实时 | 延迟 15 分钟 |
| **Greeks** | ✅ 完整 | ✅ 完整 | ❌ 无 |
| **IV** | ✅ 是 | ✅ 是 | ❌ 无 |
| **批量查询** | ❌ 需并发 | ✅ 支持 | ❌ 单个请求 |
| **速率限制** | 根据 plan | 根据 plan | 无明确限制 |
| **成本** | $$ (Starter $99/月) | $ | 免费 |
| **数据覆盖** | 全市场 | 全市场 | 仅部分股票 |

---

## 调试工具

### 1. 调试脚本

创建 `debug-polygon.js`：
```javascript
import { getOptionChain, getExpirations } from './api/polygon-client.js';

async function test() {
  console.log('Testing Polygon.io integration...\n');
  
  // 测试到期日获取
  const expirations = await getExpirations('SPY');
  console.log('SPY Expirations:', expirations.slice(0, 5));
  
  // 测试期权链
  const chain = await getOptionChain('AAPL', { dte: 30 });
  console.log('\nAAPL Chain (DTE 30):', chain.slice(0, 3));
  
  // 检查 Greeks
  if (chain.length > 0) {
    const sample = chain[0];
    console.log('\nSample Option Greeks:');
    console.log('  Delta:', sample.delta);
    console.log('  Gamma:', sample.gamma);
    console.log('  Theta:', sample.theta);
    console.log('  Vega:', sample.vega);
    console.log('  IV:', sample.iv);
  }
}

test().catch(console.error);
```

运行：
```bash
node debug-polygon.js
```

### 2. API 端点测试

```bash
# 测试 Scanner
curl "http://localhost:5177/api/scan-options?ticker=SPY&strategy=long&dteMin=30&dteMax=45"

# 测试 Strategy Recommender
curl "http://localhost:5177/api/strategy-recommend?ticker=AAPL&direction=BULL"

# 测试单个期权定价
curl "http://localhost:5177/api/option-price?ticker=SPY&expiration=2025-03-21&strike=580&type=Call"
```

---

## 常见问题 (FAQ)

### Q1: 为什么我的 Greeks 都是 0？

**A**: 可能的原因：
1. ❌ Subscription plan 不包含 Options Advanced features → 升级 plan
2. ❌ API Key 权限不足 → 检查 Dashboard 权限设置
3. ❌ 期权合约流动性过低 → Polygon 可能没有该合约的 Greeks 数据

### Q2: Scanner 返回空结果怎么办？

**A**: 检查步骤：
1. 确认 `DATA_SOURCE=POLYGON` 已设置
2. 查看控制台日志，确认 API 调用成功
3. 尝试更宽松的过滤条件（扩大 DTE 范围）
4. 检查标的股票是否有期权交易

### Q3: 如何监控 API 使用量？

**A**: 
1. 访问 [Polygon.io Dashboard](https://polygon.io/dashboard/api-usage)
2. 查看 "API Usage" 页面
3. 设置告警（接近限额时通知）

### Q4: Polygon 和 CBOE fallback 如何切换？

**A**: 
- **自动切换**：Polygon 请求失败时，系统自动 fallback 到 CBOE
- **手动切换**：修改 `.env.local` 中的 `DATA_SOURCE=CBOE`

---

## 成本估算

### Polygon.io Pricing (2025)

| Plan | 价格 | 请求限制 | 适用场景 |
|------|------|---------|---------|
| **Starter** | $99/月 | 5 req/s | 个人开发、小型应用 |
| **Developer** | $249/月 | 25 req/s | 中型应用 |
| **Advanced** | 定制 | 定制 | 高频交易、大型应用 |

### 实际使用估算

**单次 Scanner 调用**：
- 获取期权链：1 个 contracts API 请求
- 获取快照数据：1 个 snapshot API 请求（批量）
- **总计**：~2 个 API 请求

**单次 Strategy Recommender 调用**：
- 获取 2 个 DTE 的期权链：2 个 contracts 请求
- 获取快照数据：2 个 snapshot 请求
- 获取 RV30：1 个 aggregates 请求
- **总计**：~5 个 API 请求

**日均估算（中等使用）**：
- 10 次 Scanner 调用：20 个请求
- 5 次 Strategy 调用：25 个请求
- 5 次 Portfolio 刷新：10 个请求
- **总计**：~55 个请求/天 → Starter plan 绰绰有余

---

## 迁移清单

从 MarketData.app 迁移到 Polygon.io 的完整清单：

- [x] 创建 `api/polygon-client.js`
- [x] 更新 `.env.local` 配置
- [x] 迁移 `api/option-price.js`
- [x] 迁移 `api/scan-options.js`
- [x] 迁移 `api/strategy-recommend.js`
- [x] 迁移 `api/option-prices-bulk.js`
- [x] 迁移 `api/check-alerts.js`
- [x] 迁移 `api/daily-recap.js`
- [x] 迁移 `api/backfill-iv-history.js`
- [x] 实现 `api/setup-iv-rank.js` (Polygon 历史回填脚本)
- [x] 成功回填 SPY, QQQ, MSFT, META, TSLA, AMD, COST, IREN
- [x] 测试 Scanner 功能
- [x] 测试 Strategy Recommender
- [x] 测试 Portfolio 批量加载
- [ ] 测试告警系统（Cron）
- [x] 更新所有技术文档
- [ ] 部署到生产环境

---

## 技术支持

- **Polygon.io 文档**：https://polygon.io/docs/options
- **Community Forum**：https://polygon.io/community
- **Support Email**：support@polygon.io

---

*最后更新：2026-02-12*
