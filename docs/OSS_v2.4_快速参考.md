# OSS v2.4 快速参考卡

## 🎯 核心改动速查

### P0 Bug 修复（4 项）

| ID | 问题 | 修复 | 文件 |
|----|------|------|------|
| P0-1 | Liquidity 用 `price` 而非 `bid/ask` | 改为真实 bid/ask | `scoring.cjs:709,719` |
| P0-2 | ThetaBurn 三重惩罚 | 权重设为 0，只保留 getThetaPenalty | `scoring.cjs:279`, `oss-core.ts:413` |
| P0-3 | Lambda 线性压缩不足 | 改用 log2 压缩 | `scoring.cjs:33`, `oss-core.ts:88` |
| P0-4 | Spread% ceiling 不一致 | 统一使用 HARD_FILTER_DEFAULTS | `strategy-recommend.js:370,489` |

### P1 核心改进（5 项）

| ID | 改进 | 方法 | 文件 |
|----|------|------|------|
| P1-1 | RV 从 Polygon 计算 | 新增 `calculateRV30FromPolygon` | `strategy-recommend.js:69` |
| P1-2 | Debit Spread 6 维评分 | 增加 theta/BE/EV 维度 | `strategy-recommend.js:505` |
| P1-3 | Soft penalty 层 | 新增 `applySoftPenalties` 函数 | `scoring.cjs:754` |
| P1-4 | Skew fallback 宽化 | 分层 tolerance [0.08, 0.15] | `scoring.cjs:77` |
| P1-6 | Gamma 风险真实化 | 增加 spot/mid 参数 | `scoring.cjs:116` |

---

## 📐 新权重配置

### LOQ Weights (标准)
```javascript
{
    lambda: 0.30,           // 不变
    gammaEff: 0.20,         // 不变
    gammaThetaRatio: 0.15,  // 不变
    thetaBurn: 0,           // ← 从 -0.10 改为 0
    deltaBonus: 0.15,       // 不变
    breakevenPenalty: 0.15  // ← 从 0.10 提升
}
```

### LOQ Day-Trade Weights
```javascript
{
    lambda: 0.30,
    gammaEff: 0.35,
    gammaThetaRatio: 0.20,
    thetaBurn: 0,           // ← 从 -0.05 改为 0
    breakevenPenalty: 0.05,
    penaltyMult: 0.2
}
```

### Debit Spread Weights (新)
```javascript
{
    lambda: 0.25,       // ← 从 0.40 降低
    riskReward: 0.25,   // ← 从 0.35 降低
    delta: 0.15,        // ← 从 0.25 降低
    ev: 0.20,           // ← 新增
    breakeven: 0.10,    // ← 新增
    theta: -0.05        // ← 新增（惩罚）
}
```

---

## 🔧 新函数签名

### calculateRV30FromPolygon
```javascript
async function calculateRV30FromPolygon(ticker: string): Promise<number|null>
```
**返回**: 30 天年化 RV%（如 25.5 = 25.5%）

### applySoftPenalties
```javascript
function applySoftPenalties(
    rawScore: number, 
    opt: { bid, ask, dte, openInterest }, 
    mid: number
): number
```
**返回**: 调整后的 raw score

### getGammaRiskPenalty (增强)
```javascript
function getGammaRiskPenalty(
    gamma: number, 
    theta: number, 
    dte: number,
    spotPrice?: number,  // ← 新增（可选）
    mid?: number         // ← 新增（可选）
): number
```
**返回**: 惩罚分数（0 到 -30）

### compressLambda (修改)
```javascript
function compressLambda(lambda: number): number
```
**新逻辑**: `log2(1 + lambda)`  
**效果**: lambda=20→4.4, lambda=100→6.7, lambda=500→9.0

### calculateSkew (增强)
```javascript
function calculateSkew(
    chain: Array, 
    currentPrice: number, 
    targetDTE: number = 30
): number
```
**新逻辑**: 分层搜索 tolerance [0.08, 0.15]  
**最小链长**: 从 10 降到 6

---

## 🎨 使用示例

### 计算 RV30
```javascript
const rv30 = await calculateRV30FromPolygon('SPY');
console.log(`RV30: ${rv30}%`);  // 例如: RV30: 18.5%
```

### 应用 Soft Penalties
```javascript
const rawScore = 2.5;  // z-score 后的原始分数
const opt = { bid: 3.40, ask: 3.60, dte: 30, openInterest: 1200 };
const mid = 3.50;

const adjustedScore = applySoftPenalties(rawScore, opt, mid);
// 流动性好、DTE 合理 → penalty ≈ 0
```

### Gamma 风险惩罚（新）
```javascript
// 旧用法（仍然支持）
const penalty1 = getGammaRiskPenalty(0.05, -0.02, 7);
// DTE=7 → -25

// 新用法（更精确）
const penalty2 = getGammaRiskPenalty(0.05, -0.02, 7, 450, 3.50);
// gamma=0.05, spot=450, mid=3.50
// gammaExposure = (0.05 × 450) / 3.50 = 6.43
// DTE=7, exposure > 1.5 → -15
```

---

## 📊 效果对比

### Lambda 压缩
| Lambda | v2.3 (线性) | v2.4 (log2) | 改进 |
|--------|-------------|-------------|------|
| 20 | 20 | 4.4 | -78% |
| 100 | 28 | 6.7 | -76% |
| 500 | 68 | 9.0 | -87% |

### Theta 惩罚
| ThetaBurn | v2.3 | v2.4 | 改进 |
|-----------|------|------|------|
| 0.010 | z-score(-0.10) + penalty(-2.5) + G/T | penalty(-2.5) only | 移除双重 |
| 0.020 | z-score(-0.10) + penalty(-10) + G/T | penalty(-10) only | 移除双重 |

### Debit Spread 评分维度
| 版本 | 维度数 | 权重分配 |
|------|--------|---------|
| v2.3 | 3 | Lambda(40%) + R:R(35%) + Delta(25%) |
| v2.4 | 6 | Lambda(25%) + R:R(25%) + Delta(15%) + EV(20%) + BE(10%) + Theta(-5%) |

---

## ⚠️ 注意事项

### 向后兼容性
- ✅ 所有改动向后兼容
- ✅ 新参数为可选，默认 legacy 行为
- ✅ 旧代码无需修改即可运行

### 性能影响
- RV 计算：+1 次 Polygon API 调用（candles）
- Soft penalties：O(1) 计算，可忽略
- Skew 分层搜索：最多 2 次循环，可忽略

### 数据依赖
- **必需**: Polygon API key (`POLYGON_API_KEY`)
- **可选**: IV History 缓存（Supabase）

---

## 🔄 回滚指南

如需回滚到 v2.3：

```bash
# 1. 恢复权重
git checkout v2.3 -- lib/_shared/scoring.cjs
git checkout v2.3 -- src/lib/oss-core.ts

# 2. 恢复 RV 计算（如果 Nasdaq 可用）
git checkout v2.3 -- api/strategy-recommend.js

# 3. 测试
npm run test
```

或手动修改：
- LOQ_WEIGHTS.thetaBurn: 0 → -0.10
- LOQ_WEIGHTS.breakevenPenalty: 0.15 → 0.10
- compressLambda: 恢复线性 decay
- maxSpreadPct: 改回 0.30

---

## 📚 完整文档

- **详细改进总览**: `docs/算法改进总览_OSS_v2.4.md`
- **完整审计报告**: `oss_algorithm_audit.md`
- **变更日志**: `CHANGELOG_OSS.md`
- **核心算法**: `docs/03_核心算法.md`
