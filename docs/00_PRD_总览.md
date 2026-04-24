# Trading Journal - 产品需求文档（PRD）总览

> 版本 1.4 · 最后更新: 2026年4月6日

---

## 1. 产品愿景与目标

### 1.1 产品定位

**Trading Journal** 是一款面向期权交易者的**纪律执行型**交易日志与决策支持 Web 应用。核心不是「记流水账」，而是通过**强制工作流 + 量化评分 + 实时警告**，把「计划交易、交易计划」落到实处。

### 1.2 要解决的核心问题

| 问题 | 用户痛点 | 产品应对 |
|------|----------|----------|
| 入场无纪律 | 感觉对了就买，没有量化依据 | 信号扫描 + EMA34 gate，强制「先看信号再入场」 |
| 出场靠情绪 | 亏很多才割肉，赚一点就跑 | 止损规则 + 多级视觉警告（危险/警告/信息） |
| 时间漂移 | 短线单拿成长期 | 到期日提醒、持仓天数、短 DTE 惩罚（Theta Pain） |
| 记录难坚持 | 工具重、步骤多，用几天就弃 | 30 秒内完成关键操作、移动端友好、自动拉价 |
| 价格更新麻烦 | 手动查行情再填表 | ORATS API 自动获取价格与 Greeks |

### 1.3 成功指标（可观测）

- **纪律指标**：Signal → Active 的比例、止损触发后是否按规则平仓。
- **使用粘性**：周活、单次会话时长、价格/Score 刷新频率。
- **数据质量**：持仓价格与 Score 更新及时性、扫描与持仓分数一致性（OSS 单点事实）。

---

## 2. 用户角色与场景

### 2.1 主要用户

- **散户期权交易者**：有一定期权基础，做单腿或简单价差（Vertical Spread），希望有统一入口管理计划、持仓与历史。
- **纪律优先型**：认同「计划比感觉重要」，愿意用工具约束自己。

### 2.2 典型场景

**（Phase F1 adoption, 2026-04-23 生效）**

1. **BCD 入场（$2K 级）**：Signals 页面 BCD tab 显示 "Eligible"（距上次关仓 ≥10 交易日）→ 点击 "Open BCD Position →" 触发 `BCDEntryModal` → 填入 broker 查询到的 long δ 0.50 / short δ 0.20 + DTE 30-60 call spread 详情 → 确认 contracts 和 net debit → 位置以 `strategy_type='bcd'` 写入。
2. **PMCC 入场（$10K+ 级）**：Signals 页面 PMCC tab（持续 "Eligible" 因持续在场）→ 点击 "Open PMCC Position →" 触发 `PMCCEntryModal` → 填入 LEAP 双腿各自的 strike/到期/debit + credit → 位置以 `strategy_type='pmcc'` 写入，legs[] 两条独立 expiration。
3. **持仓管理**：Portfolio 查看 P&L、短腿 DTE 倒计时、到期警示；PositionCard 按 `strategy_type` 显示 PT 50% (BCD) 或短腿 2% moneyness 滚动提示 (PMCC)。
4. **Legacy 策略查看**：已退役的 DTE5 / Swing / ShortTerm 历史持仓在 Portfolio / Stats "Legacy" filter 下可见。
5. **复盘**：History/Stats 按 `strategy_type` 分组查看胜率、Setup 分布等。

---

## 3. 功能总览与优先级

### 3.1 功能地图（概要）

```
┌─────────────────────────────────────────────────────────────────┐
│                         Trading Journal                         │
├─────────────┬─────────────┬─────────────┬─────────────┬─────────┤
│  Dashboard  │  Scanner    │  Portfolio  │  Strategy   │ History │ Backtest │
│  (仪表盘)   │  (OSS 扫描)  │  (持仓管理)  │  Recommender│ /Stats  │ /Signals │
├─────────────┴─────────────┴─────────────┴─────────────┴─────────┤
│  数据与评分：ORATS + Tiingo + Nasdaq · OSS (oss-core + api/_shared)           │
│  持久化：Supabase (positions, transactions, position_greeks_history)       │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 核心功能与优先级

| 优先级 | 功能模块 | 描述 | 状态 |
|--------|----------|------|------|
| P0 | 登录/认证 | Supabase Auth，保证数据归属 | ✅ |
| P0 | Portfolio | 活跃持仓列表、P&L、价格/Score 更新、多级警告 | ✅ |
| P0 | Watchlist | 计划入场、理想价/止损/目标、转 Active | ✅ |
| P0 | 价格与 Greeks | 单合约 API（option-price）+ 批量刷新 | ✅ |
| P0 | Scanner | OSS v2.8 扫描（Long/Short + Day Trade），Top N 结果 | ✅ |
| P0 | OSS 单点事实 | oss-core.ts + api/_shared/scoring.cjs，前后端分数一致 | ✅ |
| P1 | Strategy Recommender | IV  regime + Credit/Debit/Single Leg 推荐 | ✅ |
| P1 | History / Stats | 已平仓记录、胜率、Setup 分析 | ✅ |
| P1 | Greeks 历史 | IV/Delta 历史记录与图表 | ✅ |
| P2 | Roll | 平旧仓开新仓（Roll 流程） | ✅ |
| P2 | Academy | 内嵌学习/说明内容 | ✅ |
| P1 | Discord 自动提醒 | 止损/目标价触及时自动发 Discord 推送 | ✅ |
| P1 | Backtest | Tech Score 回测引擎（GA 优化、Walk-Forward、质量门控） | ✅ |
| P1 | Signals | 实时信号扫描仪表盘（多 Ticker Tech Score 扫描） | ✅ |
| P2 | Settings | 全局应用设置（Dark Mode、通知偏好等） | ✅ |
| 后续 | 导出、短信提醒、多账户等 | 见「未来规划」 | 规划中 |

> **✅ 当前活跃策略 (Phase F1 adoption, 2026-04-23)**: **BCD QQQ wide** (`strategy_type='bcd'`, $2K 级，bull call debit spread，10 交易日手动触发) + **PMCC QQQ pt60** (`strategy_type='pmcc'`, $10K+ 级，diagonal，持续在场)。DTE5 / Swing / ShortTerm 均已退役（代码保留用于历史数据兼容）。本文档个别小节仍描述旧 DTE5 流程，请以 [docs/README.md](./README.md) 和 [CLAUDE.md](../CLAUDE.md) 的 Active Strategies 章节为准。

---

## 4. 非功能需求

### 4.1 性能

- 扫描单次请求：在合理 DTE/Strike/Volume 过滤下，返回 Top 20 within 可接受延迟（依赖 ORATS API 响应）。
- 前端：首屏与列表滚动流畅；价格/Score 更新不阻塞主流程。

### 4.2 可用性与一致性

- 扫描结果、策略推荐、持仓卡片上的 OSS 分数使用同一套算法（单点事实），避免「扫出来 80、持仓显示 60」类不一致。
- 关键操作有 Loading 与明确错误提示；危险操作有二次确认。

### 4.3 安全与合规

- 认证与行级数据隔离（Supabase RLS）。
- API 密钥与敏感配置不进入前端；期权数据（ORATS）与 Nasdaq 调用在 Serverless 内完成。

### 4.4 兼容与部署

- 支持现代浏览器与移动端访问。
- 部署于 Vercel；数据与认证在 Supabase。

---

## 5. 范围边界（In/Out）

### 5.1 In Scope（当前范围）

- 期权计划、持仓、历史记录与基础统计。
- OSS 评分（LOQ/CSQ、价差评分）与 IV 期限结构驱动的策略建议。
- 期权价格与 Greeks 展示与更新（ORATS 实时数据）。
- 单用户、单账户的纪律执行与复盘。

### 5.2 Out of Scope（明确不做或后续）

- **实盘下单**：不连接券商，不执行真实订单。
- **实时行情**：ORATS 提供期权数据；不连接实时股票行情流。
- **多用户协作**：无多账户、无分享仓位。
- **合规/税务建议**：不提供税务或法律建议，仅提供记录与统计。

---

## 6. 依赖与约束

### 6.1 外部依赖

- **期权数据**：**ORATS**（`DATA_SOURCE=ORATS`）：期权链、Greeks、IV、cores、earnings、impliedMove，需 `ORATS_API_TOKEN`。**Tiingo**：股票K线/历史价格，需 `TIINGO_API_TOKEN`。
- **Nasdaq**：历史价格（RV）、财报日期等，通过公开 API。
- **Supabase**：数据库、Auth、Realtime。
- **Vercel**：前端托管与 Serverless API（Hobby 计划）。
- **Discord Webhook**：止损/目标价自动提醒通知渠道。
- **cron-job.org**：外部定时任务，每 15 分钟触发提醒检查。

### 6.2 技术约束

- 评分逻辑必须在「前端 oss-core + API _shared」间保持一致，任何公式变更需双端同步。
- 类型与边界：TypeScript 严格类型、数学边界（除零、极端输入）在 oss-core 与 _shared 中统一处理。

---

## 7. 相关文档索引

| 文档 | 说明 |
|------|------|
| [01_项目概览](./01_项目概览.md) | 项目简介、技术栈、功能模块概览 |
| [02_技术路径](./02_技术路径.md) | 前端/后端技术选型、目录结构、数据流、API 与评分架构 |
| [03_核心算法](./03_核心算法.md) | OSS v2.8 公式说明（LOQ/CSQ、IV、Tech Score、质量门控等） |
| [04_数据库设计](./04_数据库设计.md) | 表结构、RLS、索引 |
| [05_API文档](./05_API文档.md) | 各 API 端点、参数、响应格式 |
| [06_用户工作流](./06_用户工作流.md) | 从扫描到平仓的端到端流程 |
| [07_止损与目标价短信提醒方案](./07_止损与目标价短信提醒方案.md) | Discord 自动提醒实现方案（已上线） |

---

*文档维护：Trading Journal Team · 2026年4月6日*
