# Trading Journal - API文档

> 最后更新: 2026年2月17日  
> **数据源**: Polygon.io（主）/ CBOE（备）；API 用量优化：仅请求所需 DTE/行权 + 期权链缓存；付费档建议设置 `POLYGON_RATE_LIMIT_RPM=100`

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
    ├── Polygon.io (主数据源) - 实时报价 + Greeks + IV；仅请求所需 DTE/行权；1 分钟期权链缓存
    └── CBOE (备用数据源) - 15分钟延迟，免费
    ↓
Supabase PostgreSQL (数据存储)
```

### 端点列表

| 端点 | 方法 | 用途 | 状态 |
|------|------|------|------|
| `/api/option-prices` | GET/POST | 通用价格 API：支持单腿 GET 或多腿 POST 批量获取 | ✅ 生产 |
| `/api/scan-options` | GET | OSS v2.3 扫描器，获取高分单腿合约列表 | ✅ 生产 |
| `/api/strategy-recommend` | GET | 策略推荐引擎（价差/组合策略专用） | ✅ 生产 |
| `/api/check-alerts` | GET | 止损/目标价 Discord 自动提醒 | ✅ 生产 |
| `/api/daily-recap` | GET | 每日持仓汇总 Discord 消息 | ✅ 生产 |
| `/api/batch-refresh-tech` | GET/POST | 批量刷新技术面评分（Tech Score 自动化） | ✅ 生产 |
| `/api/underlying-rv` | GET | 标的已实现波动率（Nasdaq 历史） | ✅ 生产 |
| `/api/earnings` | GET | 获取财报日期（通过 Nasdaq API） | ✅ 生产 |

**评分逻辑统一**：所有 API 均引用 `api/_shared/scoring.cjs`，与前端 `src/lib/oss-core.ts` 逻辑镜像，保证扫描结果、策略推荐与持仓卡片 OSS 分数一致。

---

## 🔧 数据源配置

### 环境变量

**说明**：未设置 `DATA_SOURCE` 时，代码默认使用 CBOE。配置为 `POLYGON` 时使用 Polygon.io（推荐）。

**开发环境** (`.env.local`):
```bash
# 推荐：Polygon.io（仅请求所需 DTE/行权 + 缓存）
DATA_SOURCE=POLYGON
POLYGON_API_KEY=your_polygon_api_key_here
# 付费档：避免客户端过度限流，建议 100（与 Polygon 建议 100 req/s 一致）
POLYGON_RATE_LIMIT_RPM=100

# 不设置或 DATA_SOURCE=CBOE 时使用 CBOE 免费延迟数据
```

**生产环境** (Vercel Dashboard):
```
Settings → Environment Variables
├── DATA_SOURCE = POLYGON        # 推荐；不设则 CBOE
├── POLYGON_API_KEY = ...       # DATA_SOURCE=POLYGON 时必填
└── POLYGON_RATE_LIMIT_RPM = 100   # 付费档建议，否则默认 5 易触发 429
```

**API 用量优化（Polygon）**：`/api/scan-options` 与 `/api/strategy-recommend` 在 Polygon 下先取标的价，再仅请求会用到的到期日与行权范围；同一 ticker 的期权链按参数做 **1 分钟内存缓存**，重复请求命中缓存。详见 `docs/09_Polygon集成.md`。

### 数据源对比

| 特性 | Polygon.io | CBOE |
|------|------------|------|
| **Greeks 精度** | 完整 | 全为 0 |
| **价格延迟** | 实时 | 15 分钟 |
| **IV 数据** | 完整 | 不完整 |
| **请求优化** | 仅 DTE/行权 + 1 分钟缓存 | 全链 |
| **成本** | 付费（需 API Key） | 免费 |

### 数据格式（Polygon / CBOE 统一标准化后）

**示例**:
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

### 端点
```
GET  /api/option-prices (单个)
POST /api/option-prices (批量)
```

### 用途
通用价格获取接口。支持通过查询参数获取单份合约，或通过 POST Body 批量获取多份合约的价格与 Greeks。  
**Polygon 批量优化**：POST 批量时按 **ticker 分组**，每个唯一 ticker 只请求一次期权链（2 次 API），再从链中解析各腿；调用量由「腿数」降为「2× 唯一 ticker 数」。

### 参数 (GET - 单个)
| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| ticker | string | ✅ | 股票代码 | QQQ |
| expiration | string | ✅ | 到期日 | 2026-02-20 |
| strike | number | ✅ | 行权价 | 630 |
| type | string | ✅ | 类型 | Call |

### 参数 (POST - 批量)
Body 格式:
```json
{
  "legs": [
    { "ticker": "SPY", "expiration": "2026-03-20", "strike": 600, "type": "Call" },
    { "ticker": "SPY", "expiration": "2026-03-20", "strike": 610, "type": "Call" }
  ]
}
```

### 响应格式

**成功响应 (200 OK)**:
```json
{
  "success": true,
  "symbol": "QQQ260220C00630000",
  "price": 7.36,
  "dataSource": "Polygon",
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
| dataSource | string | 数据来源：`Polygon`（主）或 `CBOE`（备） |
| delta | number | Delta值（-1到1）；Polygon 提供真实值，CBOE 为 0 |
| gamma | number | Gamma值；Polygon 提供真实值 |
| theta | number | Theta值（每日衰减）；Polygon 提供真实值 |
| vega | number | Vega值（IV敏感度）；Polygon 提供真实值 |
| iv | number | 隐含波动率（小数形式）；Polygon 提供真实值 |

---

## 🔍 期权扫描 API (OSS Scanner)

### 端点

```
GET /api/scan-options
```

### 用途

根据 OSS v2.3 算法扫描全链期权，返回经过数学评估后的最佳契约。**Polygon 提供真实 Greeks**；CBOE 下 Greeks 为 0。

### 数据源与用量优化（Polygon）

当 `DATA_SOURCE=POLYGON` 时：
- 先调用 `getUnderlyingPrice(ticker)` 获取标的价，再按 `dteMin`/`dteMax` 与 `strikeRange` 仅请求会用到的到期与行权范围，减少 payload。
- 同一 (ticker, 参数) 的期权链结果 **1 分钟内存缓存**，短时间重复请求直接命中，降低成本。

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

基于 IV 环境和用户方向偏好，智能生成 Credit Spread、Debit Spread 和 Long Option 策略。**使用 Polygon 构建完整 IV Term Structure**。

### 响应字段（IV 与 Regime）

**新增响应字段** - `regime.ivSurface`、`regime.ivRank`、`regime.slope`、`regime.slopeTier`：
```json
{
  "regime": {
    "ivRatio": 0.982,
    "slope": -0.018,
    "slopeTier": "flat",
    "iv30": 18.5,
    "iv90": 18.8,
    "rv30": 17.6,
    "ivRvRatio": 1.05,
    "ivRank": 0.42,
    "ivPercentile": 0.38,
    "ivRankSampleDays": 120,
    "mode": "NEUTRAL",
    "advice": "...",
    "adviceDetail": null,
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

- **slope**：期限结构斜率 `(IV30−IV90)/IV90`，正值表示 backwardation，负值表示 contango。
- **slopeTier**：档位，用于微调 Regime Bonus。取值：`strong_backwardation`、`backwardation`、`flat`、`contango`、`strong_contango`。

**IV Rank 与 IV Percentile**：`ivRank`、`ivPercentile` 来自表 `ticker_iv_snapshots`（252 日窗口）。策略推荐中 Credit Spread、Debit Spread、Single-leg 均使用 `getIVRankAdjustment(ivRank, strategy)` 参与打分，详见 [03_核心算法.md](./03_核心算法.md)。**策略推荐页**（StrategyRecommender）在 regime 区域同时展示 **IV Rank** 与 **IV Percentile**（同色阶：低=便宜/绿、高=贵/黄），并显示样本天数与回填入口。  
**写入 IV 快照**：`lib/_shared/ivHistory.cjs` 的 `saveTickerIVSnapshot` 使用 **Supabase Secret Key**（`SUPABASE_SERVICE_ROLE_KEY`）写入，以绕过 `ticker_iv_snapshots` 的 RLS；若仅配置 anon key 会报 401/RLS 错误。见 [08_IV_Rank_上线步骤.md](./08_IV_Rank_上线步骤.md)。

**异常检测与统一分**:
- 当 `ivSurface.anomaly = true` 时，表示检测到短期 IV 异常飙升（IV7/IV30 > 1.3，如财报前）
- 可能原因：即将到来的财报或重大事件
- `anomalyRatio`: IV7/IV30 比率（> 1.3 触发异常）
- **统一分降权**：当 `anomaly = true` 时，对「短期卖权」在**统一分**中降权：CREDIT_SPREAD 且 DTE ≤ 30 的候选，其 Regime 分量乘以 0.55，而不仅是 advice 文案提示；Top Picks 排序会相应下移短期信用价差。

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

**实时价格监控**（Polygon / CBOE）:
- ✅ Polygon 下获取当前价格（无延迟）；CBOE 为 15 分钟延迟
- ✅ 支持多腿策略的 Net Value 计算
- ✅ Polygon 失败时自动降级到 CBOE

---

## 📅 每日汇总 API

### 端点

```
GET /api/daily-recap
```

**Discord 每日报告**（Polygon / CBOE）:
- ✅ Polygon 下实时持仓价格；CBOE 为 15 分钟延迟
- ✅ 精确 P&L 计算
- ✅ Polygon 失败时自动降级 CBOE

---

## 📈 批量刷新技术面 API (Tech Score)

### 端点
```
GET/POST /api/batch-refresh-tech
```

### 用途
触发持仓或观察列表中标的的技术面快速刷新（Tech Score）。

### 参数
- `scope`: `active` (默认, 仅同步**活跃持仓**), `watchlist`, `all`
- `force`: `true` (忽略纽约时间冷却检查)

### 特性
- **仅处理 active**：只拉取 `status = 'active'` 的持仓（与 Portfolio 页一致），不处理 watchlist/closed。
- **冷却机制**: 默认情况下，如果标的今天（NY Time）已更新过，则不再重复调用 Polygon Aggregates API，节省用量。
- **可选限速**：环境变量 `BATCH_REFRESH_DELAY_MS`（默认 0）可在每只标的请求后加延迟，适合大批量时平滑请求。
- **自动化**: 位于前端 `Portfolio.tsx`，在批量价格请求完成后再触发，避免与 bulk 同时打满限流。

## 🧪 测试指南

### 本地测试

**直接 API 测试**:
```bash
node _test_strategy.js
```

**验证项**（当 `DATA_SOURCE=POLYGON`）:
- ✅ `dataSource: "Polygon"`
- ✅ Greeks 非零
- ✅ `ivSurface` 对象存在

### Vite 开发环境限制

```bash
npm run dev  # ⚠️ 使用简化的 CBOE 处理器，无 Polygon 集成
```

**注意**: 完整 Polygon 集成测试需使用 `vercel dev` 或部署到 Vercel。

### Vercel 部署测试

```bash
# 预览部署
vercel

# 生产部署
vercel --prod
```

---

## 📚 相关文档

- [09_Polygon集成.md](./09_Polygon集成.md) - Polygon 数据源集成与配置
- [03_核心算法.md](./03_核心算法.md) - 算法详解
- [02_技术路径](./02_技术路径.md) - 架构、部署与运维

---

*文档维护者: Trading Journal Team*  
*最后更新: 2026年2月17日*
