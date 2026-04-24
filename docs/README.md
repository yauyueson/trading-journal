# Trading Journal - 文档总览

> 最后更新: 2026年4月24日

> **✅ 当前活跃策略 (Phase F1 adoption, 2026-04-23)**: **两个并行策略**，不同资本 tier，均 QQQ-only：
> - **BCD QQQ wide** (`strategy_type='bcd'`, $2K 级)：bull call debit spread，long δ 0.50 / short δ 0.20，DTE 30-60，PT 50%，10 交易日触发 + maxPositions=1 flat-gate。
> - **PMCC QQQ pt60** (`strategy_type='pmcc'`, $10K+ 级)：diagonal，long LEAP δ 0.70-0.80 DTE 240-300，short monthly δ 0.20-0.30 DTE 30-45，long PT 60%，2% moneyness 滚动。
>
> DTE5、Swing、ShortTerm 均已退役（`RETIRED_STRATEGIES`），历史数据仍可在 Portfolio / Stats 的 Legacy filter 下查看。手动入场使用 `BCDEntryModal` / `PMCCEntryModal`，无 cron 驱动的信号扫描（`api/cron-signal-scan.js` 于 2026-04-24 退役）。

欢迎来到Trading Journal项目文档中心！这里包含了项目的完整技术文档和使用指南。

---

## 📚 文档目录

### 0️⃣ [PRD 总览](./00_PRD_总览.md) **NEW**
**适合**: 产品、项目负责人、新成员

**内容**:
- 产品愿景与目标
- 用户角色与典型场景
- 功能总览与优先级（P0/P1/P2）
- 非功能需求、范围边界（In/Out）
- 依赖与约束、相关文档索引

**阅读时间**: 10分钟

---

### 1️⃣ [项目概览](./01_项目概览.md)
**适合**: 新用户、产品经理、投资者

**内容**:
- 项目简介和核心价值主张
- 技术架构概览
- 核心功能模块介绍
- 数据模型概述
- 未来规划路线图

**阅读时间**: 15分钟

---

### 2️⃣ [技术路径](./02_技术路径.md)
**适合**: 开发者、技术负责人

**内容**:
- 前端技术栈详解（React 18, TypeScript, Vite 5, Tailwind, React Router v6, React Query v5）
- 后端架构设计（Supabase, Vercel Serverless）
- 数据流设计（React Query 缓存 + Supabase 实时失效）
- API集成方案
- 状态管理策略（Context + React Query，无 prop drilling）
- 测试体系（1213 项 Vitest 测试 + GitHub Actions CI）
- 性能优化技巧（懒加载路由、代码分割）

**阅读时间**: 25分钟

---

### 3️⃣ [核心算法](./03_核心算法.md)
**适合**: 量化交易者、算法工程师、高级用户

**内容**:
- OSS评分系统详解
- LOQ算法（买方评分）
  - Lambda（杠杆率）
  - Dollar Gamma（gamma × S² / 100）
  - Theta Burn（时间衰减）
  - Delta Bonus（ATM奖励）
- CSQ算法（卖方评分）
- IV期限结构分析（4-Card Method）
- 警告系统算法
- P&L计算算法

**阅读时间**: 30分钟

---

### 4️⃣ [数据库设计](./04_数据库设计.md)
**适合**: 后端开发者、数据库管理员

**内容**:
- PostgreSQL表结构设计
  - positions（持仓表）
  - transactions（交易记录表）
  - position_greeks_history（Greeks历史表）
- 关系设计和ER图
- 索引策略
- Row Level Security (RLS)
- 迁移历史
- 常用查询示例

**阅读时间**: 20分钟

---

### 5️⃣ [API文档](./05_API文档.md)
**适合**: 前端开发者、API集成者

**内容**:
- 数据源配置（ORATS 主 + Tiingo 股票K线）
- 期权价格API详解（端点、参数、响应格式、dataSource 字段）
- OCC Symbol、价格计算逻辑
- Supabase REST API使用
- 错误处理和重试机制
- 安全性和CORS配置
- 测试方法

**阅读时间**: 20分钟

---

### 6️⃣ [用户工作流](./06_用户工作流.md)
**适合**: 所有用户、交易者

**内容**:
- 日常交易流程（开盘前、盘中、收盘后）
- Scanner使用指南
- Watchlist管理
- 持仓管理
- 风险管理策略
- 最佳实践和常见错误
- 成功案例分析

**阅读时间**: 25分钟

---

### 7️⃣ [止损与目标价提醒方案](./07_止损与目标价短信提醒方案.md) ✅ 已上线
**适合**: 需要「价格触及止损/目标时收 Discord 推送」的用户、开发者

**内容**:
- 为何必须用服务端定时任务
- 现有数据（target_price、止损公式）与可选补齐（stop_price）
- 通知渠道选型（Discord Webhook 免费 / Twilio 付费）
- `/api/check-alerts` 实现（Supabase REST API + Discord Webhook）
- 外部 Cron（cron-job.org）配置（Vercel Hobby 不支持高频 Cron）
- 安全、成本注意点

**阅读时间**: 10分钟

---

### 8️⃣ [设计系统](./DESIGN-SYSTEM.md)
**适合**: 前端开发者、UI/UX 设计
**内容**: 颜色令牌、排版、布局规范、交互动画、反模式
**阅读时间**: 10分钟

---

---

## 🚀 快速开始

### 新用户
1. 阅读 [项目概览](./01_项目概览.md) 了解项目
2. 阅读 [用户工作流](./06_用户工作流.md) 学习使用
3. 开始交易！

### 开发者
1. 阅读 [项目概览](./01_项目概览.md) 了解架构
2. 阅读 [技术路径](./02_技术路径.md) 了解技术栈
3. 阅读 [数据库设计](./04_数据库设计.md) 了解数据模型
4. 阅读 [API文档](./05_API文档.md) 开始集成

### 量化交易者
1. 阅读 [核心算法](./03_核心算法.md) 了解评分系统
2. 阅读 [用户工作流](./06_用户工作流.md) 学习应用
3. 根据算法优化交易策略

---

## 📖 文档结构

```
docs/
├── README.md                   # 本文件（文档索引）
├── 00_PRD_总览.md               # 产品需求文档总览
├── 01_项目概览.md               # 项目简介和架构
├── 02_技术路径.md               # 技术栈和实现细节
├── 03_核心算法.md               # 评分算法详解（OSS v2.8）
├── 04_数据库设计.md             # 数据模型和SQL
├── 05_API文档.md                # API 接口与数据源配置
├── 06_用户工作流.md             # 使用指南和最佳实践
├── 07_止损与目标价短信提醒方案.md  # Discord 提醒实现方案
├── DESIGN-SYSTEM.md              # UI/UX 设计系统规范
├── 算法改进总览_OSS_v2.8.md     # OSS v2.8 改进记录（当前版本）
├── AUDIT_10D_v1.md              # 10 维度独立审计报告
└── wfa/                         # WFA analysis docs
```

### Backtesting & WFA Reports (historical, pre-sealed-holdout era)
- [Swing Strategy Sign-Off](./wfa/FINAL-SIGN-OFF.md) — Production validation for swing (1D, 45-65 DTE) — SUPERSEDED, strategy retired
- [Short-Term Results](./wfa/SHORT-TERM-RESULTS.md) — Short-term WFA validation results — SUPERSEDED
- [WFA Journey Summary](./wfa/WFA-JOURNEY-SUMMARY.md) — Historical record of the WFA investigation

For current validated strategies, see `docs/audit-rows/` (pre-reg audit trail) and `docs/holdout-evaluations/` (sealed seal files).

---

## 🔍 按主题查找

### 架构和设计
- [技术架构概览](./01_项目概览.md#技术架构概览)
- [前端技术栈](./02_技术路径.md#前端技术栈)
- [后端架构](./02_技术路径.md#后端架构)
- [数据库设计](./04_数据库设计.md)

### 数据库表
- [positions / transactions / position_greeks_history](./04_数据库设计.md) — 核心持仓与交易
- [stock_candles](./04_数据库设计.md) — 股票K线缓存（Tiingo IEX 聚合）
- [signal_history](./04_数据库设计.md) — 每日信号扫描结果
- [trade_outcomes](./04_数据库设计.md) — MFE/MAE 交易结果分析

### 核心功能
- [Portfolio管理](./01_项目概览.md#1-portfolio-持仓管理)
- [Scanner扫描器](./01_项目概览.md#3-scanner-期权扫描器)
- [警告系统](./01_项目概览.md#警告系统)

### 算法和计算
- [LOQ评分算法](./03_核心算法.md#loq算法买方评分)
- [IV期限结构](./03_核心算法.md#iv期限结构分析)
- [P&L计算](./03_核心算法.md#pl计算算法)
- [Tech Score V4 质量门控](./03_核心算法.md#5-v4-质量门控quality-gates)

### API和集成
- [数据源配置](./05_API文档.md#数据源配置)
- [期权价格API](./05_API文档.md#期权价格api)
- [Supabase API](./05_API文档.md#supabase-rest-api)
- [错误处理](./05_API文档.md#错误处理)
- 架构与部署见 [02_技术路径](./02_技术路径.md#部署与运维)，API 见 [05_API文档](./05_API文档.md)

### 使用指南
- [日常交易流程](./06_用户工作流.md#日常交易流程)
- [Scanner使用](./06_用户工作流.md#scanner使用指南)
- [风险管理](./06_用户工作流.md#风险管理)
- [最佳实践](./06_用户工作流.md#最佳实践)

---

## 💡 常见问题

### Q: 如何开始使用Trading Journal？
**A**: 阅读 [用户工作流](./06_用户工作流.md) 文档，从"日常交易流程"开始。

### Q: Scanner的评分是如何计算的？
**A**: 详见 [核心算法 - LOQ算法](./03_核心算法.md#loq算法买方评分)。

### Q: 如何设置止损条件？
**A**: 参考 [用户工作流 - 风险管理](./06_用户工作流.md#风险管理)。

### Q: API调用失败怎么办？
**A**: 查看 [API文档 - 错误处理](./05_API文档.md#错误处理)。

### Q: 数据库表结构是什么？
**A**: 详见 [数据库设计 - 表结构设计](./04_数据库设计.md#表结构设计)。

---

## 🔄 文档更新日志

### 2026-04-24（Phase F1 改造后清理 + 文档同步）
- ✅ **退役基础设施**: 删除 `api/cron-signal-scan.js`（782 行）、`src/hooks/useSignalScanner.ts`（153 行）、`src/components/SpreadPickerModal.tsx`（256 行）、`src/lib/strategyConfig.ts` 死导出（85 行）。
- ✅ **文档同步**: 所有 DTE5 "活跃策略" 标记更新为 BCD + PMCC 并行；测试数 683/695 → 1213；`cron-signal-scan` 从生产 API 表移除。
- ✅ **相关 PR**: #16（dead-code cleanup）、#17（cron-signal-scan + useSignalScanner retire）。

### 2026-04-23（Phase F0 clean-slate + Phase F1 platform revamp — PR #14, #15）
- ✅ **Phase F0 declaration**: 有效尝试计数器一次性重置（boundary `2026-04-23T02:20:00Z`）。Binding commitments 在 `phase-f0-clean-slate-declaration.md`。
- ✅ **Phase F1 两个采纳**:
  - PMCC QQQ pt60（$10K+）— 6/6 gates PASS，dsrM (F0-eff N=25) +0.845
  - BCD QQQ wide（$2K）— 6/6 gates PASS，dsrM (F0-eff N=30) +0.065（v2 pre-reg 修正 cadence 措辞后）
- ✅ **平台改造 5 phases**: foundations → display → entry → auto-tracking → docs。DTE5/swing/shortTerm 移入 `RETIRED_STRATEGIES`。
- ✅ **新组件**: `BCDEntryModal`, `PMCCEntryModal`（PMCC 双腿独立过期日）。
- ✅ **`api/check-alerts.js`** 自动跳过 `strategy_type in ('bcd','pmcc')`（DTE5 SL/TL 规则不适用）。

### 2026-03-23（130M Migration + Scoring Overhaul + Documentation Refresh）
- ✅ **130M 短线策略迁移**: 4H → 130M (3×130min = exact 390min session), production config `em|tp50|w10|iv20|dsoff|pm2.25`
- ✅ **数据管线**: Tiingo IEX 10-min → 130M aggregation, Supabase `stock_candles` block-encoded cache, cache-first pattern
- ✅ **Scoring Phase 1**: VRP (IV²-RV²) ±10pt, orFcst20d clamp ±0.8→±2.0
- ✅ **Multicore WFA**: worker cap removed (`Math.min(4,cpus-2)` → `Math.max(1,cpus-2)`)
- ✅ **WFA Results Viewer**: live at `/backtest` (5556 OOS trades)
- ✅ **测试**: 520→683 (38 migration-130m tests + others)
- ✅ **文档刷新**: CLAUDE.md, GEMINI.md, TEAM.md, CHANGELOG, STATE, ROADMAP, INTEGRATIONS, TESTING, README 全面更新

### 2026-03-14（WFA-Driven Workflow Integration — v3.1.0）
- ✅ **5 phases complete**: prerequisite fixes, data contract, spread builder integration, global strategy toggle, scanner removal + MOM signal
- ✅ **测试**: 488→520

### 2026-03-12（数据源迁移 + 文档清理）
- ✅ **数据源更新**: 全项目文档统一为 **ORATS（期权数据）+ Tiingo（股票K线）**；移除所有 Polygon.io 引用
- ✅ **删除过时文档**: `09_Polygon集成.md`（Polygon 不再使用）、`08_IV_Rank_上线步骤.md`（已部署）、`CHANGELOG_OSS.md`（停留在 v2.4，内容已被 `算法改进总览_OSS_v2.7.md` 覆盖）
- ✅ **删除已完成计划**: `plans/2026-03-09-backtest-findings-integration.md`、`plans/2026-03-10-wfa-engine-overhaul.md`、`plans/2026-03-11-credit-spread-ux-overhaul.md`
- ✅ **CLAUDE.md 更新**: `backtest-iv.js` → `backtest-data.js`（合并端点）、`cron-iv-snapshot.js` → `cron-iv.js`、WFA 引擎各阶段标记为已完成
- ✅ **API 文档更新**: 端点表、数据源配置、环境变量统一为 ORATS + Tiingo
- ✅ **技术路径更新**: 架构图、文件结构、数据源配置统一为 ORATS + Tiingo

### 2026-03-06（文档审计 — 代码↔文档一致性）
- ✅ **03_核心算法**: Gamma Efficiency→Dollar Gamma (`gamma×S²/100`)，DTE 桶 '0-14'→'0-7'+'8-14'，MIN_BUCKET_SIZE 3→8，IV Rank sqrt 置信度，新增 Tech Score V4 质量门控章节
- ✅ **04_数据库设计**: positions 表新增 strategy/exit_type/tech_score/tech_score_source/market_state/trade_profile/iv_rank_entry/iv_regime_entry 列；ER 图新增 score_history 表；附录 SQL 同步
- ✅ **05_API文档**: 新增 `/api/backtest-candles` 端点
- ✅ **00_PRD**: 功能地图新增 Backtest/Signals，优先级表新增 Backtest/Signals/Settings，算法版本 v2.1→v2.8
- ✅ **01_项目概览**: 架构图新增 Backtest/Signals/Settings/Academy 页面，技术栈新增 React Router v6/React Query v5，Position 接口新增 12 个字段，回测从「规划」移至「已完成」
- ✅ **README**: 文档结构/主题索引更新，新增本次 changelog

### 2026-03-05（v3.0 架构重构）
- ✅ **架构文档更新**: React Router v6、React Query v5、Context 架构、懒加载路由
- ✅ **新增测试体系**: 488 项 Vitest 测试（scoring parity 307 + oss-core 48 + riskSizing 19 + tech-parity 10 + backtest 35 + bsm 32 + slippage 12 + wfa 10 + option-sim 9）
- ✅ **CI/CD**: GitHub Actions `lint → build → test`
- ✅ **状态管理**: 从 App.tsx prop drilling → hooks + contexts 自治页面
- ✅ **项目结构更新**: 新增 hooks/、context/、layouts/、tests/ 目录

### 2026-03-02（文档整理 + API 合并）
- ✅ **API 合并**: `/api/score-validation` + `/api/execution-quality` → `/api/analytics?type=...`（Vercel Hobby 12 函数限制）
- ✅ **gammaEff → dollarGamma**: 全文档术语更新，反映 v2.7 Deep Audit 中 Dollar Gamma (`gamma × S² / 100`) 替代旧 `gamma/mid`
- ✅ **文档清理**: 删除已废弃的 `算法改进总览_OSS_v2.2.md`、`算法改进总览_OSS_v2.4.md`（内容已被 v2.7 覆盖）；删除已实现的 `plans/2026-02-14-global-app-settings.md`
- ✅ **新增文档索引**: `算法改进总览_OSS_v2.7.md`、`AUDIT_10D_v1.md`

### 2026-02-14（OSS v2.5 代码审查全面优化）
- ✅ **BSM N(d2) POP 回退**：信用价差/借方价差/单腿 POP 从 `1-|delta|` 升级为 Black-Scholes N(d2)（`src/lib/bsm.ts` 新文件）
- ✅ **EV 退出乘数 0.75**：`calculateExpectedValue` 引入 `exitMultiplier=0.75`，反映实际提前平仓的损失上限
- ✅ **价差中间价定价**：信用/借方价差均改用 spread mid 而非 bid/ask 最差价，分数更贴近实际成交
- ✅ **IV 期限结构线性插值**：`getATMIV` 从"最近到期"升级为插值重建精确 IV30/IV90
- ✅ **IV 绝对水平 + VRP**：regime 新增 `ivLevel`（elevated/normal/suppressed）和 `vrp = IV30%−RV30`
- ✅ **DTE 高斯评分曲线**：信用价差 DTE 分改为 `100×exp(-0.5×((DTE-37)/15)²)`，无离散锯齿
- ✅ **OI 调整滑点**：`estimateSlippage` 新增流动性乘数，惩罚低 OI 合约
- ✅ **DTE 自适应 Vega 权重**：`getLOQVegaWeight` 随 DTE 从 0.03→0.15 线性增长
- ✅ **Earnings IV Premium**：跨财报日策略自动计算隐含财报移动幅度和事后 IV 估算
- ✅ **Skew DTE 对齐**：`calculateSkew` 改用请求的 `dteTarget` 而非硬编码 30 天
- ✅ **技术面多周期对齐奖惩**：1D+4H+1H 全对齐 +7，1H 逆向 -3，附加到 unifiedScore
- ✅ **财报 API 去重缓存**：App.tsx 统一维护 4 小时 TTL 缓存，N×M 次降至每 ticker 1 次
- ✅ **Greeks 历史单次加载**：`hasLoadedHistoryRef` 防止卡片展开重复拉取
- ✅ **Watchlist 批量价格**：页面加载一次 POST，替代逐项 GET
- ✅ **AppSettings 本地缓存**：5 分钟 TTL 跳过 Supabase 冷启动查询
- ✅ **文档整合**：`OSS_v2.4_快速参考.md` + `OSS_v2.4_更新总结.md` 合并入 `算法改进总览_OSS_v2.4.md`；`03_核心算法.md` 更新至 v2.5

### 2026-02-12（文档精简与数据源统一）
- ✅ **技术文档与数据源一致化**：全项目文档统一为 **Polygon.io（主）+ CBOE（备）**；API 层已仅支持 POLYGON/CBOE，MarketData 已弃用。
- ✅ **删除重复/过时**：曾删除 `docs/TECHNICAL_DOCUMENTATION.md`（与根目录重复）；删除 `MIGRATION_SUMMARY.md`（内容已入 CHANGELOG）。
- ✅ **根目录 TECHNICAL_DOCUMENTATION 合并进 docs**：根目录 `TECHNICAL_DOCUMENTATION.md` 已删除，内容并入 [02_技术路径](./02_技术路径.md)（技术架构总览、部署与运维、故障排除、开发说明）、[01_项目概览](./01_项目概览.md)、[04_数据库设计](./04_数据库设计.md)（附录 SQL）、[05_API文档](./05_API文档.md)、[06_用户工作流](./06_用户工作流.md)、[07_止损与目标价短信提醒方案](./07_止损与目标价短信提醒方案.md)。
- ✅ **删除 MarketData**：移除 `lib/market-data-client.js`、`docs/09_MarketData集成.md`、`MARKETDATA_DEV_GUIDE.md`、`debug-polygon.js`；脚本改为使用 Polygon。
- ✅ **05_API文档、01_项目概览、00_PRD、README**：数据源描述与环境变量统一为 Polygon + CBOE；端点表与故障排除更新。

### 2026-02-09
- ✅ **Portfolio 价差快速添加**: Quick Add 表单支持 Single Leg / Credit Spread / Debit Spread 切换，自动构建 `legs` JSONB 并写入 Supabase。
- ✅ **策略推荐 Spread Width 可配置**: 新增 $2.5/$5/$10/$20 宽度选择器，替代硬编码的 `[5,10]`/`[2.5,5]`，同步更新 `api/strategy-recommend.js` 和 `vite.config.ts` 本地 dev。
- ✅ **iOS/移动端优化**: `.input-field` 添加 `text-base`（16px）防 Safari 缩放；价差 Strike 响应式布局（移动 2 列 / 桌面 3 列）；所有按钮 ≥44px 触控目标；数字输入 `inputMode="decimal"`。
- ✅ **数据库 Schema 更新**: `positions` 表新增 `legs JSONB`、`stop_price DECIMAL`；`type` 列拓宽至 `VARCHAR(50)` 支持价差类型字符串。
- ✅ **类型更新**: `DirectAddItem` 新增 `legs?: PositionLeg[]`；`App.onAddDirect` 传递 legs 至 Supabase。
- ✅ **文档同步**: TECHNICAL_DOCUMENTATION、04_数据库设计、05_API文档 反映最新 Schema、API 参数和前端功能。

### 2026-02-08
- ✅ **Discord 自动提醒上线**: 新增 `api/check-alerts.js`（止损/目标价 Discord 推送）、`api/health.js`（健康检查）。
- ✅ **部署修复**: 移除 `vercel.json` 中的 `crons` 配置（Vercel Hobby 计划不支持高频 Cron，会导致部署失败）；改用 cron-job.org 外部定时触发。
- ✅ **基础设施**: `.gitignore` 增加 `dist/`、`.env`、`.env.local`；从 Git 移除 `dist/` 目录；新增 Deploy Hook 备选部署方式。
- ✅ **文档更新**: 更新 TECHNICAL_DOCUMENTATION（架构图、文件结构、部署方式、Discord 提醒、故障排除）；更新 API 文档（check-alerts、health 端点）；更新技术路径（外部 Cron、Hobby 限制）；更新 PRD（Discord 提醒为 P1 功能）；更新提醒方案文档（反映实际实现）。

### 2026-02-07
- ✅ **PRD 总览**: 新增 [00_PRD_总览.md](./00_PRD_总览.md)，产品愿景、用户场景、功能优先级、范围边界与依赖约束。
- ✅ **技术文档**: 更新 TECHNICAL_DOCUMENTATION.md — OSS 单点事实架构（oss-core + api/_shared）、文件结构、重构说明（LERP/Theta 上限/Lambda 压缩/Day Trade/类型与边界）。
- ✅ **技术路径**: 更新 02_技术路径.md — lib 与 api 目录结构、共享评分模块、Scanner 数据流（后端单遍过滤+评分）。
- ✅ **API 文档**: 更新 05_API文档.md — 端点列表、underlying-rv、评分逻辑统一说明。

### 2026-02-06
- ✅ **Credit Spread Accounting**: 修复信用价差核算，采用 Cost to Close (Short - Long) 逻辑，修正 P&L 计算。
- ✅ **Spread Scoring Optimization**: 将价差评分算法集成至 `scoring.ts`，实现 Portfolio 与 Recommender 评分 100% 映射一致。
- ✅ **Stability & Persistence**: 优化价格刷新逻辑，增加本地 `liveData` 缓存，修复数据刷新时的抖动和 disappearing 问题。
- ✅ **API Polish**: 更新 CBOE 接口头信息，修复 403 错误，标准化 `underlyingPrice` 字段。
- ✅ **Bug Fixes**: 解决评分 NaN 问题，优化 Tooltip 全局展示性能。

### 2026-02-05
- ✅ 优化评分权重 (OSS v2.1)
- ✅ 增加 Delta Bonus 线性插值
- ✅ 增加 Theta Pain Capsule 惩罚算法

### 未来计划
- [ ] 添加视频教程
- [ ] 添加交互式示例
- [ ] 添加故障排除指南
- [ ] 添加性能优化指南

---

## 📞 联系方式

**问题反馈**: GitHub Issues
**功能建议**: GitHub Discussions
**紧急联系**: [待补充]

---

## 📄 许可证

本项目文档采用 [MIT License](../LICENSE)

---

*文档维护者: Trading Journal Team*
*最后更新: 2026年4月24日*
