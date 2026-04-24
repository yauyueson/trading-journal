# 更新日志 (CHANGELOG)

所有重要的项目更改都将记录在此文件中。

---

## [5.1.0] - 2026-04-24

### 死代码清理 + 退役 DTE5 基础设施（PR #16, #17）

F1 平台改造之后的两轮清理，合计移除 ~1,400 行 DTE5/shortTerm 死代码。无行为变化，1213 测试全绿。

#### 删除（PR #17 — 781 行 + 153 行）
- ❌ `api/cron-signal-scan.js`（782 行）— 每日 QQQ EMA55 扫描 + 10-min→130M 汇总。F1 改造后无活跃策略消费，外部 cron 命中将 404（预期 no-op）。
- ❌ `src/hooks/useSignalScanner.ts`（153 行）— 前端 tech-score 扫描 hook。唯一调用者在 Phase B 改造时被删除。
- 同步删除 `vercel.json` 的 `cron-signal-scan.js` maxDuration 条目；`tests/migration-130m.test.ts` 的 130M-02 / 130M-03 describe 合并为 "retired under F1 revamp"。

#### 删除（PR #16 — 341 行）
- ❌ `src/components/SpreadPickerModal.tsx`（256 行）— 旧 DTE5 信号到价差选择器。F1 改造后 Dashboard 停止引用。
- ✅ Portfolio.tsx / Stats.tsx 内联 `LEGACY_STRATEGIES` 数组去重 → 统一使用 `strategyProfiles.ts` 导出的 `RETIRED_STRATEGIES` Set。
- ✅ `src/lib/strategyConfig.ts` 剪除 85 行死导出（`useStrategyConfig`, `getBuildTimeConfig`, `getConfigProfile`, `StrategyConfig` / `StrategyConfigProfile` 类型）。保留 `getDefaultCreditSpreadConfig`（Settings 页面重置按钮使用）。

#### 保留（故意）
- 130M backtest 基础设施（cache, `intraday-cache.ts`, `backtest-data.js` 130M 路径）— 历史回测脚本仍需使用。
- `api/strategy-recommend.js` + `api/scan-options.js` — 仍为 Options Selector 页面服务。
- Academy 页面的 shortTerm/130M 教学内容 — 纯教育用途。

---

## [5.0.0] - 2026-04-23

### Phase F0 clean-slate + Phase F1 platform revamp (PR #14, #15)

#### Phase F0 — 有效尝试计数器重置
- ✅ **Pre-reg 公告**: `docs/phase-f0-clean-slate-declaration.md` — 将 global attempt N=106 重置，通过 `F0_BOUNDARY_ISO = '2026-04-23T02:20:00Z'` 边界过滤旧 trials。
- ✅ **实现**: `scripts/autoresearch/lib/f0-boundary.ts` 提供 `countEffectiveAttempts()` + `deflatedSharpeAt()`；sealer 用 F0-effective N 重新计算 dsrM，与 global N 并列记录。
- ✅ **Binding commitments**: 无进一步 resets 直至 2026-10；6 gates 为 floor；第一个 F1 adoption 不能 near-boundary on dsrM。

#### Phase F1 — 两个并行策略封存（6/6 PASS each）
- ✅ **PMCC QQQ pt60**（`strategy_type='pmcc'`，$10K+）：long LEAP call δ 0.70-0.80, DTE 240-300；short monthly δ 0.20-0.30, DTE 30-45。long PT 60%，short PT 50%，long SL 35%，2% moneyness 滚动。Seal: `docs/holdout-evaluations/2026-04-23-7e9c2026f3df.md`（oosSharpe 1.72, holdoutSpyIR +0.15, dsrM (F0-eff N=25) +0.845）。
- ✅ **BCD QQQ wide**（`strategy_type='bcd'`，$2K）：long call δ 0.50 / short δ 0.20, DTE 30-60, PT 50%。10 交易日信号触发 + maxPositions=1 flat-gate。Seal: `docs/holdout-evaluations/2026-04-23-25880326cfe1.md`（oosSharpe 0.97, holdoutSpyIR +0.40, dsrM (F0-eff N=30) +0.065）。

#### 平台改造（5 phases: foundations → display → entry → auto-tracking → docs）
- ✅ **Phase A 基础**: `StrategyType` 扩展为 `'bcd'` / `'pmcc'`；`StrategyProfile` 新增 `kind` 区分器 (`'credit_spread' | 'debit_spread' | 'diagonal'`)；`getStrategyKind()` + `computePositionPnL` 支持四种 kind。`RETIRED_STRATEGIES` 包含 DTE5。
- ✅ **Phase B 显示**: Dashboard 多策略板 + hero P&L 跨 `ACTIVE_STRATEGIES` 汇总；Signals tabs (BCD / PMCC)；Portfolio + Stats 新增 Legacy chip；PositionCard strategy badge 按 `strategy_type` 着色。
- ✅ **Phase C 入场**: 新增 `BCDEntryModal` 和 `PMCCEntryModal`（PMCC 两条腿独立过期日，手动输入履约 + 到期 + 净 debit）。
- ✅ **Phase D 自动跟踪**: `api/check-alerts.js` 跳过 BCD/PMCC（DTE5 SL 2.5x / TL 50/50 不适用）；PositionCard 加上每策略触发标识（BCD "PT 50%"，PMCC 短腿 DTE 倒计时 + 2% moneyness 滚动）。

#### Codex 审查
- PR #15 adversarial review 捕捉到 v1 seal 的 "fixed 10-day cadence" 措辞过强（实际是 emission + maxPositions=1 flat-gate）。v2 pre-reg 修正文字 + 新 audit row → 重新封存（block hash `25880326cfe1`）。
- PR #15 独立 code review: 无新 findings。

#### 测试
- Tests: 1206 → 1214 → 1213（F0 boundary, computePositionPnL kind-argument, riskSizing debit/diagonal, 130M-02/03 consolidated）。

---

## [4.0.0] - 2026-03-23

### 130M Migration + Scoring Overhaul

#### 130M 短线策略迁移（替代 4H）
- ✅ **130M timeframe**: 3×130min bars = 精确 390min regular session，替代 4H 作为短线策略
- ✅ **Production config**: `em|tp50|w10|iv20|dsoff|pm2.25` → OOS Sharpe 2.22, WR 84.6%
- ✅ **数据管线**: Tiingo IEX 10-min bars → 130M aggregation, Supabase `stock_candles` block-encoded cache (`130M_0/1/2`)
- ✅ **Cache-first pattern**: Supabase cache → 10-min top-up → 1H fallback (approximate, UI warning)
- ✅ **Daily top-up**: 合并进 `cron-signal-scan.js`（21:00 UTC weekdays），不需独立 cron
- ✅ **130M vs 4H study**: 648 configs/arm, 15 tickers, 7 rolling windows → 130M has 2× Sharpe edge

#### Scoring 系统改进 Phase 1
- ✅ **VRP (IV²-RV²)**: ±10pt adjustment in credit/debit builder scoring (`strategy-recommend.js`)
- ✅ **orFcst20d**: clamp widened ±0.8 → ±2.0 (×8 multiplier → max ±16pt impact, modulated by R²)

#### Multicore WFA
- ✅ **Worker cap removed**: `Math.min(4, cpus-2)` → `Math.max(1, cpus-2)` in `wfa-run.ts`, `wfa-run-unified.ts`

#### 新增文件
- `scripts/prefetch-130m.mjs` — 130M candle prefetch for all 27 watchlist tickers
- `tests/migration-130m.test.ts` — 38 migration validation tests (config, data path, aggregation, pipeline)
- `src/hooks/useSignalScanner.ts` — Signal scanner hook with 130M + approxTickers tracking

#### WFA Results Viewer
- ✅ **Live at `/backtest`**: loads from `data/wfa-results.json` (5556 OOS trades, 12 windows, 14 tickers)
- Overall WFA metrics: OOS Sharpe 1.275, WR 89.52%, Max DD 4.64%

#### 测试
- Tests: 520 → 683 (across 18 files)

---

## [3.1.0] - 2026-03-14

### WFA-Driven Workflow Integration

5-phase milestone operationalizing WFA-validated trading edge into daily execution flow.

- ✅ **Phase 1**: Prerequisite fixes — ivRankMin, activeProfile param naming, WFA info card
- ✅ **Phase 2**: Data contract + API foundation — target_price, strategy-aware defaults, signal URL params
- ✅ **Phase 3**: Spread builder integration — signal context banner, IV rank gate, TP auto-fill
- ✅ **Phase 4**: Global strategy toggle — AppLayout header toggle, strategy-aware defaults across pages
- ✅ **Phase 5**: Scanner removal + MOM signal — Scanner page removed, `deriveSignalType` for EMA/MOM

#### 测试
- Tests: 241 → 520 (307 parity + 48 oss-core + 19 riskSizing + 10 tech-parity + 33 backtest + 32 bsm + others)

---

## [3.0.0] - 2026-03-05

### 🏗️ 架构重构: React Router + React Query + 自动化测试

#### 核心架构变更
- ✅ **React Router v6**: 所有页面有独立 URL（`/portfolio`, `/scanner`, `/history` 等），浏览器前进/后退正常工作，支持书签与直链
- ✅ **React Query v5 (TanStack Query)**: 数据缓存（30s staleTime），切换标签不再重新加载，mutation 自动失效对应缓存
- ✅ **懒加载路由**: 每个页面独立 chunk，初始包从 ~983KB 降至 ~430KB
- ✅ **Context 架构**: AuthContext（认证）、BuyModalContext（买入弹窗）、AppSettingsContext（全局设置）
- ✅ **消除 Prop Drilling**: 9 个回调函数不再逐层传递，页面通过 hooks 自行获取数据和执行操作

#### 新增文件
- `src/router.tsx` — React Router 路由配置（懒加载）
- `src/lib/queryClient.ts` — React Query 客户端配置
- `src/lib/queryKeys.ts` — 类型化缓存 key 工厂
- `src/hooks/usePositions.ts` — 持仓数据 hook
- `src/hooks/useTransactions.ts` — 交易记录 hook
- `src/hooks/useEarnings.ts` — 财报日期 hook（4h staleTime）
- `src/hooks/useBulkOptionPrices.ts` — 批量期权价格 hook
- `src/hooks/useStrategyRecommend.ts` — 策略推荐 hook
- `src/hooks/usePositionMutations.ts` — 11 个 mutation hooks（替代 App.tsx 中的 9+ 回调）
- `src/hooks/useRealtimeInvalidation.ts` — Supabase 实时订阅 → React Query 缓存失效
- `src/context/AuthContext.tsx` — 认证上下文
- `src/context/BuyModalContext.tsx` — 买入弹窗上下文
- `src/layouts/AppLayout.tsx` — 应用 Shell（Header + TabNav + Outlet）
- `src/components/strategy/PayoffDiagram.tsx` — 从 StrategyRecommender 提取的收益图组件
- `eslint.config.js` — ESLint 9 flat config
- `src/test/setup.ts` — Vitest 测试环境配置
- `.github/workflows/ci.yml` — GitHub Actions CI（lint → build → test）

#### 测试体系（241 tests）
- `tests/scoring-parity.test.ts` — **174 项对等测试**：确保 `oss-core.ts`（前端）与 `scoring.cjs`（API）对所有共享函数输出一致
- `src/lib/__tests__/oss-core.test.ts` — **48 项单元测试**：评分函数已知 input→output 回归验证
- `src/lib/__tests__/riskSizing.test.ts` — **19 项单元测试**：持仓定寸、Kelly、组合 Greeks、集中度预警

#### Bug 修复（测试发现）
- 🐛 **scoring.cjs `calculateExpectedValue`**: 缺少 `exitMultiplier` 参数（默认 0.75），导致 API 侧 EV 偏差 15-25%。已修复同步。
- 🐛 **tech-analysis.ts**: 第 290 行逗号表达式 bug（`type = "PUT", conf = 3` → `type = "PUT"; conf = 3`）

#### 技术栈新增
- `@tanstack/react-query@5` — 数据缓存与同步
- `react-router-dom@6` — 客户端路由
- `vitest` — 测试运行器
- `@testing-library/react` + `@testing-library/jest-dom` — 组件测试工具
- `eslint@9` + `@typescript-eslint` — 代码质量

#### 架构对比

| 方面 | Before (v2.x) | After (v3.0) |
|------|---------------|--------------|
| 路由 | `activeTab` useState | React Router v6 URL 路由 |
| 数据获取 | `fetchData()` 全量刷新 | React Query 缓存 + 精确失效 |
| 状态管理 | App.tsx 617 行 + 9 回调 prop drill | 自治页面 + hooks + contexts |
| 初始包大小 | ~983KB | ~430KB（懒加载） |
| 测试 | 0 | 241（parity + unit） |
| CI/CD | 无 | GitHub Actions lint→build→test |

---

## [2.1.0] - 2026-02-12

### 策略推荐 / 扫描器：仅请求所需到期与行权范围 + 期权链短期缓存

- **strategy-recommend**（Polygon）：先请求标的价 `getUnderlyingPrice`，再仅拉取 **DTE 30 / 90** 与 **行权价 ±20%** 的期权链，减少 payload 与 API 用量。
- **scan-options**（Polygon）：先请求标的价，再按 `strikeRange` 传 **minStrike/maxStrike** 给 Polygon，只拉会用到的行权范围。
- **polygon-client**：同一 ticker 的期权链按 **(ticker + 筛选参数)** 做 **1 分钟内存缓存**，同一用户短时间重复请求直接命中缓存，降低成本并保持算法一致。
- 修复：scan-options 在 Polygon 路径下返回 `cboeTimestamp` 时不再引用未定义的 `data`。

### 长期 (Long-term)

- **历史 IV 回测与多数据源**：计划支持历史 IV 曲线回测（如按日存储的 IV 分位数、期限结构），以及聚合多数据源（Polygon + CBOE 或其它）做冗余与成本优化。当前 IV Rank 已基于单数据源历史快照；后续可扩展为多源比对与回测框架。

---

### 策略推荐 IV Rank 恢复（中期）

- **strategy-recommend** 中 **Credit Spread**、**Debit Spread**、**Single-leg (LOQ)** 均接入 IV Rank 调整。
- 买方（LOQ、Debit Spread）使用 `getIVRankAdjustment(ivRank, 'long')`：IV Rank 高略降分、低略加分。
- 卖方（Credit Spread）使用 `getIVRankAdjustment(ivRank, 'short')`：IV Rank 高略加分、低略减分。
- 数据流：请求时 `buildIVTermStructure` → `saveTickerIVSnapshot(iv30, iv90)` → `getIVRank(ticker)`，与 backfill 同源，IV Rank 随时间积累变准。
- 技术文档已更新：`docs/03_核心算法.md`、`docs/08_IV_Rank_上线步骤.md`、`docs/04_数据库设计.md`、`docs/05_API文档.md`、`docs/算法改进总览_OSS_v2.2.md`、`TECHNICAL_DOCUMENTATION.md`。

---

### 🔄 重大更新: MarketData.app → Polygon.io 数据源迁移

#### 核心变更
- ✅ **Polygon.io (MASSIVE) 集成**
  - 完全替换 MarketData.app 作为主要数据源
  - 高质量实时期权数据 + Greeks + IV
  - 企业级 API 稳定性和可靠性

#### 技术实现
- **新增文件**
  - `api/polygon-client.js` - Polygon.io 客户端模块（替换 market-data-client.js）
  - `docs/09_Polygon集成.md` - 完整集成文档

- **更新的 API 端点** (7个)
  - `api/option-price.js` - 单个期权定价
  - `api/scan-options.js` - Scanner 扫描器
  - `api/strategy-recommend.js` - 策略推荐
  - `api/option-prices-bulk.js` - 批量定价（并发优化）
  - `api/check-alerts.js` - 告警检查
  - `api/daily-recap.js` - 每日汇总
  - `api/backfill-iv-history.js` - IV 历史回填

#### API 功能映射
| 功能 | Polygon.io 端点 |
|------|----------------|
| 期权链 | `/v3/reference/options/contracts` |
| 期权快照 | `/v3/snapshot/options/{underlying}/{contract}` |
| 历史K线 | `/v2/aggs/ticker/{ticker}/range/{timespan}` |

#### 数据格式适配
- 响应格式从 MarketData 的列式数组转为 Polygon 的嵌套对象
- Greeks 字段映射：`greeks.delta/gamma/theta/vega`
- IV 路径更新：`greeks.implied_volatility`
- 自动计算 DTE (Days To Expiration)

#### 性能优化
- 批量请求分块处理（CHUNK_SIZE = 10）
- 5 秒内存缓存机制
- CBOE fallback 保留为备用数据源

#### 配置变更
- **环境变量更新**:
  - ~~`MARKET_DATA_TOKEN`~~ → `POLYGON_API_KEY`
  - `DATA_SOURCE=MARKET_DATA` → `DATA_SOURCE=POLYGON`

#### 文档更新
- ✅ 更新 `docs/00_PRD_总览.md` - 数据源引用
- ✅ 新增 `docs/09_Polygon集成.md` - 完整迁移指南
- ✅ 更新 CHANGELOG.md

#### 验证测试
- ✅ Scanner API 测试通过（AAPL, 46 results, Greeks 完整）
- ✅ Option Price API 正常工作
- ⚠️ 需求：Polygon subscription 需包含 Options Advanced features

#### 迁移影响
- **向后兼容**: CBOE fallback 保留，未配置 Polygon 时自动降级
- **成本变化**: Polygon.io Starter plan ($99/月) vs MarketData.app
- **速率限制**: 需监控 API 使用量，避免触发 429 错误

---

## [2.0.0] - 2026-02-12

### 🎉 重大更新: MarketData.app 集成

#### 新增功能
- ✅ **MarketData.app 数据源集成**
  - 实时期权报价（无延迟）
  - 交易所级 Greeks（Delta/Gamma/Theta/Vega/IV）
  - 完整 IV Term Structure（IV7-IV120）
  - 智能数据源切换（MarketData → CBOE 备用）

- ✅ **IV Term Structure 构建**
  - 新增 `buildIVTermStructure()` 函数
  - 支持 6 个 DTE 点：IV7, IV14, IV30, IV60, IV90, IV120
  - 异常检测：自动识别 Earnings Spike（IV7/IV30 > 1.3）

- ✅ **Skew 计算精准化**
  - 真实 25-delta Put/Call Skew 计算
  - Skew-aware 策略选择优化

- ✅ **Regime Detection 增强**
  - 基于完整 IV 曲线的精准判断
  - 不再频繁 fallback 到 NEUTRAL
  - 新增 `adviceDetail` 详细建议

#### 更新的 API 端点
- `api/strategy-recommend.js`
  - 新增 `regime.ivSurface` 对象
  - 新增 `regime.adviceDetail` 字段
  - 支持 MarketData 数据源

- `api/scan-options.js`
  - 真实 Greeks 支持
  - 精准 Delta Bonus 计算
  - MarketData 优先，CBOE 备用

- `api/option-price.js`
  - 实时报价（非 15 分钟延迟）
  - 完整 Greeks 数据
  - 数据源标识 `dataSource` 字段

- `api/check-alerts.js`
  - 实时止损/目标价监控
  - 支持多腿策略 Net Value 计算
  - MarketData 集成

- `api/daily-recap.js`
  - 实时持仓价格
  - 精确 P&L 计算
  - 格式无关的价格查找

#### 新增文件
- `api/market-data-client.js` - MarketData.app 客户端模块
- `docs/09_MarketData集成.md` - 完整集成文档
- `MARKETDATA_DEV_GUIDE.md` - 开发者测试指南

#### 算法优化
- `api/_shared/scoring.cjs`
  - `parseChain()` 智能格式检测
  - `buildIVTermStructure()` IV 曲线构建
  - `calculateSkew()` 自动生效（真实 delta）

#### 文档更新
- 更新 `README.md` - 添加 MarketData 集成说明
- 更新 `docs/05_API文档.md` - 数据源配置和对比
- 更新 `docs/02_技术路径.md` - 架构更新

#### 配置变更
- 新增环境变量：
  - `DATA_SOURCE` - 数据源选择（MARKET_DATA/CBOE）
  - `MARKET_DATA_TOKEN` - MarketData.app API Token

- `vite.config.ts` 文档化
  - 添加 Vite dev 环境限制说明
  - 提供完整测试方案

---

## [1.5.0] - 2026-02-10

### 新增功能
- ✅ **OSS v2.3 算法升级**
  - DTE 分桶 Z-Score 标准化
  - 候选池 Hard Filters
  - 真实到期 Breakeven 计算

### 优化
- 改进流动性筛选逻辑
- 优化 Lambda 压缩算法

---

## [1.4.0] - 2026-02-08

### 新增功能
- ✅ **Discord 自动提醒**
  - 止损/目标价触发提醒
  - 每日持仓汇总
  - 外部 Cron 集成

### 修复
- 修复 Vercel Hobby 计划 Cron 限制
- 优化 Supabase REST API 调用

---

## [1.3.0] - 2026-02-07

### 新增功能
- ✅ **策略推荐引擎**
  - Credit Spreads
  - Debit Spreads
  - Long Options
  - IV Regime Detection

### 优化
- 改进评分算法一致性
- 统一前后端评分逻辑

---

## [1.2.0] - 2026-02-05

### 新增功能
- ✅ **Greeks 历史图表**
- ✅ **Portfolio 自动刷新**
- ✅ **Scanner UI 增强**

### 修复
- 修复 Tooltip 显示问题
- 优化移动端适配

---

## [1.1.0] - 2026-02-04

### 新增功能
- ✅ **OSS v2.2 算法**
  - Delta Bonus (LERP)
  - Theta 上限 10
  - Lambda 压缩

### 优化
- 改进评分权重
- 优化过滤逻辑

---

## [1.0.0] - 2026-02-03

### 初始发布
- ✅ 基础持仓管理
- ✅ 期权扫描器
- ✅ Supabase 集成
- ✅ CBOE API 集成

---

## 版本说明

版本号格式：`MAJOR.MINOR.PATCH`

- **MAJOR**: 重大架构变更或不兼容更新
- **MINOR**: 新功能添加
- **PATCH**: Bug 修复和小优化

---

*最后更新: 2026年3月23日*
