# OSS 算法改进总览 v2.4

> **更新日期**: 2026-02-13  
> **版本**: OSS v2.4  
> **改进类型**: P0 (Critical Bug Fixes) + P1 (Core Enhancements)

---

## 📋 改进概览

本次更新基于完整的算法审计报告（`oss_algorithm_audit.md`），修复了 4 个关键 bug（P0）并实施了 5 个核心改进（P1）。

### 改进优先级定义

- **P0**: 当日可完成，无需新数据，修复关键 bug
- **P1**: 1-3 天工程量，少量新数据或逻辑重构
- **P2**: 中长期，需要更多工程或数据支持（未包含在本次更新）

---

## 🔴 P0: 关键 Bug 修复

### P0-1: 修复 Unified Score Liquidity Bug

**问题描述**:  
`calculateUnifiedScore` 中 Credit/Debit Spread 的 liquidity 计算使用了 `price` 而非真实的 `bid/ask`，导致：
```javascript
// 错误：bid = ask = price
const sBid = candidate.shortLeg?.price || 0;
const sAsk = candidate.shortLeg?.price || 0;
// 结果：spread = 0 → spreadScore 永远 = 100
```

**修复方案**:
```javascript
// 正确：使用真实 bid/ask
const sBid = candidate.shortLeg?.bid || 0;
const sAsk = candidate.shortLeg?.ask || 0;
// 结果：spread = (ask - bid) / mid → 真实流动性评分
```

**影响文件**: `lib/_shared/scoring.cjs` (Line 709-710, 719-720)

**影响**:
- ✅ Unified Score 的 liquidity 分数现在准确反映真实流动性
- ✅ 流动性差的 spread 不再被高估

---

### P0-2: 移除 ThetaBurn Z-Score 双重惩罚

**问题描述**:  
`thetaBurn` 在 LOQ 评分中被惩罚了三次：
1. Z-score 维度权重 -0.10（线性惩罚）
2. `getThetaPenalty()` 的 quadratic 惩罚（最高 -10 分）
3. 间接通过 G/T ratio（theta 在分母）

**修复方案**:  
移除 z-score 通道，只保留 `getThetaPenalty` 的绝对惩罚：

```javascript
// 旧权重
const LOQ_WEIGHTS = { 
    lambda: 0.30, 
    gammaEff: 0.20, 
    gammaThetaRatio: 0.15, 
    thetaBurn: -0.10,  // ← 移除
    deltaBonus: 0.15, 
    breakevenPenalty: 0.10 
};

// 新权重
const LOQ_WEIGHTS = { 
    lambda: 0.30, 
    gammaEff: 0.20, 
    gammaThetaRatio: 0.15, 
    thetaBurn: 0,  // ← 设为 0
    deltaBonus: 0.15, 
    breakevenPenalty: 0.15  // ← 从 0.10 提升到 0.15
};
```

**影响文件**: 
- `lib/_shared/scoring.cjs` (Line 279-280)
- `src/lib/oss-core.ts` (Line 410-426)

**影响**:
- ✅ 避免过度惩罚高 theta 合约
- ✅ Breakeven 现实性权重提升，更符合 swing 交易风格

---

### P0-3: CompressLambda 改用 Log 压缩

**问题描述**:  
旧的线性 decay 压缩对极端 lambda 值压缩不足：
```javascript
// 旧逻辑
lambda = 500 → compressed = 20 + (500-20) × 0.1 = 68
// 仍然远高于正常值（5-20），主导 z-score
```

**修复方案**:  
使用 log2 压缩：
```javascript
function compressLambda(lambda) {
    const MIN_LAMBDA = 1;
    const clamped = Math.max(MIN_LAMBDA, lambda);
    return Math.log2(1 + clamped);
}

// 效果对比
lambda = 20  → 4.4  (旧: 20)
lambda = 100 → 6.7  (旧: 28)
lambda = 500 → 9.0  (旧: 68)
```

**影响文件**: 
- `lib/_shared/scoring.cjs` (Line 33-38)
- `src/lib/oss-core.ts` (Line 88-92)

**影响**:
- ✅ 低价合约的极端 lambda 不再主导 z-score
- ✅ 评分更平衡，避免"彩票"合约排名过高

---

### P0-4: 统一 maxSpreadPct Ceiling

**问题描述**:  
`strategy-recommend.js` 中硬编码了 `0.30`，而 `scan-options.js` 使用 `HARD_FILTER_DEFAULTS.maxSpreadPctCeiling` (0.12)，导致不一致。

**修复方案**:
```javascript
// 旧代码
if (spreadPct > 0.30) continue;  // Credit Spread
if (spreadPctVal > 0.30) continue;  // Debit Spread

// 新代码
if (spreadPct > HARD_FILTER_DEFAULTS.maxSpreadPctCeiling) continue;
if (spreadPctVal > HARD_FILTER_DEFAULTS.maxSpreadPctCeiling) continue;
```

**影响文件**: `api/strategy-recommend.js` (Line 370, 489)

**影响**:
- ✅ 所有策略使用统一的流动性标准（0.12）
- ✅ 避免推荐流动性过差的 spread

---

## 🟡 P1: 核心改进

### P1-1: RV 从 Polygon Candles 计算

**问题描述**:  
旧实现从 Nasdaq API scraping RV，存在问题：
- 口径不一致：IV 来自 Polygon，RV 来自 Nasdaq
- 不稳定：Nasdaq API 需要 scraping，不保证可用
- 时区/假日差异可能导致 IV/RV ratio 偏差

**改进方案**:  
使用 Polygon `/v2/aggs` API 计算 RV：

```javascript
async function calculateRV30FromPolygon(ticker) {
    const { getCandles } = await import('../lib/polygon-client.js');
    
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - 60);
    
    const candles = await getCandles(ticker, fromStr, toStr, 'day');
    
    // Calculate log returns
    const closes = candles.map(c => c.close);
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
        returns.push(Math.log(closes[i] / closes[i - 1]));
    }
    
    // Use most recent 30 returns
    const recentReturns = returns.slice(-30);
    
    // Population standard deviation
    const mean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
    const variance = recentReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / recentReturns.length;
    
    // Annualize to %
    return Math.sqrt(variance * 252) * 100;
}
```

**影响文件**: `api/strategy-recommend.js` (Line 69-112, 714)

**影响**:
- ✅ IV 和 RV 数据源统一（都来自 Polygon）
- ✅ 更稳定，无需 scraping
- ✅ 使用 population std（与审计报告一致）

---

### P1-2: Debit Spread 评分扩展到 6 维

**问题描述**:  
旧的 Debit Spread 评分只有 3 维：
- Lambda (40%)
- Risk/Reward (35%)
- Delta (25%)

缺少 theta、breakeven、EV 维度，与 LOQ 单腿评分（6+ 维）差距大。

**改进方案**:  
扩展到 6 维评分：

```javascript
// 1. Lambda score (leverage) - 25%
const lambdaScore = Math.min((compLambda / 20) * 100, 100);

// 2. Risk/Reward score - 25%
const rrScore = Math.min((riskReward / 3) * 100, 100);

// 3. Delta score (moneyness) - 15%
const deltaScore = 50 + deltaBonus * 12.5;

// 4. Theta decay penalty (NEW) - -5%
const thetaBurn = Math.abs(longLeg.theta || 0) / effectiveDebit;
const thetaPenalty = getThetaPenalty(thetaBurn);

// 5. Breakeven penalty (NEW) - 10%
const beMove = calculateBreakevenMove(longLeg.strike, effectiveDebit, currentPrice, type);
const bePenalty = getBreakevenPenalty(beMove, longLeg.dte || 30);

// 6. EV score (NEW) - 20%
const evRatio = effectiveDebit > 0 ? expectedValue / effectiveDebit : 0;
const evScore = Math.max(0, Math.min(100, 50 + evRatio * 50));

// Weighted scoring
let finalScore = (0.25 * lambdaScore) + (0.25 * rrScore) + (0.15 * deltaScore) + 
                (0.20 * evScore) + (0.10 * (50 + bePenalty * 12.5)) - (0.05 * thetaPenalty);
```

**影响文件**: `api/strategy-recommend.js` (Line 505-540)

**影响**:
- ✅ Debit Spread 评分更全面，与 LOQ 对齐
- ✅ 考虑 theta decay 和 breakeven 现实性
- ✅ EV 维度提升风险调整后收益的权重

---

### P1-3: Soft Penalty 层

**问题描述**:  
当前只有硬过滤（hard filter），会完全剔除候选。缺少渐进式惩罚机制。

**改进方案**:  
新增 `applySoftPenalties` 函数，在 z-score 之后、normalization 之前应用：

```javascript
function applySoftPenalties(rawScore, opt, mid) {
    let penalty = 0;
    
    // 1. Liquidity penalty (continuous based on spread%)
    const spreadPct = (opt.ask - opt.bid) / mid;
    if (spreadPct > 0.05) {
        penalty -= Math.min(10, (spreadPct - 0.05) * 100);  // 0.05→0, 0.15→-10
    }
    
    // 2. Low price penalty (avoid z-score pollution from 1/mid effects)
    if (mid < 0.50) {
        penalty -= Math.min(8, (0.50 - mid) * 20);  // $0.50→0, $0.10→-8
    }
    
    // 3. Short DTE penalty (non-holding-to-expiry style)
    if (opt.dte < 14) {
        penalty -= Math.min(15, (14 - opt.dte) * 2);  // 14→0, 7→-14
    }
    
    // 4. Extremely low OI penalty
    if (opt.openInterest < 500) {
        penalty -= Math.min(5, (500 - opt.openInterest) / 100);
    }
    
    return rawScore + penalty;
}
```

**影响文件**: `lib/_shared/scoring.cjs` (Line 754-791, export at 838)

**影响**:
- ✅ 渐进式惩罚，不会完全剔除候选
- ✅ 降低流动性差/低价/短DTE/低OI 合约的排名
- ✅ 可在 `scan-options.js` 中调用（需后续集成）

---

### P1-4: Skew Fallback 宽化

**问题描述**:  
旧的 `calculateSkew` 使用固定 tolerance ±0.10，在窄链上经常找不到匹配，返回 0。

**改进方案**:  
使用分层搜索，先尝试紧密 tolerance，再宽化：

```javascript
function calculateSkew(chain, currentPrice, targetDTE = 30) {
    const targetChain = chain.filter(o => Math.abs(o.dte - targetDTE) < 15);
    if (targetChain.length < 6) return 0;

    // Layered search: try tight tolerance first, then widen
    for (const tolerance of [0.08, 0.15]) {
        const puts = targetChain.filter(o => o.type === 'Put' && Math.abs(o.delta + 0.25) < tolerance);
        const calls = targetChain.filter(o => o.type === 'Call' && Math.abs(o.delta - 0.25) < tolerance);
        
        if (puts.length > 0 && calls.length > 0) {
            const put = puts.reduce((a, b) => Math.abs(b.delta + 0.25) < Math.abs(a.delta + 0.25) ? b : a);
            const call = calls.reduce((a, b) => Math.abs(b.delta - 0.25) < Math.abs(a.delta - 0.25) ? b : a);
            
            if (put.iv > 0 && call.iv > 0) {
                return (put.iv - call.iv) / ((put.iv + call.iv) / 2);
            }
        }
    }
    
    return 0;
}
```

**影响文件**: `lib/_shared/scoring.cjs` (Line 77-100)

**影响**:
- ✅ 窄链上的 skew 计算成功率提高
- ✅ 优先使用紧密匹配（0.08），fallback 到宽松匹配（0.15）
- ✅ 最小链长度从 10 降到 6，适应小盘股

---

### P1-5: 结构化解释输出

**状态**: ⏸️ 跳过（建议单独任务）

**原因**: 需要在每个策略构建函数中添加 `factors[]` 数组，涉及大量代码修改。建议作为独立的 UI/UX 改进任务。

**设计方案**（供参考）:
```javascript
{
    "factors": [
        {
            "name": "现实性 (Breakeven)",
            "value": "需标的移动 3.2% (DTE 调整后 4.1%)",
            "impact": "正面",
            "detail": "在 30 天内 3.2% 的移动处于该标的 1σ 范围内"
        },
        {
            "name": "成本效率 (Lambda / R:R)",
            "value": "Lambda 11.2, R:R 2.1:1",
            "impact": "正面",
            "detail": "标的每移动 1%，期权预期回报 11.2%"
        }
        // ... 更多维度
    ]
}
```

---

### P1-6: GetGammaRiskPenalty 使用真实 Gamma

**问题描述**:  
旧实现忽略 `gamma` 和 `theta` 参数，仅按 DTE 硬编码惩罚：
```javascript
// 旧逻辑
if (dte <= 5) return -25;
if (dte <= 10) return -10;
return 0;
```

**改进方案**:  
增加 `spotPrice` 和 `mid` 可选参数，计算 gamma exposure：

```javascript
function getGammaRiskPenalty(gamma, theta, dte, spotPrice = null, mid = null) {
    if (dte > 14) return 0;
    
    // If spot and mid provided, use normalized gamma exposure
    if (spotPrice != null && mid != null && mid > 0) {
        // Dollar gamma per $1 premium
        const gammaExposure = (gamma * spotPrice) / mid;
        
        if (dte <= 5) {
            if (gammaExposure > 1.0) return -30;
            if (gammaExposure > 0.5) return -20;
            return -10;
        }
        if (dte <= 10) {
            if (gammaExposure > 1.5) return -15;
            if (gammaExposure > 0.8) return -8;
            return 0;
        }
        if (gammaExposure > 2.0) return -5;
        return 0;
    }
    
    // Fallback: DTE-only logic (legacy)
    if (dte <= 5) return -25;
    if (dte <= 10) return -10;
    return 0;
}
```

**影响文件**: `lib/_shared/scoring.cjs` (Line 116-155)

**影响**:
- ✅ Gamma 风险惩罚更精确
- ✅ 考虑标的价格和期权价格的归一化
- ✅ 向后兼容（新参数为可选）

---

## 📊 改进效果预期

### 评分质量提升
- **Liquidity 准确性**: 从系统性高估 → 真实反映流动性
- **Lambda 平衡性**: 极端值从主导 z-score → 压缩到合理范围
- **Theta 惩罚**: 从三重惩罚 → 单一绝对惩罚
- **Debit Spread**: 从 3 维 → 6 维全面评分

### 数据源稳定性
- **RV 计算**: 从 Nasdaq scraping → Polygon candles API
- **口径一致**: IV 和 RV 都来自 Polygon

### 风险控制
- **Gamma 风险**: 从 DTE-only → 考虑真实 gamma exposure
- **流动性标准**: 统一 ceiling 0.12
- **Soft penalty**: 渐进式降低不良候选排名

---

## 🔄 回滚方案

所有改动都有明确的回滚路径：

| 改动 | 回滚方法 |
|------|---------|
| P0-1 | 将 `bid/ask` 改回 `price` |
| P0-2 | 恢复旧的 LOQ_WEIGHTS |
| P0-3 | 恢复线性 decay 逻辑 |
| P0-4 | 改回硬编码 0.30 |
| P1-1 | fallback 到 Nasdaq API |
| P1-2 | 恢复 3 维评分公式 |
| P1-3 | bypass `applySoftPenalties` 函数 |
| P1-4 | 恢复单一 tolerance 0.10 |
| P1-6 | 移除可选参数，恢复 DTE-only |

---

## 📝 待办事项

### 短期（1 周内）
- [ ] 在 `scan-options.js` 中集成 `applySoftPenalties`
- [ ] 更新前端显示，反映新的评分维度
- [ ] A/B 测试：对比 v2.3 vs v2.4 的推荐质量

### 中期（2-4 周）
- [ ] 实施 P1-5：结构化解释输出
- [ ] 添加单元测试覆盖所有新函数
- [ ] 性能测试：确保 RV 计算不影响响应时间

### 长期（P2 改进）
- [ ] Moneyness 维度 z-score 分桶
- [ ] 组合级风险控制
- [ ] Backtest 框架
- [ ] ML 特征权重学习

---

## 📚 相关文档

- **完整审计报告**: `oss_algorithm_audit.md`
- **核心算法文档**: `docs/03_核心算法.md`
- **API 文档**: `docs/05_API文档.md`
- **Polygon 集成**: `docs/09_Polygon集成.md`

---

## 🏷️ 版本历史

- **v2.4** (2026-02-13): P0 + P1 改进（本次更新）
- **v2.3** (2026-02-XX): Skew bonus, Slippage modeling, Gamma risk
- **v2.2** (2026-02-XX): Gamma/Theta ratio, Breakeven penalty
- **v2.1** (2026-01-XX): Theta pain curve cap, DTE buckets
- **v2.0** (2026-01-XX): Unified cross-strategy scoring
