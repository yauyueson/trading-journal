# Trading Journal - API文档

> 最后更新: 2026年3月12日
> **数据源**: ORATS（期权链/Greeks/IV/cores/earnings/impliedMove）+ Tiingo（股票K线）

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
    ├── ORATS (期权链/Greeks/IV/cores/earnings/impliedMove)
    └── Tiingo (股票K线/历史价格)
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
| `/api/batch-refresh-tech` | GET/POST | 批量刷新技术面评分（Tech Score 自动化） | ⏸️ 已禁用 |
| ~~`/api/underlying-rv`~~ | ~~GET~~ | ~~标的已实现波动率~~ | ❌ 已移除 |
| `/api/earnings` | GET | 获取财报日期（通过 Nasdaq API） | ✅ 生产 |
| `/api/iv-rank` | GET | 获取指定 Ticker 的 IV Rank 与 Percentile | ✅ 生产 |
| `/api/cron-iv` | GET/POST | 定时任务，每日收集活跃持仓与热门标的 IV 快照并写入；检测 Regime 切换并发 Discord 提醒 | ✅ 生产 |
| ~~`/api/backfill-iv-history`~~ | ~~GET~~ | ~~回填历史波动率数据~~ | ❌ 已移除（回填已完成，脚本退役） |
| `/api/analytics?type=score-validation` | GET | 按评分段统计候选分布（0-30/30-50/50-70/70-100），用于实证验证 | ✅ 生产 |
| `/api/analytics?type=execution-quality` | GET | 基于 Delta 代理对入场时机分类（early/late/at-market） | ✅ 生产 |
| `/api/backtest-data?type=candles` | GET | 获取历史K线数据（Supabase 缓存 → Tiingo），供回测引擎使用 | ✅ 生产 |
| `/api/backtest-data?type=iv` | GET | 获取 ORATS 历史 IV 数据（Supabase 缓存 → ORATS），供回测引擎使用 | ✅ 生产 |

**评分逻辑统一**：所有 API 均引用 `api/_shared/scoring.cjs` / `api/_shared/ivHistory.cjs`，与前端 `src/lib/oss-core.ts` 逻辑镜像，保证扫描结果、策略推荐与持仓卡片 OSS 分数一致。

**数据质量保障**：`scan-options.js` 与 `strategy-recommend.js` 均检测降级数据——当 `zeroGreeks/total > 50%` 时响应中包含 `dataQuality: 'degraded'`，前端展示黄色警告横幅。

---

## 🔧 数据源配置

### 环境变量

**说明**：数据源已统一为 ORATS（期权数据）+ Tiingo（股票K线）。`DATA_SOURCE=ORATS`。

**开发环境** (`.env.local`):
```bash
DATA_SOURCE=ORATS
ORATS_API_TOKEN=your_orats_api_token
TIINGO_API_TOKEN=your_tiingo_api_token
```

**生产环境** (Vercel Dashboard):
```
Settings → Environment Variables
├── DATA_SOURCE = ORATS                # 期权数据源
├── ORATS_API_TOKEN = ...              # ORATS API Token
├── TIINGO_API_TOKEN = ...             # Tiingo API Token（股票K线）
├── SUPABASE_URL = ...                 # Supabase 项目 URL
├── SUPABASE_ANON_KEY = ...            # Supabase 匿名 Key（读）
├── SUPABASE_SERVICE_ROLE_KEY = ...    # Supabase Secret Key（写 IV 快照，绕过 RLS）
├── DISCORD_WEBHOOK_URL = ...          # Discord 提醒 Webhook URL
├── CRON_IV_DELAY_MS = 300             # IV 快照 Cron 每 ticker 延迟（默认 300ms）
└── ALERT_CHAIN_DELAY_MS = 100         # check-alerts/daily-recap 期权链请求间延迟
```

### 数据源概览

| 提供商 | 用途 | 客户端 |
|--------|------|--------|
| **ORATS** | 期权链、Greeks、IV、cores、earnings、impliedMove、历史 IV | `lib/orats-client.js` |
| **Tiingo** | 股票日线/4H K线、历史价格 | `lib/tiingo-client.js` |

### 数据格式（ORATS 标准化后）

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
**批量优化**：POST 批量时按 **ticker 分组**，每个唯一 ticker 只请求一次期权链，再从链中解析各腿；调用量由「腿数」降为「唯一 ticker 数」。

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
  "dataSource": "ORATS",
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

**批量 POST 响应** (多腿时):
```json
{
  "success": true,
  "results": [ /* 各腿独立结果 */ ],
  "timestamp": 1707350400000
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| dataSource | string | 数据来源：`ORATS` |
| priceSource | string | 定价方式：`'mid'`（优先）、`'last'`（回退）或 `'none'` |
| underlyingPrice | number | 标的股票价格（v2.8：多级回退保障准确性） |
| delta | number | Delta值（-1到1）；ORATS 提供真实值 |
| gamma | number | Gamma值；ORATS 提供真实值 |
| theta | number | Theta值（每日衰减）；ORATS 提供真实值 |
| vega | number | Vega值（IV敏感度）；ORATS 提供真实值 |
| iv | number | 隐含波动率（小数形式）；ORATS 提供真实值 |
| greeksSuspicious | boolean | 市场 Greeks 与 BSM 偏差 > 0.15 时为 true |
| greeksNote | string | 可疑 Greek 的解释说明（仅当 greeksSuspicious=true） |

> **v2.8 Price Fix**:
> - `price` 优先使用 mid (bid+ask)/2，仅 bid/ask 均不可用时回退到 last trade（之前反之）
> - `underlyingPrice` 通过股票快照/PCP 多级回退获取，不再依赖可能 stale 的 option snapshot
> - 必要时通过 Put-Call Parity 从期权链推导 underlyingPrice（精度 ±0.5%）

---

## 🔍 期权扫描 API (OSS Scanner)

### 端点

```
GET /api/scan-options
```

### 用途

根据 OSS v2.3 算法扫描全链期权，返回经过数学评估后的最佳契约。**ORATS 提供完整 Greeks + IV**。

### 数据源与用量优化

使用 ORATS 时：
- 先调用 `getUnderlyingPrice(ticker)` 获取标的价，再按 `dteMin`/`dteMax` 与 `strikeRange` 仅请求会用到的到期与行权范围，减少 payload。
- 同一 (ticker, 参数) 的期权链结果 **1 分钟内存缓存**，短时间重复请求直接命中，降低成本。

### 参数

| 参数 | 类型 | 必填 | 说明 | 默认值 |
|------|------|------|------|---------|
| ticker | string | ✅ | 股票代码 | - |
| strategy | string | ❌ | 策略类型：`'long'`（买方 LOQ 评分）或 `'short'`（卖方 CSQ 评分） | `'long'` |
| dteMin | number | ❌ | 最小 DTE | 20 |
| dteMax | number | ❌ | 最大 DTE | 60 |
| limit | number | ❌ | 返回结果数量上限 | 20 |

### 响应字段

```json
{
  "success": true,
  "dataQuality": "ok",
  "scoresReliable": true,
  "context": { "quoteFreshness": { "quoteUpdatedMs": 1707350400000 } },
  "results": [ /* 评分后的合约列表 */ ]
}
```

| 字段 | 说明 |
|------|------|
| dataQuality | `'ok'` 或 `'degraded'`（Greeks 零值率 > 50%） |
| scoresReliable | 综合数据源与质量判断，是否可信赖评分 |
| quoteFreshness | 报价时间戳信息 |

---

## 🤖 策略推荐 API

### 端点

```
GET /api/strategy-recommend
```

### 用途

基于 IV 环境和用户方向偏好，智能生成 Credit Spread、Debit Spread 和 Long Option 策略。**使用 ORATS 构建完整 IV Term Structure**。

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
**写入 IV 快照**：`lib/_shared/ivHistory.cjs` 的 `saveTickerIVSnapshot` 使用 **Supabase Secret Key**（`SUPABASE_SERVICE_ROLE_KEY`）写入，以绕过 `ticker_iv_snapshots` 的 RLS；若仅配置 anon key 会报 401/RLS 错误。

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
| spreadWidth | number | ❌ | 价差宽度（$2.5/$5/$10/$20） | 自动 |
| targetStrategy | string | ❌ | Pine Script 推荐的策略类型 | - |
| setup | string | ❌ | Pine Script 识别名称（如 `Perfect Storm`） | - |
| d8 | number | ❌ | EMA-8 距离百分比（如 `1.8` 表示价格距 EMA-8 上方 1.8%） | - |
| entryContext | string | ❌ | 入场上下文（如 `BULL_PULLBACK`） | - |
| entryQuality | number | ❌ | 入场质量分数 0-100（来自 Tech Score） | - |
| overextended | boolean | ❌ | 技术面过度延伸标志 | `false` |
| mtfConflict | boolean | ❌ | 多时间框架冲突标志 | `false` |
| lowVolume | boolean | ❌ | 低成交量条件标志 | `false` |
| nearEarnings | boolean | ❌ | 临近财报标志 | `false` |
| highVolatility | boolean | ❌ | 高波动率条件标志 | `false` |
| priceReversing | boolean | ❌ | 价格反转形态标志 | `false` |

**`targetStrategy` 取值**（对应双大算法）：

| 取值 | 调用函数 | 过滤层 |
|------|----------|----------|
| `Credit Put Spread` | `buildCreditSpreads('Put')` | `HARD_FILTER_CREDIT` |
| `Credit Call Spread` | `buildCreditSpreads('Call')` | `HARD_FILTER_CREDIT` |
| `Debit Call Spread` | `buildDebitSpreads('Call')` | `HARD_FILTER_DEFAULTS` |
| `Debit Put Spread` | `buildDebitSpreads('Put')` | `HARD_FILTER_DEFAULTS` |
| `Long Call` | `scoreSingleLegs('Call')` | `HARD_FILTER_DEFAULTS` |
| `Long Put` | `scoreSingleLegs('Put')` | `HARD_FILTER_DEFAULTS` |
| `Iron Condor` | `buildIronCondors()` ✅ v2.6 | `HARD_FILTER_CREDIT` |

**`setup` 参数作用**：传入后会激活 Pine Script 设置感知权重（`hasPineSetup=true`：`wEV=0.45/wRegime=0.20`）。`Mixed`/`Other` 不激活权重切换。

**候选快照（v2.7 Deep Audit）**：每次推荐完成后，Top-5 候选自动 Fire-and-Forget 写入 `candidate_snapshots` 表，用于后续 Score→P&L 实证分析。

**Regime 迟滞（v2.7 Deep Audit）**：CREDIT→DEBIT 需 `termRatio<0.90`，DEBIT→CREDIT 需 `>1.10`，防止 Regime 频繁翻转影响推荐稳定性。

**数据质量字段**：响应中包含 `dataQuality: 'ok' | 'degraded'`。降级时前端展示黄色横幅提示用户数据可信度不足（Greeks 零值率 > 50%）。

---

## 🔔 止损/目标价提醒 API

### 端点

```
GET /api/check-alerts
```

**实时价格监控**:
- ✅ ORATS 获取当前价格
- ✅ 支持多腿策略的 Net Value 计算

**价差提醒（v2.7）**：2 腿持仓纳入监控：
- **Credit Spread**: cost-to-close > 1.5× entry credit → 止损提醒；cost-to-close < 0.5× entry credit → 止盈提醒
- **Debit Spread**: 当前价值 > 1.5× entry debit → 止盈提醒；当前价值 < 0.5× entry debit → 止损提醒

**评分衰减提醒**：当持仓的 `current_score < 40` 或评分下降 ≥ 20 点（`entry_score - current_score ≥ 20`）时发送 Discord 提醒，提示交易论据可能已失效。

---

## 📅 每日汇总 API

### 端点

```
GET /api/daily-recap
```

**Discord 每日报告**:
- ✅ ORATS 实时持仓价格
- ✅ 精确 P&L 计算


---

## 📈 批量刷新技术面 API (Tech Score)

### 端点
```
GET/POST /api/batch-refresh-tech
```

> ⏸️ **当前状态: 已禁用**。端点始终返回 `{ message: 'Tech score calculation is disabled.', processed: 0 }`。Tech Score 计算已移至前端或 `strategy-recommend.js` 内联执行。

---

## 📉 波动率历史与快照 API (IV Rank)

本组 API 负责维护与查询基于 252 日周期的 IV Rank (IVR) 及 IV Percentile，用于提供策略推荐的宏观波动率背景。

### 1. 查询 IV Rank 与基本信息
**端点**: `GET /api/iv-rank?ticker={TICKER}`
**用途**: 获取指定标的的 IV Rank / IV Percentile、历史最值及天数。
**实现**: 查询 Supabase 数据库 `ticker_iv_snapshots` 表中的历史快照，计算当前排位。

**响应字段**:
| 字段 | 类型 | 说明 |
|------|------|------|
| ivRank | number | IV Rank (0-1)，当前 IV30 在 252 日内的位置 |
| ivPercentile | number | IV Percentile (0-1)，低于当前值的天数占比 |
| currentIv30 | number | 当前 IV30（百分比形式，如 25.3） |
| minIv | number | 252 日内最低 IV（百分比形式） |
| maxIv | number | 252 日内最高 IV（百分比形式） |
| sampleDays | number | 可用的历史天数 |

### 2. 定时写入每日 IV 快照
**端点**: `GET/POST /api/cron-iv`
**用途**: 由 Vercel Cron 每交易日盘后触发（如 16:30 ET），自动获取所有活跃持仓标的及特定热门标的（如 SPY, QQQ, AAPL 等）当天的 IV30 与 IV90 值，并写入数据库 `ticker_iv_snapshots` 记录当日快照。
**Regime 切换检测（v2.7）**：写入快照后查询近 5 日 Regime 历史，若检测到 CREDIT↔DEBIT 翻转则发送 Discord 提醒（`DISCORD_WEBHOOK_URL`）。Regime 阈值：`ratio > 1.05` → CREDIT，`ratio < 0.95` → DEBIT，其余 → NEUTRAL。需至少 3 天历史数据才会触发提醒。
**限速**：环境变量 `CRON_IV_DELAY_MS`（默认 300ms）控制每个 ticker 之间的请求延迟。
**注意**: 此端点通过 ORATS 获取期权链数据计算 IV 期权结构。需要使用带有 `SUPABASE_SERVICE_ROLE_KEY` 权限的后端脚本执行。

### 3. ~~回填历史波动率数据~~ (已移除)

> ❌ **`/api/backfill-iv-history` 和 `api/setup-iv-rank.js` 已退役**。历史 RV30 回填已完成（SPY, QQQ, MSFT, META, TSLA, AMD, COST, IREN），回填行在 Migration 009 中标记为 `source='rv_proxy'`。IV 数据现通过 `cron-iv.js` 每日自动积累。

---

## 📊 分析 API（合并端点）

### 端点

```
GET /api/analytics?type={score-validation|execution-quality}
```

> **注意**: 原 `/api/score-validation` 和 `/api/execution-quality` 已合并至此端点（Vercel Hobby 12 函数限制）。

### type=score-validation — 评分验证

查询 `candidate_snapshots` 表，按统一评分段统计候选数量与实际 P&L 分布，用于实证验证评分系统的预测效力（Score → P&L 映射质量）。

**响应结构**:
```json
{
  "success": true,
  "totalLinked": 205,
  "totalClosed": 112,
  "buckets": [
    { "label": "70-100", "scoreRange": [70, 100], "candidateCount": 42, "closedCount": 28, "hitRate": 71.4, "avgPnl": 184, "totalPnl": 5152 },
    { "label": "50-70",  "scoreRange": [50, 70],  "candidateCount": 88, "closedCount": 45, "hitRate": 53.3, "avgPnl": 42,  "totalPnl": 1890 }
  ]
}
```

### type=execution-quality — 执行质量

基于 Delta 代理，对所有已平仓持仓的入场时机进行分类（early/late/at-market），量化执行效率。

**响应结构**:
```json
{
  "success": true,
  "summary": { "total": 50, "classifiable": 42, "earlyCount": 15, "lateCount": 8, "atMarketCount": 19, "earlyPct": 35.7, "latePct": 19.0, "atMarketPct": 45.2 },
  "positions": [
    { "positionId": "uuid", "ticker": "SPY", "type": "Long Call", "entryPrice": 7.35, "entryDelta": 0.38, "bestDelta": 0.45, "worstDelta": 0.28, "distFromBest": 0.412, "classification": "at-market" }
  ]
}
```

---

## 🧪 测试指南

### 本地测试

**直接 API 测试**:
```bash
node _test_strategy.js
```

**验证项**（`DATA_SOURCE=ORATS`）:
- ✅ `dataSource: "ORATS"`
- ✅ Greeks 非零
- ✅ `ivSurface` 对象存在

### Vite 开发环境限制

```bash
npm run dev  # 本地开发；完整 API 测试需使用 `vercel dev` 或部署到 Vercel
```

### Vercel 部署测试

```bash
# 预览部署
vercel

# 生产部署
vercel --prod
```

---

## 📚 相关文档

- [03_核心算法.md](./03_核心算法.md) - 算法详解
- [02_技术路径](./02_技术路径.md) - 架构、部署与运维

---

*文档维护者: Trading Journal Team*
*最后更新: 2026年3月3日*
