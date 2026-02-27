# OSS 算法改进总览 v2.7

> 版本: v2.7 · 更新: 2026-02-27 · 类型: Bug 修复 (P0/P1/P2) — Code Audit 专项

---

## 改进概览

| 类别 | 数量 |
|------|------|
| Bug 修复 (P0 — 影响交易) | 4 |
| 系统性偏差修复 (P1) | 3 |
| 精度改进 (P2) | 5 |
| 修改文件 | 4 |

---

## P0：关键 Bug 修复（影响交易决策）

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

## 相关文档

- **核心算法**: `docs/03_核心算法.md`（已更新版本号至 v2.7）
- **API 文档**: `docs/05_API文档.md`
- **Polygon 集成**: `docs/09_Polygon集成.md`
