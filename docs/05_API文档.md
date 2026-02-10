# Trading Journal - API文档

> 最后更新: 2026年2月8日

## 📋 目录

1. [API概述](#api概述)
2. [期权价格API](#期权价格api)
3. [期权扫描API](#期权扫描-api-oss-scanner)
4. [财报数据API](#财报数据api)
5. [Supabase REST API](#supabase-rest-api)
6. [错误处理](#错误处理)

---

## 🌐 API概述

### API架构

```
Frontend (React)
   - **Vite (Low-Level Proxy/Plugin)**: 处理 `/api` 路由，模拟 Serverless Functions 环境
- **Supabase (BaaS)**: 本身提供 REST API 和数据库存储
    ↓
Supabase PostgreSQL (数据存储)
```

### 端点列表

| 端点 | 方法 | 用途 | 状态 |
|------|------|------|------|
| `/api/option-price` | GET | 获取单份期权价格、Greeks 及 OSS 评分 | ✅ 生产 |
| `/api/scan-options` | GET | OSS v2.1 扫描器，获取高分单腿合约列表 | ✅ 生产 |
| `/api/strategy-recommend` | GET | 策略推荐引擎（价差/组合策略专用） | ✅ 生产 |
| `/api/underlying-rv` | GET | 标的已实现波动率（Nasdaq 历史） | ✅ 生产 |
| `/api/earnings` | GET | 获取财报日期（通过 Nasdaq API） | ✅ 生产 |
| `/api/check-alerts` | GET | 止损/目标价 Discord 自动提醒（需 CRON_SECRET 鉴权） | ✅ 生产 |
| `/api/health` | GET | 健康检查，返回 `{ ok: true, time: ... }` | ✅ 生产 |

**评分逻辑统一**：`/api/scan-options` 与 `/api/strategy-recommend` 均引用 `api/_shared/scoring.js`，与前端 `src/lib/oss-core.ts` 逻辑镜像，保证扫描结果、策略推荐与持仓卡片 OSS 分数一致。

---

## 📊 期权价格API

### 端点

```
GET /api/option-price
```

### 用途

获取指定期权合约的实时价格、Greeks和流动性数据

### 参数

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| ticker | string | ✅ | 股票代码（大写） | QQQ, SPY, AAPL |
| expiration | string | ✅ | 到期日（YYYY-MM-DD） | 2026-02-20 |
| strike | number | ✅ | 行权价 | 630 |
| type | string | ✅ | 期权类型 | Call 或 Put |

### 请求示例

```bash
# cURL
curl "https://your-domain.vercel.app/api/option-price?ticker=QQQ&expiration=2026-02-20&strike=630&type=Call"

# JavaScript Fetch
const response = await fetch(
  '/api/option-price?ticker=QQQ&expiration=2026-02-20&strike=630&type=Call'
);
const data = await response.json();

# TypeScript
interface OptionPriceParams {
  ticker: string;
  expiration: string;
  strike: number;
  type: 'Call' | 'Put';
}

async function getOptionPrice(params: OptionPriceParams) {
  const url = new URL('/api/option-price', window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.append(key, String(value));
  });
  
  const response = await fetch(url);
  return response.json();
}
```

### 响应格式

**成功响应 (200 OK)**:
```json
{
  "success": true,
  "symbol": "QQQ   260220C00630000",
  "price": 7.36,
  "score": 85,
  "metrics": {
    "lambda": 33.7,
    "gammaEff": 0.0016,
    "thetaBurn": 0.0062,
    "isDayTrade": false,
    "ivRatio": 0.985
  },
  "bid": 7.32,
  ...
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| success | boolean | 请求是否成功 |
| symbol | string | OCC标准期权代码 |
| price | number | 计算后的价格（优先mid） |
| priceSource | string | 价格来源：'mid' 或 'last' |
| bid | number | 买入价 |
| ask | number | 卖出价 |
| lastPrice | number | 最后成交价 |
| iv | number | 隐含波动率（小数形式，0.1778 = 17.78%） |
| delta | number | Delta值（-1到1） |
| gamma | number | Gamma值 |
| theta | number | Theta值（每日衰减） |
| vega | number | Vega值（IV敏感度） |
| rho | number | Rho值（利率敏感度） |
| volume | number | 当日成交量 |
| openInterest | number | 未平仓合约数 |
| underlyingPrice | number | 标的股票当前价格 |
| dataSource | string | 数据来源（CBOE） |
| timestamp | number | 时间戳（毫秒） |

### 错误响应

**400 Bad Request - 缺少参数**:
```json
{
  "error": "Missing parameters"
}
```

**404 Not Found - 合约不存在**:
```json
{
  "error": "Option contract not found",
  "symbol": "QQQ   260220C00630000",
  "ticker": "QQQ"
}
```

**500 Internal Server Error - 服务器错误**:
```json
{
  "error": "Internal Server Error",
  "message": "CBOE API timeout"
}
```

### 数据源 (CBOE Integration)

**CBOE (Chicago Board Options Exchange)**:
- **URL**: `https://cdn.cboe.com/api/global/delayed_quotes/options/{TICKER}.json`
- **延迟**: 15分钟
- **安全性要求**: 必须在请求头中包含有效的 `Referer` 和 `Origin` (通常为 `https://www.cboe.com`)，否则会返回 403 Forbidden。

**Vercel Proxy 实现**:
```javascript
const response = await fetch(url, {
  headers: {
    'Referer': 'https://www.cboe.com/options/quotes/',
    'Origin': 'https://www.cboe.com'
  }
});
```

---

## 🤖 策略推荐 API (Strategy Recommender)

### 端点
```
GET /api/strategy-recommend
```

### 用途
基于 IV 环境（IV30/IV90 期限结构、IV/RV 比）和用户方向偏好，智能生成 Credit Spread、Debit Spread 和 Long Option 策略，并统一评分排序（Top Picks）。

### 参数
| 参数 | 类型 | 必填 | 说明 | 默认 |
|------|------|------|------|------|
| ticker | string | ✅ | 股票代码 | - |
| direction | string | | 方向偏好 `BULL` 或 `BEAR` | `BULL` |
| targetDte | number | | 目标 DTE 档位（14/30/45/90） | `30` |
| spreadWidth | number | | 价差宽度（美元），如 2.5/5/10/20 | 不传=Credit `[5,10]` / Debit `[2.5,5]` |

当传入 `spreadWidth` 时，Credit 和 Debit 均只使用该单一宽度（而非默认的多宽度组合）。

### 响应格式
```json
{
  "success": true,
  "context": { "ticker": "SPY", "currentPrice": 600.50, "direction": "BULL", "targetDte": 30, "daysUntilEarnings": null },
  "regime": { "ivRatio": 0.982, "iv30": 18.5, "iv90": 18.8, "rv30": 15.2, "ivRvRatio": 1.217, "mode": "NEUTRAL", "advice": "...", "adviceDetail": "..." },
  "recommendedStrategy": "CREDIT_SPREAD",
  "strategies": {
    "CREDIT_SPREAD": [ { "type": "Credit Put Spread", "shortLeg": {...}, "longLeg": {...}, "width": 5, "netCredit": 1.01, "maxRisk": 3.99, "roi": 25.3, "pop": 68.3, "expectedValue": 0.42, "breakeven": 578.99, "score": 73, "whyThis": "..." } ],
    "DEBIT_SPREAD": [...],
    "SINGLE_LEG": [...],
    "TOP_PICKS": [{ "...同上字段...", "strategyCategory": "CREDIT_SPREAD", "unifiedScore": 78 }]
  }
}
```

### OCC Symbol生成

**格式**: `TICKER  YYMMDDC########`

**组成**:
- **TICKER**: 股票代码，6字符（右侧空格填充）
- **YYMMDD**: 到期日（年月日）
- **C/P**: 期权类型（C=Call, P=Put）
- **########**: 行权价×1000，8位数字（左侧0填充）

**示例**:
```
QQQ   260220C00630000
^^^   ^^^^^^ ^^^^^^^^
股票  日期   类型+行权价

解析:
- Ticker: QQQ (3字符 + 3空格)
- Expiration: 2026-02-20
- Type: Call
- Strike: 630.00
```

**代码实现**:
```javascript
function generateOCCSymbol(symbol, expiration, type, strike) {
  // 1. 股票代码（6字符，右侧空格填充）
  const paddedSymbol = symbol.toUpperCase().padEnd(6, ' ');
  
  // 2. 日期（YYMMDD）
  const [year, month, day] = expiration.split('-');
  const dateStr = `${year.slice(2)}${month}${day}`;
  
  // 3. 类型（C或P）
  const typeCode = type.toLowerCase().startsWith('c') ? 'C' : 'P';
  
  // 4. 行权价（×1000，8位数字）
  const strikeNum = Math.round(parseFloat(strike) * 1000);
  const strikeStr = strikeNum.toString().padStart(8, '0');
  
  return `${paddedSymbol}${dateStr}${typeCode}${strikeStr}`;
}

// 示例
generateOCCSymbol('QQQ', '2026-02-20', 'Call', 630);
// 返回: "QQQ   260220C00630000"
```

### 价格计算逻辑

**优先级**:
1. **Mid Price** (bid + ask) / 2 - 最准确
2. **Last Price** - 降级方案

**代码实现**:
```javascript
function calculatePrice(option) {
  let price = option.last_trade_price;
  let source = 'last';
  
  // 如果有有效的bid和ask，使用mid price
  if (option.bid > 0 && option.ask > 0) {
    price = (option.bid + option.ask) / 2;
    source = 'mid';
  }
  
  return { price, source };
}
```

### 使用示例

**React组件中使用**:
```typescript
import { useState } from 'react';

interface OptionData {
  price: number;
  delta: number;
  iv: number;
  // ... 其他字段
}

function PositionCard({ position }) {
  const [loading, setLoading] = useState(false);
  const [optionData, setOptionData] = useState<OptionData | null>(null);
  
  const fetchPrice = async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/option-price?ticker=${position.ticker}&expiration=${position.expiration}&strike=${position.strike}&type=${position.type}`
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch price');
      }
      
      const data = await response.json();
      setOptionData(data);
      
      // 更新数据库
      await updatePosition(position.id, {
        current_price: data.price
      });
      
    } catch (error) {
      console.error('Error fetching price:', error);
      alert('Failed to fetch price. Please try again.');
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div>
      <button onClick={fetchPrice} disabled={loading}>
        {loading ? 'Loading...' : '🔄 Refresh Price'}
      </button>
      {optionData && (
        <div>
          <p>Price: ${optionData.price}</p>
          <p>Delta: {optionData.delta}</p>
          <p>IV: {(optionData.iv * 100).toFixed(2)}%</p>
        </div>
      )}
    </div>
  );
}
```

---

## 🔍 期权扫描 API (OSS Scanner)

### 端点

```
GET /api/scan-options
```

### 用途

根据 OSS v2.1 算法扫描全链期权，返回经过数学评估后的最佳契约。

### 参数

| 参数 | 类型 | 必填 | 说明 | 默认值 |
|------|------|------|------|------|
| ticker | string | ✅ | 股票代码 | - |
| strategy | string | ❌ | 策略类型 ('long', 'short') | 'long' |
| dteMin | number | ❌ | 最小 DTE | 20 |
| dteMax | number | ❌ | 最大 DTE | 60 |
| strikeRange | number | ❌ | 行权价抓取范围 (百分比) | 0.25 (25%) |
| limit | number | ❌ | 返回结果数量上限 | 20 |
| minDelta | number | ❌ | 最小 Delta | 0 |
| maxDelta | number | ❌ | 最大 Delta | 1 |
| direction | string | ❌ | 方向 ('all', 'call', 'put') | 'all' |
| dayTrade | boolean| ❌ | 是否开启日内模式 (权重优化) | false |
| minVolume | number | ❌ | 最小成交量限制 | 50 |

### 响应示例

```json
{
  "success": true,
  "context": {
    "ticker": "QQQ",
    "currentPrice": 620.24,
    "ivRatio": 0.982,
    "ivStatus": "contango",
    "strategy": "long"
  },
  "results": [
    {
      "symbol": "QQQ   260220C00630000",
      "score": 85,
      "price": 7.36,
      "metrics": {
        "lambda": 33.7,
        "gammaEff": 0.0016,
        "thetaBurn": 0.0062
      },
      "greeks": { "delta": 0.4, "gamma": 0.012, ... }
    }
  ]
}
```

---

## 📅 财报数据API

### 端点

```
GET /api/earnings
```

### 状态

🚧 **开发中** - 未来功能

### 计划用途

获取公司财报发布日期，用于避免在财报前买入期权

### 计划参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| ticker | string | ✅ | 股票代码 |

### 计划响应

```json
{
  "ticker": "AAPL",
  "nextEarningsDate": "2026-04-28",
  "lastEarningsDate": "2026-01-28",
  "estimatedEPS": 1.52,
  "actualEPS": 1.48
}
```

---

## 🔔 止损/目标价提醒 API (Check Alerts)

### 端点

```
GET /api/check-alerts
```

### 用途

定时检查所有 Active 持仓是否触及止损或目标价，触及则发送 Discord Webhook 提醒。由外部 Cron 服务（cron-job.org）每 15 分钟调用。

### 鉴权

| 方式 | 说明 |
|------|------|
| Query Parameter | `?secret=你的CRON_SECRET` |
| Header | `Authorization: Bearer 你的CRON_SECRET` |

无有效 secret → 返回 `401 Unauthorized`。

### 响应

**200 OK - 正常执行**:
```json
{
  "ok": true,
  "checked": 5,
  "sent": 1
}
```

**200 OK - 无活跃持仓**:
```json
{
  "ok": true,
  "message": "No active positions",
  "sent": 0
}
```

**401 Unauthorized - 鉴权失败**:
```json
{ "error": "Unauthorized" }
```

**500 Internal Server Error - 环境变量缺失**:
```json
{ "error": "DISCORD_WEBHOOK_URL not set" }
```

### 实现细节

- **不使用 `@supabase/supabase-js` SDK**：直接用 `fetch` 调 Supabase REST API（PostgREST），避免 Vercel Serverless 的 ESM import 兼容问题。
- **止损计算**：Debit 策略 = 入场价 × 0.5（或 0.75 如有部分止盈）；Credit 策略 = 入场价 × 1.5。
- **目标价**：优先使用 `positions.target_price`；缺失时 Debit 默认 × 1.25，Credit 默认 × 0.5。
- **当前价**：通过内部调用 `/api/option-price` 获取。
- **仅处理单腿仓位**：价差仓位（legs ≥ 2）暂跳过，后续可扩展。

### 所需环境变量

| 变量 | 说明 |
|------|------|
| `CRON_SECRET` | 鉴权密钥 |
| `DISCORD_WEBHOOK_URL` | Discord Webhook URL |
| `SUPABASE_URL` / `VITE_SUPABASE_URL` | Supabase 项目 URL |
| `SUPABASE_ANON_KEY` / `VITE_SUPABASE_ANON_KEY` | Supabase Anon Key |
| `VERCEL_URL` | 部署域名（Vercel 自动注入） |

---

## ✅ 健康检查 API (Health)

### 端点

```
GET /api/health
```

### 用途

验证 Vercel 部署是否成功。无需鉴权。

### 响应

```json
{ "ok": true, "time": "2026-02-08T00:53:27.326Z" }
```

---

## 🗄️ Supabase REST API

### 概述

Supabase自动为每个表生成RESTful API

**Base URL**: `https://irejefxhgetulqmxponl.supabase.co/rest/v1`

**认证**: 
```
Authorization: Bearer {ANON_KEY}
apikey: {ANON_KEY}
```

### 查询示例

**获取所有活跃持仓**:
```javascript
const { data, error } = await supabase
  .from('positions')
  .select('*')
  .eq('status', 'active')
  .order('created_at', { ascending: false });
```

**等价的REST调用**:
```bash
curl -X GET \
  'https://irejefxhgetulqmxponl.supabase.co/rest/v1/positions?status=eq.active&order=created_at.desc' \
  -H 'apikey: YOUR_ANON_KEY' \
  -H 'Authorization: Bearer YOUR_ANON_KEY'
```

**插入新持仓**:
```javascript
const { data, error } = await supabase
  .from('positions')
  .insert([{
    ticker: 'QQQ',
    strike: 630,
    type: 'Call',
    expiration: '2026-02-20',
    status: 'watchlist'
  }])
  .select();
```

**更新持仓**:
```javascript
const { error } = await supabase
  .from('positions')
  .update({ current_price: 7.36 })
  .eq('id', positionId);
```

**删除持仓**:
```javascript
const { error } = await supabase
  .from('positions')
  .delete()
  .eq('id', positionId);
```

### 高级查询

**关联查询（JOIN）**:
```javascript
const { data, error } = await supabase
  .from('positions')
  .select(`
    *,
    transactions (*)
  `)
  .eq('status', 'active');
```

**聚合查询**:
```javascript
const { data, error } = await supabase
  .from('positions')
  .select('status', { count: 'exact' })
  .eq('status', 'active');
```

**过滤器**:
```javascript
// 等于
.eq('status', 'active')

// 不等于
.neq('status', 'closed')

// 大于
.gt('current_score', 70)

// 小于
.lt('current_score', 60)

// 包含
.in('ticker', ['QQQ', 'SPY', 'AAPL'])

// 模糊匹配
.like('ticker', '%QQ%')

// 范围
.gte('expiration', '2026-02-01')
.lte('expiration', '2026-02-28')
```

---

## ⚠️ 错误处理

### 错误类型

**网络错误**:
```typescript
try {
  const response = await fetch('/api/option-price?...');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
} catch (error) {
  if (error instanceof TypeError) {
    // 网络连接失败
    console.error('Network error:', error);
  } else {
    // HTTP错误
    console.error('API error:', error);
  }
}
```

**Supabase错误**:
```typescript
const { data, error } = await supabase
  .from('positions')
  .select('*');

if (error) {
  console.error('Supabase error:', error.message);
  // error.code: 错误代码
  // error.details: 详细信息
  // error.hint: 修复建议
}
```

### 重试机制

**指数退避**:
```typescript
async function fetchWithRetry(
  url: string, 
  maxRetries = 3,
  baseDelay = 1000
) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      
      // 如果是4xx错误，不重试
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`Client error: ${response.status}`);
      }
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      
      // 指数退避：1s, 2s, 4s
      const delay = baseDelay * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

### 降级策略

**API失败时的备用方案**:
```typescript
async function getOptionPrice(params) {
  try {
    // 尝试API
    const response = await fetch('/api/option-price?...');
    return await response.json();
  } catch (error) {
    console.error('API failed, falling back to manual input');
    
    // 降级：手动输入
    return {
      price: await promptUserForPrice(),
      priceSource: 'manual',
      success: false
    };
  }
}
```

---

## 🔒 安全性

### CORS配置

**Vercel Serverless Functions**:
```javascript
export default async function handler(req, res) {
  // 允许所有来源（开发阶段）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // 处理预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // ... 业务逻辑
}
```

**生产环境**（未来）:
```javascript
// 只允许特定域名
const allowedOrigins = [
  'https://your-domain.vercel.app',
  'https://www.your-domain.com'
];

const origin = req.headers.origin;
if (allowedOrigins.includes(origin)) {
  res.setHeader('Access-Control-Allow-Origin', origin);
}
```

### 速率限制

**未来实现**:
```typescript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 100, // 最多100次请求
  message: 'Too many requests, please try again later.'
});

app.use('/api/', limiter);
```

---

## 📊 监控和日志

### 请求日志

**Vercel Functions**:
```javascript
export default async function handler(req, res) {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log('Query:', req.query);
  
  try {
    // ... 业务逻辑
    console.log('✅ Success');
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}
```

### 性能监控

**未来集成**:
- **Vercel Analytics**: 自动收集性能指标
- **Sentry**: 错误追踪和报警
- **LogRocket**: 用户会话回放

---

## 🧪 测试

### API测试

**使用Postman**:
```
GET https://your-domain.vercel.app/api/option-price
  ?ticker=QQQ
  &expiration=2026-02-20
  &strike=630
  &type=Call
```

**使用cURL**:
```bash
curl -X GET \
  "https://your-domain.vercel.app/api/option-price?ticker=QQQ&expiration=2026-02-20&strike=630&type=Call" \
  -H "Content-Type: application/json"
```

**单元测试**（未来）:
```typescript
import { describe, it, expect } from 'vitest';
import handler from '../api/option-price';

describe('Option Price API', () => {
  it('should return price for valid request', async () => {
    const req = {
      query: {
        ticker: 'QQQ',
        expiration: '2026-02-20',
        strike: '630',
        type: 'Call'
      }
    };
    
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    
    await handler(req, res);
    
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        price: expect.any(Number)
      })
    );
  });
});
```

---

*文档维护者: Trading Journal Team*
*最后更新: 2026年2月8日*
