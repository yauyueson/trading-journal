# Trading Journal - 技术文档

> 最后更新: 2026年2月12日（含 OSS v2.4 Vega、Skew 细粒度、策略推荐 IV Rank；API 用量优化：仅请求所需到期/行权 + 1 分钟期权链缓存）

## 项目概述

这是一个为期权交易设计的个人交易日志Web应用，专注于**执行纪律**而非单纯记录。

### 核心问题解决

| 问题 | 解决方案 |
|------|----------|
| 入场无纪律（感觉对就买） | Watchlist + Scanner Score 强制计划 |
| 出场靠情绪（亏70%才割肉） | Stop Loss 规则 + 视觉警告 |
| 时间漂移（短线变长线） | 到期日警告 + 持仓天数追踪 |
| 记录难坚持（Notion用几天就放弃） | 30秒快速操作 + 手机友好 |
| 手动更新价格麻烦 | **自动获取期权价格（Polygon.io 主 / CBOE 备用）** |

---

## 技术架构

```
┌─────────────────────────────────────────────────────────────────┐
│              Frontend (React 18 + TypeScript + Vite)             │
│  Portfolio | Watchlist | Scanner | Strategy Recommender | ...   │
│  src/lib/oss-core.ts ← 评分算法单点事实 (与 API 逻辑一致)         │
│  src/lib/scoring.ts  ← 批量评分、IV 期限结构，复用 oss-core      │
└─────────────────────────────┬───────────────────────────────────┘
                              │ HTTPS API
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│               Vercel Serverless Functions                        │
│  api/_shared/scoring.cjs ← 与 oss-core.ts 镜像，单点事实         │
│  api/polygon-client.js   ← Polygon.io 客户端（DATA_SOURCE=POLYGON）│
│  /api/option-price.js    → 单合约价格 + Greeks（Polygon 优先）   │
│  /api/scan-options.js    → OSS 扫描器 (引用 _shared/scoring)     │
│  /api/strategy-recommend.js → 策略推荐 (引用 _shared/scoring)     │
│  /api/underlying-rv.js   → 标的 RV；/api/earnings.js → 财报日期   │
│  /api/check-alerts.js    → 止损/目标价 Discord 提醒（外部 Cron 触发）│
│  /api/daily-recap.js     → 每日汇总 Discord 消息                  │
│  /api/health.js          → 健康检查                               │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 外部服务 & 定时任务                                │
│  cron-job.org (每15分钟) → /api/check-alerts → Discord Webhook   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Supabase Backend                             │
│  PostgreSQL + REST API + Realtime + Auth                         │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│            期权数据源（由环境变量 DATA_SOURCE 控制）                 │
│  主: Polygon.io — 实时报价 + Greeks + IV；仅请求所需 DTE/行权范围   │
│  备: CBOE 延迟 API — 15 分钟延迟，Greeks 为 0，免费               │
│  期权链 1 分钟内存缓存（同 ticker+参数 重复请求命中缓存，降成本）    │
│  api.nasdaq.com — 历史/财报（与 DATA_SOURCE 无关）                │
└─────────────────────────────────────────────────────────────────┘
```

### OSS 评分架构（单点事实）

| 层级 | 文件 | 职责 |
|------|------|------|
| **规范源** | `src/lib/oss-core.ts` | 所有 LOQ/CSQ/Delta Bonus/Theta 惩罚/Lambda 压缩/Z-Score/价差评分；**v2.4 Vega**（LOQ Vega 效率、CSQ Vega 惩罚）；LERP、Sigmoid、边缘情况防护 |
| **前端复用** | `src/lib/scoring.ts` | 从 oss-core  re-export；额外提供批量 `scoreOptionsChain`、IV 期限结构 `calculateIVRatio` |
| **API 镜像** | `api/_shared/scoring.cjs` | 与 oss-core 逻辑同步的 JS 实现，供 `scan-options.js`、`strategy-recommend.js` 引用 |
| **跨策略统一** | `api/_shared/scoring.cjs` | `calculateUnifiedScore` — 跨 Credit/Debit/Long 的统一评分；`getSkewBonusForCreditSpread`、`getSkewFavorForUnifiedScore`（Skew 细粒度），仅后端使用 |

**原则**：不在此三处以外重复实现评分公式，避免前后端/扫描器与持仓卡片分数不一致。统一评分仅在 API 层计算后传给前端，前端不重复实现。

**OSS v2.4 — Vega 纳入评分**：  
- **买方 (LOQ)**：使用「Vega 效率」`vega/权利金` 在池内做 DTE 分桶 Z-Score；IV 偏低（contango）时对高 vega 效率加分（+0.05×z），IV 偏高时对高 vega 轻微扣分（-0.03×z），避免买在 IV 极高且 vega 又大的合约。  
- **卖方 (CSQ)**：对 `vega/权利金` 的池内 Z-Score 施加温和惩罚（-0.05×z），卖权时高 vega 对波动率更敏感，分数略降。  
- 数据来源：Polygon/MarketData 提供的 per-contract vega，`parseChain` 与各 API 已解析并返回，直接用于评分。

**IV Rank（策略推荐）**：`api/strategy-recommend.js` 在 Single-leg LOQ、Credit Spread、Debit Spread 中均使用 `getIVRank(ticker)`（读 `ticker_iv_snapshots`）与 `getIVRankAdjustment(ivRank, strategy)` 进行微调——买方（long）：IV Rank 高略降分、低略加分；卖方（short）：IV Rank 高略加分、低略减分。当日 iv30 来自 `buildIVTermStructure`，先 `saveTickerIVSnapshot` 再 `getIVRank`，与 backfill 同源，IV Rank 随时间积累变准。

### 技术选择理由

| 技术 | 选择理由 |
|------|----------|
| Single HTML | 无需build，直接部署，易于维护 |
| React (CDN) | 组件化开发，状态管理清晰 |
| Tailwind CSS | 快速styling，dark mode友好 |
| Supabase | 免费tier够用，PostgreSQL可靠，实时同步 |
| Vercel | 免费，自动HTTPS，全球CDN，Serverless Functions |
| **期权数据** | Polygon.io（主）：实时 + Greeks + IV，仅请求所需 DTE/行权 + 1 分钟缓存；CBOE（备）：15 分钟延迟、免费。见「数据源配置」。 |

---

## 期权价格 API

### 端点

```
GET /api/option-price?ticker=QQQ&expiration=2026-02-20&strike=630&type=Call
```

### 参数

| 参数 | 类型 | 说明 | 示例 |
|------|------|------|------|
| ticker | string | 股票代码 | QQQ, SPY, AAPL |
| expiration | string | 到期日 (YYYY-MM-DD) | 2026-02-20 |
| strike | number | 行权价 | 630 |
| type | string | 期权类型 | Call 或 Put |

### 返回数据

当 `DATA_SOURCE=POLYGON` 或 `MARKET_DATA` 且可用时，返回示例：

```json
{
  "success": true,
  "symbol": "QQQ260220C00630000",
  "price": 7.36,
  "priceSource": "mid",
  "bid": 7.32,
  "ask": 7.39,
  "lastPrice": 7.35,
  "iv": 0.1778,
  "delta": 0.3999,
  "gamma": 0.0123,
  "theta": -0.0456,
  "vega": 0.0789,
  "volume": 6485,
  "openInterest": 29600,
  "underlyingPrice": 620.24,
  "dataSource": "MarketData.app",
  "timestamp": 1769901862738
}
```

降级到 CBOE 时 `dataSource` 为 `"CBOE"`，且 gamma/theta/vega 可能为 0。

**API 用量优化（Polygon）**：`strategy-recommend` 与 `scan-options` 在 Polygon 下先 `getUnderlyingPrice(ticker)`，再仅请求会用到的到期日与行权范围；同一 ticker 的期权链按 (ticker + 参数) 做 **1 分钟内存缓存**。详见 `api/polygon-client.js` 与 `docs/09_Polygon集成.md`。

### 数据字段说明

| 字段 | 说明 |
|------|------|
| price | 计算后的价格（优先用 mid price） |
| priceSource | 价格来源：mid（买卖中间价）或 last（最后成交价） |
| dataSource | 实际数据来源：`"MarketData.app"` 或 `"CBOE"` |
| iv | 隐含波动率；MarketData 为真实值，CBOE 可能不完整 |
| delta, gamma, theta, vega | Greeks；仅 MarketData 提供交易所级非零值 |
| volume | 当日成交量 |
| openInterest | 未平仓合约数 |
| underlyingPrice | 标的股票当前价格 |

### 数据源配置

期权价格由环境变量 `DATA_SOURCE` 控制，**未设置时默认为 CBOE**。

| 配置 | 行为 |
|------|------|
| `DATA_SOURCE=POLYGON` | 优先调用 Polygon.io（需 `POLYGON_API_KEY`）；仅请求所需 DTE/行权；1 分钟期权链缓存 |
| `DATA_SOURCE=MARKET_DATA` | 优先调用 MarketData.app（需 `MARKET_DATA_TOKEN`）；失败时自动降级 CBOE |
| `DATA_SOURCE=CBOE` 或未设置 | 仅使用 CBOE 延迟 API |

**Polygon.io**（主，推荐）：实时报价 + Greeks + IV；仅请求所需到期/行权 + 1 分钟缓存。需 `POLYGON_API_KEY`，详见 `docs/09_Polygon集成.md`。

**CBOE**（备）：
- 端点：`https://cdn.cboe.com/api/global/delayed_quotes/options/{TICKER}.json`
- 15 分钟延迟，免费，Greeks 在 API 中全为 0，易遇 429

---

## 数据库设计

### Supabase 项目信息

```
Project URL: https://irejefxhgetulqmxponl.supabase.co
API Key (publishable): sb_publishable_STPE7Kl1Pnlwm6a-mCa-9g_U7hvret6
```

### 表结构

#### positions 表

```sql
CREATE TABLE positions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    ticker VARCHAR(20) NOT NULL,           -- 股票代码 e.g. "QQQ"
    strike DECIMAL(10,2) NOT NULL,         -- 行权价 e.g. 630.00（价差时=锚定腿）
    type VARCHAR(10) NOT NULL,             -- "Call"/"Put" 或价差类型 e.g. "Credit Put Spread"
    expiration DATE NOT NULL,              -- 到期日
    status VARCHAR(20) NOT NULL DEFAULT 'watchlist',  -- watchlist/active/closed
    setup VARCHAR(50),                     -- 交易设置类型
    entry_score INTEGER,                   -- 入场时Scanner Score (0-100)
    current_score INTEGER,                 -- 当前Scanner Score
    score_updated_at TIMESTAMPTZ,          -- Score最后更新时间
    ideal_entry DECIMAL(10,2),             -- 理想入场价
    current_price DECIMAL(10,2),           -- 当前期权价格
    stop_reason TEXT,                      -- 技术止损条件 e.g. "MB flips red"
    target_price DECIMAL(10,2),            -- 目标价
    stop_price DECIMAL(10,2),             -- 手动止损价（如设置则覆盖计算值）
    notes TEXT,                            -- 交易笔记
    legs JSONB,                           -- 价差腿信息 [{strike, type, side, expiration}, ...]
    created_at TIMESTAMPTZ DEFAULT NOW(),  -- 创建时间
    closed_at TIMESTAMPTZ                  -- 平仓时间
);
```

**`legs` JSONB 结构**（价差持仓使用，单腿为 `null`）:
```json
[
  { "strike": 580, "type": "Put", "side": "short", "expiration": "2026-03-21" },
  { "strike": 575, "type": "Put", "side": "long",  "expiration": "2026-03-21" }
]
```

**`type` 字段命名约定**（与 StrategyRecommender / PositionCard 一致）:
- 单腿: `"Call"`, `"Put"`
- 信用价差: `"Credit Put Spread"`, `"Credit Call Spread"`
- 借记价差: `"Debit Call Spread"`, `"Debit Put Spread"`

`PositionCard` 通过 `position.legs?.length > 0` 判断是否价差，通过 `position.type.includes('Credit')` 判断信用/借记。

#### transactions 表

```sql
CREATE TABLE transactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    position_id UUID REFERENCES positions(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL,             -- 交易类型
    quantity INTEGER NOT NULL,             -- 数量 (正=买入，负=卖出)
    price DECIMAL(10,2) NOT NULL,          -- 成交价
    date TIMESTAMPTZ DEFAULT NOW(),        -- 交易时间
    note TEXT                              -- 交易备注
);
```

---

## 前端功能

### Portfolio 页面

**Quick Add Position 表单**:
- 支持三种持仓类型切换：**Single Leg** / **Credit Spread** / **Debit Spread**
- Single Leg: Strike + Type（Call/Put）两列布局
- Spread: Short Strike + Long Strike + Type 布局（移动端 Short/Long 并排，Type 独占一行）
- Entry Price 标签根据类型动态变化：Entry Price / Net Credit / Net Debit
- 提交价差时自动构建 `legs` 数组，设置 `type` 为 `"Credit Put Spread"` 等，`strike` 锚定为信用=Short Strike / 借记=Long Strike
- iOS 优化：所有 input 设置 `text-base`（16px）防止 Safari 自动缩放，数字输入添加 `inputMode="decimal"` 显示小数键盘，触控按钮最小 44px

**自动价格更新**:
- 🔄 **Refresh Prices** - 批量更新所有持仓价格
- 🔄 **Auto Price** - 单个持仓自动获取价格
- ✏️ **Manual** - 手动输入价格（备用）

**显示信息**:
- 持仓详情 (Ticker, Strike, Type, Exp, Contracts)
- 盈亏 (%, $)
- Entry Price, Current Price, Stop Loss
- Entry Score, Current Score
- Setup, Technical Exit 条件
- 警告标签
- 价差持仓显示双腿信息（Short/Long Strikes, Net Greeks）

### 警告系统

| 条件 | 类型 | 显示 |
|------|------|------|
| Current Score < 60 | 🔴 Danger | "Score < 60" |
| 亏损 ≥ 40% | 🔴 Danger | "-40% loss" |
| 价格触及止损 | 🔴 Danger | "⚠️ HIT STOP" |
| Current Score < 70 | 🟡 Warning | "Score < 70" |
| 距到期 ≤ 7天 | 🟡 Warning | "7d to exp!" |
| 距止损 ≤ 5% | 🟡 Warning | "5% to stop" |
| Score 超过2天未更新 | 🔵 Info | "Update score" |

---

## 部署信息

### 文件结构

```
trading-journal/
├── index.html
├── package.json
├── vercel.json
├── vite.config.ts
├── src/
│   ├── lib/
│   │   ├── oss-core.ts      # OSS 评分算法单点事实 (TypeScript)
│   │   ├── scoring.ts       # 批量评分、IV 期限结构，复用 oss-core
│   │   ├── types.ts         # 全局类型 (Position, WatchlistItem, StrategyResult, UnifiedCandidateType 等)
│   │   ├── supabase.ts
│   │   ├── utils.ts
│   │   └── greeksHistory.ts
│   ├── components/
│   ├── pages/
│   ├── App.tsx
│   └── main.tsx
└── api/
    ├── _shared/
    │   └── scoring.cjs      # 与 oss-core.ts 镜像，供 Serverless 使用；含跨策略统一评分
    ├── option-price.js
    ├── scan-options.js      # OSS 扫描器，引用 _shared/scoring
    ├── strategy-recommend.js
    ├── underlying-rv.js
    ├── earnings.js
    ├── check-alerts.js      # 止损/目标价 Discord 提醒（外部 Cron 触发）
    └── health.js            # 健康检查端点
```

### 当前部署

```
网址: https://trading-journal-yuchen.vercel.app
Hosting: Vercel (Hobby Plan)
GitHub: https://github.com/yauyueson/trading-journal
```

### 更新流程

> ⚠️ **注意**：GitHub → Vercel 的自动部署 Webhook 目前不稳定，新代码推送后可能不会自动触发 Vercel 部署。

**推荐部署方式**（按优先级）：

1. **Vercel CLI**（最可靠）：本地运行 `npx vercel --prod`，直接从本地代码构建并部署。
2. **Deploy Hook**：通过 POST 请求触发 Vercel 从最新 `main` 分支构建。
3. **Vercel Dashboard**：在 Deployments 页面手动触发。

**Deploy Hook URL**（POST 请求即可触发部署）：
```
https://api.vercel.com/v1/integrations/deploy/prj_Q27dySs80ReT8IwzjuVlMtePI2xu/s0lgHBX591
```

### Vercel 环境变量

| 变量名 | 说明 |
|--------|------|
| `VITE_SUPABASE_URL` | Supabase 项目 URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase Anon Key |
| `DATA_SOURCE` | 期权数据源：`POLYGON`（主）、`MARKET_DATA` 或 `CBOE`（备）；未设置时默认 CBOE |
| `POLYGON_API_KEY` | Polygon.io API Key（当 `DATA_SOURCE=POLYGON` 时必填） |
| `MARKET_DATA_TOKEN` | MarketData.app API Token（当 `DATA_SOURCE=MARKET_DATA` 时必填） |
| `CRON_SECRET` | check-alerts API 鉴权密钥 |
| `DISCORD_WEBHOOK_URL` | Discord Webhook URL（提醒发送目标） |

### Vercel Hobby 计划限制

- **Cron Jobs**：Hobby 计划仅支持**每日一次**的 Cron。`*/15 * * * *`（每 15 分钟）会导致部署失败。因此 `vercel.json` 中**不能包含高频 crons 配置**，改用外部 cron 服务。
- **Serverless Function Timeout**：默认 10s，最大可配置 60s。

---

## 使用工作流

### 交易时段

1. 打开 Portfolio 页面
2. 点击 **🔄 Refresh Prices** 批量更新所有价格
3. 查看警告标签，做出决策
4. 执行交易后记录

### 单个持仓更新

1. 找到目标持仓
2. 点击 **🔄 Auto Price** 自动获取最新价格
3. 或点击 **✏️ Manual** 手动输入

---

## 重构说明 (2026-02)

### 评分逻辑统一
- **getDeltaBonus**：前端与 API 均采用 LERP 线性插值（文档 v2.1），不再使用阶梯函数。
- **getThetaPenalty**：惩罚上限统一为 10（原前端为 50）。
- **Lambda**：扫描与单腿 LOQ 均经 `compressLambda` 后再参与 Z-Score，避免极端杠杆拉偏分数。
- **Day Trade 模式**：扫描器与前端 `scoreOptionsChain` 均支持日交易权重（Gamma 提高、Theta 惩罚系数降低）。

### 类型与边界
- 新增/统一类型：`WatchlistItem`、`DirectAddItem`（含可选 `legs?: PositionLeg[]`）、`StrategyResult`、`SpreadRecommendation`、`SingleLegRecommendation`、`PositionAction`、`RollData`、`StrategyCategory`、`UnifiedCandidateType`、`PositionLeg` 等，消除评分与页面中的 `any`。
- 数学与数据边界：`lerp` 防除零、`sigmoid` 输入裁剪、`normalizeToZScores` 在 n&lt;2 或 std=0 时的防护、DTE≤0 过滤、低价期权 Lambda 防护。

### 扫描器性能
- `scan-options.js` 单遍完成过滤与指标计算，减少多轮遍历。
- 流动性：显式要求 `bid > 0 && ask > 0`，并在解析阶段做 DTE/行权价预过滤。

### API 用量优化 (2026-02-12)
- **strategy-recommend / scan-options（Polygon）**：仅请求会用到的到期日与行权范围；先 `getUnderlyingPrice(ticker)`，再按 DTE 与 strike 范围调用 `getOptionChain`（strategy-recommend：DTE 30/90 + 行权 ±20%；scan-options：dteMin～dteMax + strikeRange）。
- **期权链短期缓存**：`api/polygon-client.js` 对同一 (ticker, 筛选参数) 的期权链结果做 **1 分钟内存缓存**，短时间重复请求命中缓存，降低成本并保持算法一致。
- **长期规划**：历史 IV 回测与多数据源聚合见 CHANGELOG「长期 (Long-term)」。

### Discord 自动提醒 (2026-02-08)
- 新增 `api/check-alerts.js`：定时检查 Active 持仓是否触及止损/目标价，触及则发 Discord Embed 提醒。
- 使用 Supabase REST API（PostgREST）直接 fetch，不引入 `@supabase/supabase-js` SDK，避免 Vercel Serverless ESM 兼容问题。
- 定时触发由外部 cron-job.org 完成（每 15 分钟），而非 Vercel Cron（Hobby 计划不支持高频）。

### 跨策略统一评分 & Top Picks (2026-02-08)

**问题**：策略推荐器的三种策略（Credit Spread、Debit Spread、Long Option）各有独立评分体系，分数不可跨类型比较。Credit Spread 80 分并不一定优于 Long Option 50 分，因为：
- Credit Spread 评分 = 加权绝对值（EV 20% + ROI 20% + POP 20% + Distance 15% + DTE 25%）
- Debit Spread 评分 = 加权绝对值（Lambda 40% + R:R 35% + Delta 25%）
- Long Option 评分 = z-score 相对排名（50 = 同组平均）

原有 `recommendedStrategy` 在 NEUTRAL 模式下直接比较这些不可比的分数，存在逻辑缺陷。

**解决方案**：新增统一评分层 `calculateUnifiedScore`，使用所有策略类型都能计算的通用指标：

```
UnifiedScore = 0.40 × norm(EV/Risk)     // 风险调整后期望收益
             + 0.20 × norm(POP)          // 盈利概率
             + 0.25 × norm(RegimeBonus)  // IV 环境匹配度
             + 0.15 × norm(Liquidity)    // 流动性/滑点
             + SkewFavor                 // 仅 Credit Spread：Skew 有利于该策略时 +5～+10（见下）
```

| 指标 | Credit Spread | Debit Spread | Long Option |
|------|---------------|--------------|-------------|
| maxRisk | width - credit | debit | premium |
| maxProfit | credit | width - debit | **2 × premium（封顶）** |
| POP | 1 - \|delta@BE\| | \|delta\| - 0.05 | \|delta\| - 0.05 |
| EV | POP × profit - (1-POP) × risk | 同左 | 同左 |

Long Option 的 maxProfit 封顶在 2 × premium（100% 回报情景），避免理论无限利润导致 EV 虚高。

**Regime Bonus 规则**：
- Backwardation (IV30 > IV90)：Credit +15
- Contango (IV30 < IV90)：Debit +10, Long +10
- IV/RV > 1.2：Credit 额外 +5 | IV/RV < 0.85：Debit/Long 额外 +5
- **期限结构斜率 (slope)**：`slope = (IV30−IV90)/IV90`；档位 `slopeTier`：strong_backwardation / backwardation / flat / contango / strong_contango。Strong backwardation 时 Credit 再 +2；Strong contango 时 Debit/Long 再 +2（`calculateRegimeBonus` 第四参 `termStrength`）。
- **Anomaly 与统一分**：当 `ivSurface.anomaly === true`（IV7/IV30 > 1.3）时，对「短期卖权」在统一分中降权：CREDIT_SPREAD 且 DTE ≤ 30 的候选，其 Regime 分量乘以 0.55，而不仅是 advice 文案提示。

**Skew 细粒度 (2026-02-12)**：
- **信用价差内部 (CSQ)**：Skew 不再固定 ±10 分。`getSkewBonusForCreditSpread(skew, type)` 按 |skew| 调节加分：Put 信用在 skew>0.05 时、Call 信用在 skew<-0.05 时，加分从 5 线性增至 15（|skew| 在 0.05～0.25 间），有上限。
- **Unified Score**：当「Skew 有利于该策略」时，对信用价差候选在统一分上额外加 5～10 分（`getSkewFavorForUnifiedScore`），使 Top Picks 跨策略排序时能体现 Skew 优势。`calculateUnifiedScore` 支持可选第五参数 `skewOpt = { skew, creditSpreadType }`，仅 Credit Spread 传入。
- **后续迭代**：可考虑用 Skew 调节价差宽度（例如 put skew 很陡时 put 信用价差略放宽宽度），见 `scoring.cjs` 内注释。

**前端变更**：
- 新增 "Top Picks" Tab（带 Trophy 图标），作为默认首选 Tab
- 展示所有 ~15 个候选策略，按 `unifiedScore` 统一排序
- 每张卡片显示：统一分数（大字）+ 策略类别徽章（Credit 红 / Debit 蓝 / Long 紫）+ 原始类内分数（辅助）
- 原有三个策略 Tab 不变，仍用各自内部评分排序

**文件变更**：
| 文件 | 变更 |
|------|------|
| `api/_shared/scoring.cjs` | 新增 `normalizeEVRisk`、`calculateLiquidityScore`、`calculateRegimeBonus(strategyCategory, regimeMode, ivRvRatio, termStrength)`、`calculateUnifiedScore(..., opts)`；opts 含 `anomaly`/`termStrength`/`skew`/`creditSpreadType`；anomaly 时短期 Credit 降权 |
| `api/strategy-recommend.js` | `detectRegime` 返回 `slope`、`slopeTier`；CREDIT/DEBIT 建议文案区分 strong 档；Top Picks 传入 `unifiedOpts`（anomaly、termStrength）及 credit 的 skew/creditSpreadType |
| `src/lib/types.ts` | 新增 `StrategyCategory`、`UnifiedCandidateType`；`StrategyResult.strategies` 增加 `TOP_PICKS` |
| `src/pages/StrategyRecommender.tsx` | 新增 Top Picks Tab、类别徽章、统一分数展示 |

### Portfolio 价差快速添加 & 策略推荐 Spread Width (2026-02-09)

**Portfolio Quick Add Spread 支持**：

原 "Quick Add Position" 表单仅支持单腿期权。新增信用/借记价差直接添加能力。

| 文件 | 变更 |
|------|------|
| `src/lib/types.ts` | `DirectAddItem` 新增 `legs?: PositionLeg[]` 字段 |
| `src/pages/Portfolio.tsx` | 新增 `positionType` 状态（single/credit/debit）、`strike2` 表单字段、Position Type 三按钮切换、条件式 Strike 布局、动态 Entry Price 标签、`handleSubmit` 构建 legs |
| `src/App.tsx` | `onAddDirect` Supabase insert 新增 `legs: item.legs \|\| null` |

**数据流**：Portfolio 表单 → `DirectAddItem`（含 legs）→ `App.onAddDirect` → Supabase `positions` 表（legs JSONB）→ `PositionCard` 自动识别价差

**策略推荐 Spread Width 可配置**：

原策略推荐器的 spread width 硬编码为 Credit `[5, 10]` / Debit `[2.5, 5]`。新增前端选择器和 API 参数。

| 文件 | 变更 |
|------|------|
| `src/pages/StrategyRecommender.tsx` | 新增 `spreadWidth` 状态（默认 $5）、4 按钮选择器（$2.5 / $5 / $10 / $20）、API URL 传 `&spreadWidth=` |
| `api/strategy-recommend.js` | 接收 `spreadWidth` query param、`buildCreditSpreads` / `buildDebitSpreads` 支持 `customWidth` 参数 |
| `vite.config.ts` | 本地 dev 的 `buildCreditSpreads` / `buildDebitSpreads` 同步支持 `widthOverride` 参数 |

**注意**：本地开发时 `/api/strategy-recommend` 由 `vite.config.ts` 中的 `localApiPlugin` 处理（非 `api/strategy-recommend.js`），两处逻辑需同步维护。

**iOS / 移动端优化 (2026-02-09)**：
- `.input-field` CSS 类添加 `text-base`（16px），防止 iOS Safari 对 <16px 输入框自动缩放
- 价差 Strike 字段：移动端 `grid-cols-2`（Short/Long 并排，Type 全宽），桌面端 `grid-cols-3`
- Position Type 切换按钮：`py-3` 确保 ≥44px 触控目标
- 数字输入添加 `inputMode="decimal"` 显示 iOS 小数键盘
- 策略推荐 Spread Width 按钮：`py-2.5 px-2`、容器 `md:w-56`

### 部署与基础设施 (2026-02-08)
- 修复 `.gitignore`：排除 `dist/`、`.env`、`.env.local`，防止构建产物污染仓库。
- 从 Git 中移除已提交的 `dist/` 目录。
- 移除 `vercel.json` 中的 `crons` 配置（Hobby 计划限制，此配置会导致部署失败）。
- 新增 Deploy Hook 用于手动触发 Vercel 部署（GitHub Webhook 不稳定时的备选方案）。
- 新增 `api/health.js` 健康检查端点，用于验证部署是否成功。

---

## Discord 自动提醒系统

### 概述

当 Active 持仓的当前价格触及**止损**或**目标价**时，系统自动发送 Discord 推送提醒。

### 架构

```
cron-job.org (每 15 分钟 GET)
    ↓
/api/check-alerts?secret=CRON_SECRET
    ↓
1. 鉴权（CRON_SECRET）
2. Supabase REST API 查询 Active 持仓 + 交易记录
3. 逐笔调用 /api/option-price 获取当前价
4. 按止损/目标价规则判断是否触及
5. 触及 → Discord Webhook POST（Embed 格式）
```

### 止损规则

| 策略类型 | 止损价计算 | 触发条件 |
|----------|-----------|----------|
| Debit（买方） | 入场价 × 0.5（无部分止盈）或 × 0.75（有部分止盈） | 当前价 ≤ 止损价 |
| Credit（卖方） | 入场价 × 1.5 | 当前价 ≥ 止损价 |

### 技术实现

- **`api/check-alerts.js`**：不依赖 `@supabase/supabase-js` SDK，直接用 `fetch` 调 Supabase REST API（PostgREST），避免 Vercel Serverless 的 ESM import 兼容问题。
- **鉴权**：通过 `?secret=` 查询参数或 `Authorization: Bearer` 头部与环境变量 `CRON_SECRET` 比对。
- **外部 Cron**：使用 [cron-job.org](https://cron-job.org)（免费），每 15 分钟 GET 调用一次。

### 配置步骤

1. Discord：建服务器 → 建 #alerts 频道 → 创建 Webhook → 复制 URL
2. Vercel：Settings → Environment Variables → 设置 `DISCORD_WEBHOOK_URL` 和 `CRON_SECRET`
3. cron-job.org：新建 Job → URL 填 `https://trading-journal-yuchen.vercel.app/api/check-alerts?secret=你的密钥` → 间隔 15 分钟

---

## 故障排除

### 价格获取失败

1. 检查网络连接
2. 确认 ticker/expiration/strike/type 参数正确
3. 若使用 Polygon：检查 `DATA_SOURCE=POLYGON` 与 `POLYGON_API_KEY`；详见 `docs/09_Polygon集成.md`
4. 若使用 MarketData：检查 `DATA_SOURCE=MARKET_DATA` 与 `MARKET_DATA_TOKEN`；失败时会自动降级 CBOE
5. CBOE 备用可能暂时不可用或返回 429，稍后重试
6. 使用手动输入作为备用

### 常见错误

| 错误 | 原因 | 解决 |
|------|------|------|
| "Option contract not found" | 合约不存在或已过期 | 检查到期日 |
| "CBOE API error: 404" | Ticker 不支持 | 确认是美股期权 |
| Polygon 返回 401/403 | API Key 无效或过期 | 检查 `POLYGON_API_KEY` |
| MarketData 返回 401/403 | Token 无效或过期 | 检查 `MARKET_DATA_TOKEN` |
| 响应中 Greeks 全为 0 | 当前使用 CBOE 或主数据源未配置 | 配置 `DATA_SOURCE` 与对应 API Key/Token 后部署 |
| Network error | 网络问题 | 检查连接 |

### 部署问题

| 问题 | 原因 | 解决 |
|------|------|------|
| 推送后 Vercel 没有自动部署 | GitHub → Vercel Webhook 断连 | 用 Deploy Hook 或 `npx vercel --prod` 手动部署 |
| Vercel 部署报 "Hobby accounts are limited to daily cron jobs" | `vercel.json` 包含高频 crons 配置 | 删除 `crons` 配置，改用外部 cron 服务 |
| 新 API 端点 404 但旧端点正常 | Vercel 仍在使用旧的成功部署 | 确认最新部署是 Ready 状态；如不是，查看 Build Logs |
| `dist/` 被提交到 Git | `.gitignore` 缺少 `dist` | 已修复：`dist`、`.env`、`.env.local` 已加入 `.gitignore` |

---

## 附录: 完整 SQL Schema

```sql
-- 如果需要重建数据库，运行以下 SQL

-- 删除旧表（如果存在）
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS positions;

-- 创建 positions 表
CREATE TABLE positions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    ticker VARCHAR(20) NOT NULL,
    strike DECIMAL(10,2) NOT NULL,
    type VARCHAR(50) NOT NULL,             -- "Call"/"Put" 或 "Credit Put Spread" 等
    expiration DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'watchlist' CHECK (status IN ('watchlist', 'active', 'closed')),
    setup VARCHAR(50),
    entry_score INTEGER,
    current_score INTEGER,
    score_updated_at TIMESTAMPTZ,
    ideal_entry DECIMAL(10,2),
    current_price DECIMAL(10,2),
    stop_reason TEXT,
    target_price DECIMAL(10,2),
    stop_price DECIMAL(10,2),             -- 手动止损价
    notes TEXT,
    legs JSONB,                           -- 价差腿: [{strike, type, side, expiration}, ...]
    created_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ
);

-- 创建 transactions 表
CREATE TABLE transactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    position_id UUID REFERENCES positions(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL CHECK (type IN ('Open', 'Size Up', 'Size Down', 'Take Profit', 'Close')),
    quantity INTEGER NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    date TIMESTAMPTZ DEFAULT NOW(),
    note TEXT
);

-- 启用 RLS
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- 创建策略
CREATE POLICY "Allow all on positions" ON positions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on transactions" ON transactions FOR ALL USING (true) WITH CHECK (true);

-- 创建索引
CREATE INDEX idx_positions_status ON positions(status);
CREATE INDEX idx_transactions_position_id ON transactions(position_id);
```

---

*文档结束*
