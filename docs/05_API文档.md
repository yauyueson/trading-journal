# Trading Journal - API文档

> 最后更新: 2026年2月12日  
> **重大更新**: MarketData.app 集成完成

## 📋 目录

1. [API概述](#api概述)
2. [数据源配置](#数据源配置)
3. [期权价格API](#期权价格api)
4. [期权扫描API](#期权扫描-api-oss-scanner)
5. [策略推荐API](#策略推荐-api)
6. [财报数据API](#财报数据api)
7. [Supabase REST API](#supabase-rest-api)
8. [错误处理](#错误处理)

---

## 🌐 API概述

### API架构

```
Frontend (React)
    ↓
Vercel Serverless Functions
    ├── MarketData.app (主数据源) - 实时报价 + 交易所级 Greeks
    └── CBOE (备用数据源) - 15分钟延迟
    ↓
Supabase PostgreSQL (数据存储)
```

### 端点列表

| 端点 | 方法 | 用途 | MarketData | 状态 |
|------|------|------|------------|------|
| `/api/option-price` | GET | 获取单份期权价格、Greeks 及 OSS 评分 | ✅ | ✅ 生产 |
| `/api/scan-options` | GET | OSS v2.3 扫描器，获取高分单腿合约列表 | ✅ | ✅ 生产 |
| `/api/strategy-recommend` | GET | 策略推荐引擎（价差/组合策略专用） | ✅ | ✅ 生产 |
| `/api/check-alerts` | GET | 止损/目标价 Discord 自动提醒 | ✅ | ✅ 生产 |
| `/api/daily-recap` | GET | 每日持仓汇总 Discord 消息 | ✅ | ✅ 生产 |
| `/api/underlying-rv` | GET | 标的已实现波动率（Nasdaq 历史） | - | ✅ 生产 |
| `/api/earnings` | GET | 获取财报日期（通过 Nasdaq API） | - | ✅ 生产 |
| `/api/health` | GET | 健康检查，返回 `{ ok: true, time: ... }` | - | ✅ 生产 |

**评分逻辑统一**：所有 API 均引用 `api/_shared/scoring.cjs`，与前端 `src/lib/oss-core.ts` 逻辑镜像，保证扫描结果、策略推荐与持仓卡片 OSS 分数一致。

---

## 🔧 数据源配置

### 环境变量

**开发环境** (`.env.local`):
```bash
DATA_SOURCE=MARKET_DATA
MARKET_DATA_TOKEN=your_api_token_here
```

**生产环境** (Vercel Dashboard):
```
Settings → Environment Variables
├── DATA_SOURCE = MARKET_DATA
└── MARKET_DATA_TOKEN = your_production_token
```

### 数据源对比

| 特性 | MarketData.app | CBOE |
|------|----------------|------|
| **Greeks 精度** | 交易所级 | 全为 0 |
| **价格延迟** | 实时 | 15 分钟 |
| **IV 数据** | 完整曲线 | 不完整 |
| **速率限制** | 稳定 | 429 频繁 |
| **成本** | 付费 | 免费 |

### 数据格式

**MarketData 格式**:
```json
{
  "symbol": "SPY260320C00680000",
  "strike": 680,
  "type": "Call",
  "expiration": "2026-03-20",
  "dte": 36,
  "bid": 16.35,
  "ask": 16.42,
  "last": 16.38,
  "delta": 0.5247,
  "gamma": 0.0103,
  "theta": -0.1752,
  "vega": 0.9251,
  "iv": 0.1681,
  "volume": 19,
  "openInterest": 17
}
```

**CBOE 格式** (备用):
```json
{
  "option": "SPY  260320C00680000",
  "bid": 16.35,
  "ask": 16.42,
  "last_trade_price": 16.38,
  "delta": 0,
  "gamma": 0,
  "theta": 0,
  "vega": 0,
  "iv": 0,
  "volume": 19,
  "open_interest": 17
}
```

---

## 📊 期权价格API

### 端点

```
GET /api/option-price
```

### 用途

获取指定期权合约的实时价格、Greeks和流动性数据。**优先使用 MarketData.app**，失败时自动降级到 CBOE。

### 参数

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| ticker | string | ✅ | 股票代码（大写） | QQQ, SPY, AAPL |
| expiration | string | ✅ | 到期日（YYYY-MM-DD） | 2026-02-20 |
| strike | number | ✅ | 行权价 | 630 |
| type | string | ✅ | 期权类型 | Call 或 Put |

### 响应格式

**成功响应 (200 OK)**:
```json
{
  "success": true,
  "symbol": "QQQ260220C00630000",
  "price": 7.36,
  "dataSource": "MARKET_DATA",
  "bid": 7.32,
  "ask": 7.39,
  "lastPrice": 7.35,
  "delta": 0.3999,
  "gamma": 0.0123,
  "theta": -0.0456,
  "vega": 0.0789,
  "iv": 0.1778,
  "volume": 6485,
  "openInterest": 29600,
  "underlyingPrice": 620.24,
  "timestamp": 1707350400000
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| dataSource | string | 数据来源：'MARKET_DATA' 或 'CBOE' |
| delta | number | Delta值（-1到1）**MarketData 提供真实值** |
| gamma | number | Gamma值 **MarketData 提供真实值** |
| theta | number | Theta值（每日衰减）**MarketData 提供真实值** |
| vega | number | Vega值（IV敏感度）**MarketData 提供真实值** |
| iv | number | 隐含波动率（小数形式）**MarketData 提供真实值** |

---

## 🔍 期权扫描 API (OSS Scanner)

### 端点

```
GET /api/scan-options
```

### 用途

根据 OSS v2.3 算法扫描全链期权，返回经过数学评估后的最佳契约。**使用 MarketData.app 获取真实 Greeks**。

### 数据源优势

使用 MarketData 后，扫描器获得：
- ✅ **真实 Delta Bonus**: 精确的 ATM 奖励计算
- ✅ **精准 Lambda**: 基于真实 delta 的杠杆率
- ✅ **准确 Gamma/Theta**: 不再是估算值
- ✅ **完整 IV 数据**: 支持 IV Ratio 计算

### 参数

| 参数 | 类型 | 必填 | 说明 | 默认值 |
|------|------|------|------|---------|
| ticker | string | ✅ | 股票代码 | - |
| strategy | string | ❌ | 策略类型 ('long', 'short') | 'long' |
| dteMin | number | ❌ | 最小 DTE | 20 |
| dteMax | number | ❌ | 最大 DTE | 60 |
| limit | number | ❌ | 返回结果数量上限 | 20 |

---

## 🤖 策略推荐 API

### 端点

```
GET /api/strategy-recommend
```

### 用途

基于 IV 环境和用户方向偏好，智能生成 Credit Spread、Debit Spread 和 Long Option 策略。**使用 MarketData.app 构建完整 IV Term Structure**。

### MarketData 增强功能

**新增响应字段** - `regime.ivSurface`:
```json
{
  "regime": {
    "ivRatio": 0.982,
    "iv30": 18.5,
    "iv90": 18.8,
    "mode": "NEUTRAL",
    "advice": "...",
    "ivSurface": {
      "iv7": 17.7,
      "iv14": 18.2,
      "iv30": 17.4,
      "iv60": 17.0,
      "iv90": 17.2,
      "iv120": 17.5,
      "anomaly": false,
      "anomalyRatio": null
    }
  }
}
```

**异常检测**:
- 当 `ivSurface.anomaly = true` 时，表示检测到短期 IV 异常飙升
- 可能原因：即将到来的财报或重大事件
- `anomalyRatio`: IV7/IV30 比率（> 1.3 触发异常）

### 参数

| 参数 | 类型 | 必填 | 说明 | 默认 |
|------|------|------|------|------|
| ticker | string | ✅ | 股票代码 | - |
| direction | string | ❌ | 方向偏好 `BULL` 或 `BEAR` | `BULL` |
| targetDte | number | ❌ | 目标 DTE 档位（14/30/45/90） | `30` |

---

## 🔔 止损/目标价提醒 API

### 端点

```
GET /api/check-alerts
```

### MarketData 集成

**实时价格监控**:
- ✅ 使用 MarketData.app 获取当前价格（无延迟）
- ✅ 支持多腿策略的 Net Value 计算
- ✅ 自动降级到 CBOE（如果 MarketData 失败）

---

## 📅 每日汇总 API

### 端点

```
GET /api/daily-recap
```

### MarketData 集成

**Discord 每日报告增强**:
- ✅ 实时持仓价格（非 15 分钟延迟）
- ✅ 精确 P&L 计算
- ✅ 支持 CBOE 备用数据源

---

## 🧪 测试指南

### 本地测试

**直接 API 测试**:
```bash
node _test_strategy.js
```

**验证项**:
- ✅ `dataSource: "MARKET_DATA"`
- ✅ Greeks 非零
- ✅ `ivSurface` 对象存在

### Vite 开发环境限制

```bash
npm run dev  # ⚠️ 使用简化的 CBOE 处理器
```

**注意**: Vite dev 不包含 MarketData 集成。完整测试需要部署到 Vercel。

### Vercel 部署测试

```bash
# 预览部署
vercel

# 生产部署
vercel --prod
```

---

## 📚 相关文档

- [09_MarketData集成.md](./09_MarketData集成.md) - MarketData 集成详解
- [MARKETDATA_DEV_GUIDE.md](../MARKETDATA_DEV_GUIDE.md) - 开发者测试指南
- [03_核心算法.md](./03_核心算法.md) - 算法详解

---

*文档维护者: Trading Journal Team*  
*最后更新: 2026年2月12日*
