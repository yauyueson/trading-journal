# OSS 算法改进总览 v2.4

> 最后更新: 2026年2月14日  
> **版本**: OSS v2.4  
> **改进类型**: P0 (Critical Bug Fixes) + P1 (Core Enhancements) + Automation

---

## 📋 改进概览

本次更新修复了 4 个关键 bug（P0），实施了核心算法改进（P1），并引入了基础设施自动化与部署优化。

---

## 🚀 2.4 新增：自动化与基础设施 (Automation & Infrastructure)

### 1. Tech Score 自动同步与分析
- **功能**: 集成技术面分析系统，自动计算 Market Bias、B-Xtrender、Momentum、EMA Stack 等多维度指标。
- **自动化**: 位于持仓页面（Portfolio）加载时静默触发异步刷新。
- **性能优化**: 实现了「纽约时间冷却机制」，同一标的在同一交易日内仅同步一次 Polygon 历史数据，极大节省了 API 调用配额。

### 2. API 通用化与 Serverless 优化
- **端点合并**: 将 `option-price.js` 与 `option-prices-bulk.js` 合并为统一的 `option-prices.js`，支持单腿 GET 传参和多腿 POST Body。
- **部署修复**: 处理了 Vercel Hobby Plan 的「12 个 Serverless Function 限制」问题。通过合并端点、去除冗余脚本（health.js, setup-iv-rank.js）并配置 Vercel Rewrites，将部署函数压缩到 8-10 个。

### 3. 环境隔离加载强化
- **改进**: 在 `polygon-client.js` 等核心逻辑中集成 `dotenv`，确保本地分析脚本（如 `setup-iv-rank` 或 `backfill`）能够无缝读取 `.env.local` 中的敏感配置。

---

## 🔴 P0: 关键 Bug 修复

### P0-1: 修复 Unified Score Liquidity Bug
- **修复**: 使用真实 `bid/ask` 计算价差流动性评分，而非依赖 `price`。

### P0-2: 移除 ThetaBurn Z-Score 双重惩罚
- **修复**: 移除 Z-Score 通道的线性惩罚，仅保留 `getThetaPenalty` 的绝对指数级惩罚。

### P0-3: CompressLambda 改用 Log 压缩
- **修复**: 使用 `log2` 替代线性衰减，更有效地抑制极低价合约的天文数字杠杆。

### P0-4: 统一 maxSpreadPct Ceiling
- **修复**: 将策略推荐中的流动性过滤上限统一为 0.12。

---

## 🟡 P1: 核心改进

### P1-1: Vega 效率与惩罚机制
- **LOQ (买方)**: 引入 `vega/权利金` Z-Score。低 IV 环境下奖励高 Vega 效率。
- **CSQ (卖方)**: 对高 Vega 敏感合约实施温和降分。

### P1-2: RV 从 Polygon Candles 直接计算
- **改进**: 停止从 Nasdaq Scraping 计算实现波动率，统一使用 Polygon 1.5 年的 K 线数据进行年化波动率计算。

### P1-3: Debit Spread 评分扩展
- **改进**: 从 3 维扩展到 6 维评分，加入 Theta、Breakeven 和 EV 维度。

---

## 📊 改进效果预期

- **数据源稳定性**: IV 和 RV 完全统一口径（Polygon）。
- **部署稳定性**: 解决 Vercel 限制，支持 Hobby Plan 长期稳定部署。
- **分析深度**: 持仓卡片现在自动展示「技术面 + 期权面」的双重维度评估。

---

## 📚 相关文档

- **核心算法文档**: `docs/03_核心算法.md`
- **API 文档**: `docs/05_API文档.md`
- **Polygon 集成**: `docs/09_Polygon集成.md`
