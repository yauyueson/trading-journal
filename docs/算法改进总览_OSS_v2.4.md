# OSS 算法改进总览 v2.4

> 版本: v2.4 · 更新: 2026-02-13 · 类型: Critical Bug Fixes (P0) + Core Enhancements (P1)

---

## 改进概览

| 类别 | 数量 |
|------|------|
| Bug 修复 (P0) | 4 |
| 功能增强 (P1) | 5 |
| 新增函数 | 2 |
| 修改函数 | 12 |

---

## P0：关键 Bug 修复

| ID | 问题 | 修复 | 文件 |
|----|------|------|------|
| P0-1 | Unified Score Liquidity 用 `price` 而非 `bid/ask` | 改为真实 bid/ask | `scoring.cjs:709,719` |
| P0-2 | ThetaBurn 三重惩罚（Z-Score + 绝对 + G/T） | 权重设为 0，仅保留 `getThetaPenalty` | `scoring.cjs:279`, `oss-core.ts:413` |
| P0-3 | Lambda 线性压缩无法抑制极端值 | 改用 `log2(1+lambda)` | `scoring.cjs:33`, `oss-core.ts:88` |
| P0-4 | Spread% ceiling 各处不一致 | 统一使用 `HARD_FILTER_DEFAULTS.maxSpreadPctCeiling=0.12` | `strategy-recommend.js:370,489` |

---

## P1：核心改进

### P1-1：RV 从 Polygon Candles 直接计算
停止从 Nasdaq Scraping，改用 Polygon 1.5 年日线数据计算年化 RV30。IV 和 RV 完全统一口径。

```javascript
async function calculateRV30FromPolygon(ticker): Promise<number|null>
// 返回年化 RV%，例如 18.5
```

### P1-2：Debit Spread 评分 3 维 → 6 维

| 版本 | 维度 | 权重 |
|------|------|------|
| v2.3 | Lambda、R:R、Delta | 40/35/25 |
| v2.4 | Lambda、R:R、Delta、**EV**、**BE**、**Theta** | 25/25/15/20/10/−5 |

### P1-3：Soft Penalty 层
新增 `applySoftPenalties(rawScore, opt, mid)`：对低 OI、宽 spread、极短 DTE 合约施加渐进式降分，而不是硬过滤。

### P1-4：Skew Fallback 宽化
`calculateSkew` 改为分层搜索 tolerance `[0.08, 0.15]`，最小链长从 10 降到 6，更多标的可以计算 skew。

### P1-5（已跳过）：结构化解释输出
建议单独任务实现 `factors[]` 数组。

### P1-6：Gamma 风险真实化
`getGammaRiskPenalty` 新增可选参数 `spotPrice` 和 `mid`，用 `(gamma × spot) / mid` 计算真实 dollar gamma exposure，而非 DTE-only 近似。

---

## 权重变更对照

### LOQ 标准权重
```
thetaBurn:       -0.10 → 0       (移除 Z-Score 通道，惩罚仅由 getThetaPenalty 绝对值承担)
breakevenPenalty: 0.10 → 0.15    (加重回本难度)
```

### Lambda 压缩（效果对比）
| Lambda | v2.3 线性 | v2.4 log2 |
|--------|-----------|-----------|
| 20 | 20 | 4.4 |
| 100 | 28 | 6.7 |
| 500 | 68 | 9.0 |

---

## 基础设施 / 部署

- **端点合并**：`option-price.js` + `option-prices-bulk.js` → 统一 `option-prices.js`（GET 单腿 / POST 多腿）
- **Vercel 函数数限**：合并端点后控制在 8–10 个，符合 Hobby Plan 限制
- **Tech Score 自动同步**：Portfolio 加载时静默触发，同一标的同一交易日仅刷新一次（NY Time 冷却）

---

## 相关文档

- **核心算法（含 v2.5 改进）**: `docs/03_核心算法.md`
- **API 文档**: `docs/05_API文档.md`
- **Polygon 集成**: `docs/09_Polygon集成.md`
