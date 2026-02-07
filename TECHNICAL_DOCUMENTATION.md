# Trading Journal - 技术文档

> 最后更新: 2026年2月7日

## 项目概述

这是一个为期权交易设计的个人交易日志Web应用，专注于**执行纪律**而非单纯记录。

### 核心问题解决

| 问题 | 解决方案 |
|------|----------|
| 入场无纪律（感觉对就买） | Watchlist + Scanner Score 强制计划 |
| 出场靠情绪（亏70%才割肉） | Stop Loss 规则 + 视觉警告 |
| 时间漂移（短线变长线） | 到期日警告 + 持仓天数追踪 |
| 记录难坚持（Notion用几天就放弃） | 30秒快速操作 + 手机友好 |
| 手动更新价格麻烦 | **自动获取期权价格 (CBOE API)** |

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
│  api/_shared/scoring.js  ← 与 oss-core.ts 镜像，单点事实         │
│  /api/option-price.js    → 单合约价格 + Greeks                   │
│  /api/scan-options.js    → OSS 扫描器 (引用 _shared/scoring)     │
│  /api/strategy-recommend.js → 策略推荐 (引用 _shared/scoring)     │
│  /api/underlying-rv.js   → 标的 RV；/api/earnings.js → 财报日期   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Supabase Backend                             │
│  PostgreSQL + REST API + Realtime + Auth                         │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│            External: CBOE Delayed API + Nasdaq API               │
│  cdn.cboe.com (期权链/报价) | api.nasdaq.com (历史/财报)          │
└─────────────────────────────────────────────────────────────────┘
```

### OSS 评分架构（单点事实）

| 层级 | 文件 | 职责 |
|------|------|------|
| **规范源** | `src/lib/oss-core.ts` | 所有 LOQ/CSQ/Delta Bonus/Theta 惩罚/Lambda 压缩/Z-Score/价差评分；LERP、Sigmoid、边缘情况防护 |
| **前端复用** | `src/lib/scoring.ts` | 从 oss-core  re-export；额外提供批量 `scoreOptionsChain`、IV 期限结构 `calculateIVRatio` |
| **API 镜像** | `api/_shared/scoring.js` | 与 oss-core 逻辑同步的 JS 实现，供 `scan-options.js`、`strategy-recommend.js` 引用 |

**原则**：不在此三处以外重复实现评分公式，避免前后端/扫描器与持仓卡片分数不一致。

### 技术选择理由

| 技术 | 选择理由 |
|------|----------|
| Single HTML | 无需build，直接部署，易于维护 |
| React (CDN) | 组件化开发，状态管理清晰 |
| Tailwind CSS | 快速styling，dark mode友好 |
| Supabase | 免费tier够用，PostgreSQL可靠，实时同步 |
| Vercel | 免费，自动HTTPS，全球CDN，Serverless Functions |
| **CBOE API** | 官方数据源，免费，无速率限制，包含Greeks |

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

```json
{
  "success": true,
  "symbol": "QQQ   260220C00630000",
  "price": 7.36,
  "priceSource": "mid",
  "bid": 7.32,
  "ask": 7.39,
  "lastPrice": 7.35,
  "iv": 0.1778,
  "delta": 0.3999,
  "volume": 6485,
  "openInterest": 29600,
  "underlyingPrice": 620.24,
  "dataSource": "CBOE",
  "timestamp": 1769901862738
}
```

### 数据字段说明

| 字段 | 说明 |
|------|------|
| price | 计算后的价格（优先用 mid price） |
| priceSource | 价格来源：mid（买卖中间价）或 last（最后成交价） |
| iv | 隐含波动率 (Implied Volatility) |
| delta | Delta 值（期权敏感度） |
| volume | 当日成交量 |
| openInterest | 未平仓合约数 |
| underlyingPrice | 标的股票当前价格 |

### 数据源

使用 CBOE (Chicago Board Options Exchange) 官方延迟数据 API：
```
https://cdn.cboe.com/api/global/delayed_quotes/options/{TICKER}.json
```

- **延迟**: 15分钟
- **成本**: 免费
- **限制**: 无严格速率限制
- **覆盖**: 所有美股期权

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
    strike DECIMAL(10,2) NOT NULL,         -- 行权价 e.g. 630.00
    type VARCHAR(10) NOT NULL,             -- "Call" 或 "Put"
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
    notes TEXT,                            -- 交易笔记
    created_at TIMESTAMPTZ DEFAULT NOW(),  -- 创建时间
    closed_at TIMESTAMPTZ                  -- 平仓时间
);
```

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
│   │   ├── types.ts         # 全局类型 (Position, WatchlistItem, StrategyResult 等)
│   │   ├── supabase.ts
│   │   ├── utils.ts
│   │   └── greeksHistory.ts
│   ├── components/
│   ├── pages/
│   ├── App.tsx
│   └── main.tsx
└── api/
    ├── _shared/
    │   └── scoring.js       # 与 oss-core.ts 镜像，供 Serverless 使用
    ├── option-price.js
    ├── scan-options.js      # OSS 扫描器，引用 _shared/scoring
    ├── strategy-recommend.js
    ├── underlying-rv.js
    └── earnings.js
```

### 当前部署

```
网址: https://trading-journal-git-main-chans-projects-332f0497.vercel.app
Hosting: Vercel
GitHub: https://github.com/yauyueson/trading-journal
```

### 更新流程

1. 修改文件
2. 上传到 GitHub 仓库
3. Vercel 自动重新部署

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
- 新增/统一类型：`WatchlistItem`、`DirectAddItem`、`StrategyResult`、`SpreadRecommendation`、`SingleLegRecommendation`、`PositionAction`、`RollData` 等，消除评分与页面中的 `any`。
- 数学与数据边界：`lerp` 防除零、`sigmoid` 输入裁剪、`normalizeToZScores` 在 n&lt;2 或 std=0 时的防护、DTE≤0 过滤、低价期权 Lambda 防护。

### 扫描器性能
- `scan-options.js` 单遍完成过滤与指标计算，减少多轮遍历。
- 流动性：显式要求 `bid > 0 && ask > 0`，并在解析阶段做 DTE/行权价预过滤。

---

## 故障排除

### 价格获取失败

1. 检查网络连接
2. 确认 ticker/expiration/strike/type 参数正确
3. CBOE API 可能暂时不可用，稍后重试
4. 使用手动输入作为备用

### 常见错误

| 错误 | 原因 | 解决 |
|------|------|------|
| "Option contract not found" | 合约不存在或已过期 | 检查到期日 |
| "CBOE API error: 404" | Ticker 不支持 | 确认是美股期权 |
| Network error | 网络问题 | 检查连接 |

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
    type VARCHAR(10) NOT NULL CHECK (type IN ('Call', 'Put')),
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
    notes TEXT,
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
