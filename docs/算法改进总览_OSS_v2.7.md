# OSS 算法改进总览 v2.8

> 版本: v2.8 · 更新: 2026-03-03 · 类型: Price Accuracy Fix + Bug 修复 (P0/P1/P2) — Code Audit 专项

---

## 改进概览

| 类别 | 数量 |
|------|------|
| Price Accuracy Fix (P0 — v2.8) | 3 |
| Price Accuracy Fix (P1 — v2.8) | 2 |
| Bug 修复 (P0 — 影响交易, v2.7) | 4 |
| 系统性偏差修复 (P1, v2.7) | 3 |
| 精度改进 (P2, v2.7) | 5 |
| 修改文件 | 9 |

---

## v2.8 Price Accuracy Fix（2026-03-03）

### P0：标的价格与期权定价错误

| ID | 问题 | 修复 | 文件 |
|----|------|------|------|
| PA-1 | PCP 字段名不匹配：`o.expiry` vs Polygon 的 `o.expiration`，导致 PCP 推导始终返回 null | 改为 `o.expiration \|\| o.expiry` 兼容两种格式 | `strategy-recommend.js` |
| PA-2 | `normalizePolygonOption` bid/ask 使用 `\|\|`：`bid=0` 回退到 `day.vwap`/`day.previous_close` | 改为 `??`（nullish coalescing），新增 `mid` 字段 | `polygon-client.js` |
| PA-3 | `getUnderlyingPrice()` 在基础 Polygon plan 返回 403，无 stock snapshot 权限 | 新增 PCP 中位数回退（从期权链推导，精度±0.5%）+ CBOE 兜底；chain 价偏差>15% 自动丢弃 | `option-prices.js`, `strategy-recommend.js`, `scan-options.js` |

### P1：定价一致性

| ID | 问题 | 修复 | 文件 |
|----|------|------|------|
| PA-4 | 优先使用 stale `last` trade：`last > 0 ? last : mid` | 改为 `mid > 0 ? mid : last`，优先实时 bid/ask 中间价 | `option-prices.js` |
| PA-5 | PositionCard 批量数据路径访问 `d.data`（无 `price` 字段），下游评分收到 undefined/NaN | 改为使用顶层 API 响应（含 `price`, `bid`, `ask`, `underlyingPrice`） | `PositionCard.tsx` |

### 下游影响（自动修正，无需代码变更）

`currentPrice` 准确性提升后，以下 IV 衍生指标精度同步改善：

| 指标 | 使用 currentPrice 的方式 | 影响程度 |
|------|------------------------|----------|
| ATM IV | `getCleanATM_IV(chain, currentPrice)` — 选取最近 ATM 行权价 | 中等（ATM strike 偏移一档 ~$5） |
| IV 期限结构 | `buildIVTermStructure` 全部 DTE 点位 | 中等（各点位 ATM IV 偏移） |
| IV/RV 比值 | 分子 IV30 来自期限结构 | 轻微（~0.5-1%） |
| IV Rank | 当前 ATM IV vs 历史比较 | 轻微（起始点偏移） |
| Strike Filter | `parseChain` ±15% 窗口 | 轻微（窗口移动 ~6 点） |
| Skew | delta 选取，不依赖 currentPrice | **无影响** |

---

## v2.7 P0：关键 Bug 修复（影响交易决策）

| ID | 问题 | 修复 | 文件 |
|----|------|------|------|
| P0-1 | IV 期限结构插值用线性 IV 而非线性方差，在 Backwardation 时高估中期 IV 最多 12% | 改为基于 σ²·T 的方差插值：`varNear = iv²·DTE/252`，内插后反求 IV | `scoring.cjs:calculateTargetIV` |
| P0-2 | 无 IV 单位归一化保护，CBOE 部分 feed 返回百分比格式（如 30.5）会使 IV/RV 比值差 100 倍 | `parseChain()` 中：`if (iv > 2.0) iv /= 100` | `scoring.cjs:parseChain` |
| P0-3 | 财报前 IV 隐含价差估算用 `iv × √((DTE-1)/DTE)` 低估 IV crush，7 DTE 高估约 10pp | 改用方差分解：剥离跳跃方差 (jumpVar)，从扩散方差反推 postIV | `strategy-recommend.js:estimateEarningsPremium` |
| P0-4 | 技术评分 Momentum 使用 `Math.abs(ch1)`，导致 -5% 暴跌与 +5% 上涨评分完全相同（永久多头偏差） | 改为带符号计算：`Math.sign(ch1) × min(|ch1|/2, 1) × 20`；空头动量现在压低评分 | `tech-analysis.js:sc_mom` |

---

## P1：系统性偏差修复

### P1-1：EMA 评分彻底消除多头偏差
**文件**: `tech-analysis.js`

旧版评分对所有 EMA 配置均只加分（`sc_ema` 最低为 60），死叉形态（E8 < E21 < E34）与金叉获得相同或更高分数。

**修复**：
- 引入方向感知：价格在 EMA 之上 → 加分；价格在 EMA 之下 → 减分
- 引入 `bullStack` 区分牛市叠加（E8>E21>E34 → 加分）和熊市叠加（E8<E21<E34 → 减分）
- `sc_ema` 范围从旧版 `[60, 100]` 改为 `[0, 100]`，完全对称

```diff
- sc_ema += 10 + Math.min(signStrength / 2, 1) * 15;  // 永远加 10-25 分
- sc_ema += 5 + Math.min(stackStrength / 0.5, 1) * 20;  // 永远加 5-25 分
+ const bull_ema = d8 > 0 && d21 > 0;
+ sc_ema += (bull_ema ? +1 : -1) * (10 + ...);     // 多头加 / 空头减
+ const bullStack = stackAligned && gap1 > 0;
+ sc_ema += (bullStack ? +1 : (stackAligned ? -1 : 0)) * (5 + ...);
```

---

### P1-2：B-Xtrender 短线方向感知
**文件**: `tech-analysis.js`

旧版 BXS 评分中：
- MA 斜率判断：下跌时仍给 +5 分（最低分为 55）
- 反转奖励：看空反转 (`rev_dn`) 与看多反转 (`rev_up`) 均给 +15 分

**修复**：
- MA 斜率上升 → +10，下降 → -5（现在能减分）
- `rev_up` → +15；`rev_dn` → -15（方向相反的反转惩罚）

---

### P1-3：IV 动量分级阈值（原功能完全失效）
**文件**: `ivHistory.cjs`

`iv30` 在数据库中以小数形式存储（0.30 = 30%），旧版阈值 `> 2` 等价于 IV 涨超 200%，实际上**永远不会触发**，IV 动量恒为 `"flat"`。

**修复**：改为相对变化率（百分比），增加新字段 `iv5dChangePct`：

```diff
- const ivTrend = iv5dChange > 2 ? 'rising' : iv5dChange < -2 ? 'falling' : 'flat';
+ const iv5dChangePct = (currentIv30 - iv5dAgo) / iv5dAgo * 100;
+ const ivTrend = iv5dChangePct > 10 ? 'rising' : iv5dChangePct < -10 ? 'falling' : 'flat';
```

| IV 变化 | 旧结果 | 新结果 |
|---------|--------|--------|
| 0.30 → 0.33（+10%）| flat | **rising** |
| 0.25 → 0.20（-20%）| flat | **falling** |
| 0.30 → 0.31（+3%）| flat | flat |

---

## P2：精度改进

### P2-1：RV30 改用总体方差（÷N）
**文件**: `strategy-recommend.js:_computeRV30`

```diff
- const variance = returns.reduce(...) / (n - 1);  // 样本方差（Bessel 修正）
+ const variance = returns.reduce(...) / n;         // 总体方差（市场惯例）
```

市场做市商与风险系统均用 ÷N；Bessel 修正（÷N-1）高估 RV30 约 3%，使 IV/RV 比值偏低，略偏向建议借方策略。

**实测**: 12 日收益序列，修正后 RV30 降低 0.68pp。

---

### P2-2：信用价差展示字段与评分字段对齐
**文件**: `strategy-recommend.js:buildCreditSpreads`

旧版返回对象使用原始（未滑点调整）的 `credit`/`maxRisk`，评分器使用 `effectiveCredit`/`effectiveMaxRisk`，前端展示的 EV 比实际使用的更乐观。

```diff
- netCredit: credit,            // 未调整
- expectedValue: credit*pop - maxRisk*(1-pop)  // 未调整 EV
+ netCredit: effectiveCredit,   // 滑点调整后（与评分一致）
+ expectedValue: ev,            // ev = calculateExpectedValue(pop, effectiveCredit, effectiveMaxRisk)
```

---

### P2-3：财报 IV 估算降低 1DTE 溢出率
将 1DTE 降档系数从 0.70 → 0.65，更贴近到期日实际 IV crush。

---

### P2-4：组件分数全部限幅 [0, 100]
**文件**: `tech-analysis.js`

方向感知修复后，`sc_ema`/`sc_bxs`/`sc_mom` 可能为负。现在在送入加权前统一 `Math.max(0, Math.min(100, ...))` 钳位。

---

### P2-5：移除双重排序冗余
**文件**: `strategy-recommend.js:handler`

主处理器在同一位置对 `targetRecs` 排序了两次（完全相同的比较器）。已移除冗余的第二次排序调用。

---

## 验证结果

| 检查项 | 结论 |
|--------|------|
| `node _test_strategy.js` 运行 | ✅ 无错误 |
| IV 插值数学验证（反向 Backwardation） | ✅ IV60：25.00% → 22.91%（-2.09pp）|
| IV 插值数学验证（Contango） | ✅ IV60：25.00% → 27.84%（+2.84pp）|
| IV 动量分级验证（+10% 相对变化） | ✅ "flat" → "rising" |
| RV30 方差修正验证 | ✅ 降低 0.68pp（≈ 3% 下调）|

---

---

## OSS v2.7 Deep Audit（22 项，5 阶段）

> 执行日期: 2026-03-01 · 类型: 系统性深度审计 — 评分精度 + 风险 + 数据质量 + Alpha 机会

### Phase 1 — 核心评分数学

| 修复项 | 旧实现 | 新实现 | 文件 |
|--------|--------|--------|------|
| Dollar Gamma | `gammaEff = gamma/mid`（权利金相对值，非绝对） | `gamma × S² / 100`（标准美元 Gamma） | `oss-core.ts`, `scoring.cjs`, `strategy-recommend.js`, `scan-options.js` |
| DTE 分桶 | `'0-14'` 单一桶 | 拆分为 `'0-7'` + `'8-14'` | 同上 |
| Sigmoid 调谐 | k=12, x0=1.10 | k=8, x0=1.00 | 同上 |
| IV Rank 置信度 | 直接使用原始 IV Rank | 乘以 `min(1, sampleDays/180)` 置信权重 | 同上 |
| Vega 惩罚条件化 | 无条件静态权重（+0.05/−0.03） | DTE 自适应 `getLOQVegaWeight(dte, ivAdj)`：基础权重 0.03（DTE≤5）→0.15（DTE≥60）线性插值；ivAdj>0 时正权重（奖励低 IV 做多 Vega），ivAdj<0 时 `−baseWeight×0.6`（温和惩罚高 IV 买权） | 同上 |
| 过滤器统一 | `HARD_FILTER_DEFAULTS` 与 `HARD_FILTER_CREDIT` 在 oss-core 中缺失 | 两层过滤器同步至 `oss-core.ts` | `oss-core.ts` |

**oss-core.ts 与 scoring.cjs 必须保持同步**，所有评分变更需同时在两个文件中更新。

---

### Phase 2 — 策略推荐引擎

| 修复项 | 说明 |
|--------|------|
| Pine 权重反转 | `hasPineSetup` 时：`wEV=0.45/wRegime=0.20`（旧版逻辑相反） |
| EV/Risk 分类归一化 | 按策略类别（信用/借方/单腿）使用各自的归一化区间，不共享同一池 |
| Regime 迟滞 | CREDIT→DEBIT 需 `termRatio<0.90`；DEBIT→CREDIT 需 `>1.10`；防止 Regime 频繁切换 |
| IC 方向对齐 | 铁鹰策略改用偏斜感知对齐（`skewAwareAlignment`），替代对称性比率 |
| 多腿滑点 | 2 腿 ×0.7；4 腿 ×0.5 |
| 财报惩罚缩放 | 比例惩罚：`scale = min(2, max(1, movePct/5))`（旧版固定系数） |

---

### Phase 3 — 风险与提醒

| 功能 | 说明 | 文件 |
|------|------|------|
| 价差提醒 | 2 腿持仓纳入监控：监控 cost-to-close vs entry credit | `check-alerts.js` |
| 组合 Greeks 组件 | 4 列显示 Δ/Θ/Vega/Γ + 最大风险行 | `Portfolio.tsx` |
| `aggregatePortfolioGreeks()` | 聚合工具函数，汇总所有持仓 Greeks | `riskSizing.ts` |
| 动态 Kelly | Quarter-Kelly：`b = winPerContract / lossPerContract`（TP/SL 比率），`f = (b×p − q) / b`，实际仓位 `f × 0.25`（默认 kellyFraction） | `riskSizing.ts` |

---

### Phase 4 — 数据质量与验证

| 功能 | 说明 | 文件 |
|------|------|------|
| 降级数据警告 | `zeroGreeks/total > 50%` → 响应中包含 `dataQuality='degraded'` | `scan-options.js`, `strategy-recommend.js` |
| 前端黄色横幅 | `dataQuality === 'degraded'` 时展示黄色警告条 | `StrategyRecommender.tsx` |
| candidate_snapshots 写入 | 策略推荐时 Fire-and-Forget 写入 Top-5 候选（REST fetch，非 JS 客户端） | `strategy-recommend.js` |
| 评分验证端点 | `GET /api/analytics?type=score-validation`：按得分段统计分布（0-30/30-50/50-70/70-100） | `api/analytics.js` |
| Migration 007 | `candidate_snapshots` 表部署（2026-03-01） | `docs/migrations/007_candidate_snapshots.sql` |

---

### Phase 5 — Alpha 机会

| 功能 | 说明 | 文件 |
|------|------|------|
| Regime 切换提醒 | 每日快照 Cron 查询近 5 日 Regime，检测到翻转时发送 Discord 提醒 | `cron-iv-snapshot.js` |
| 执行质量端点 | `GET /api/analytics?type=execution-quality`：基于 Delta 代理对入场时机分类（早/晚/市价） | `api/analytics.js` |

---

## 相关文档

- **核心算法**: `docs/03_核心算法.md`（已更新版本号至 v2.7）
- **API 文档**: `docs/05_API文档.md`
- **Polygon 集成**: `docs/09_Polygon集成.md`
