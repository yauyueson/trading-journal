# OSS v2.2 算法改进总览

本文档总结我们执行的**八项改动**如何提升期权评分与策略推荐算法（OSS）。前七项已落地，第八项为长期规划。

---

## 1. G/T Ratio（Gamma/Theta）纳入 LOQ 评分

**改动**：在单腿 LOQ 中新增「Gamma/Theta 比」维度，反映「每单位 theta 成本能买到多少 gamma」（即 gamma 的性价比）。

**提升**：
- **更细的性价比区分**：高 G/T =  gamma 相对便宜，适合做方向/波动；低 G/T =  theta 贵，对买方不友好。
- **与 DTE 连续权重配合**：日交权重里提高 G/T 权重，标准期限里保留但不过度主导，使日内 vs 持仓的推荐更合理。
- **结果**：单腿排序时能区分「高 lambda 但 theta 烧钱」与「lambda 适中且 G/T 好」的合约，减少只看杠杆忽略成本的问题。

---

## 2. CSQ 使用完整 EV（Expected Value）替代简单 Edge

**改动**：Credit spread 评分从「Edge = POP × 权利金」改为 **EV = (POP × 权利金) − ((1−POP) × 最大亏损)**，并提高 EV 在总分中的权重（如 30% scoreEV + 25% ROI + 25% POP + 20% Distance）。

**提升**：
- **盈亏同框**：Edge 只看了「期望收入侧」；EV 同时考虑赢面收益和输面亏损，直接回答「这笔交易期望赚/亏多少」。
- **更稳的排序**：高 ROI 但低 POP 的 spread 会被降权，高 POP、合理 ROI 且 EV 为正的 spread 会排到前面。
- **结果**：推荐列表更偏向「正期望、可重复」的卖方交易，而不是单纯高权利金或高 ROI。

---

## 3. Breakeven Move % 指标加入 LOQ

**改动**：在单腿 LOQ 中引入「Breakeven Move」（权利金 / (|delta| × 股价)），并按 DTE 做 sqrt(DTE/30) 归一化后，映射为 breakevenPenalty（利好小 move、惩罚大 move），参与 LOQ raw 计算。

**提升**：
- **风险维度更完整**：不仅看 lambda、theta、gamma，还看「标的需要动多少才能回本」。
- **与期限匹配**：同一 breakeven move，短期限更敏感、长期限更宽容，通过 dte 因子体现。
- **结果**：单腿分数能区分「便宜但需要大涨大跌才回本」与「贵一点但 breakeven 更近」的合约，买方体验更合理。

---

## 4. 波动率 regime：IV Ratio + IV/RV Ratio（不含 IV Rank/IV Percentile）

**改动**：  
- 策略与扫描的 regime 仅基于 **IV Ratio**（iv30/iv90 期限结构）和 **IV/RV Ratio**（iv30 与近期已实现波动率之比）；  
- 每日仍将 iv30/iv90 写入 `ticker_iv_snapshots`（供日后扩展或 backfill 使用）；  
- **不再使用 IV Rank / IV Percentile**（因无真实历史 IV 数据源，此前用 RV 近似不具可比性）；  
- LOQ/CSQ 的 IV 维度仅用 **getIVAdjustment(ivRatio, strategy)**（截面 IV 贵/便宜），不再叠加 IV Rank 微调。

**提升**：
- **指标可解释、可复现**：IV Ratio 与 IV/RV 均来自当日链与行情，无需历史 IV 库。
- **策略与估值一致**：IV Ratio &gt;1（backwardation）偏 long vol；IV/RV &gt;1 偏 credit、&lt;1 偏 debit，与现有 regime 逻辑一致。
- **结果**：UI 与 API 统一展示 IV Ratio、IV/RV Ratio；算法仅依赖这两项，逻辑更清晰。

---

## 5. DTE 连续权重（消除二元切换）

**改动**：LOQ 权重不再按「日交 vs 非日交」二元切换，而是用 **getLOQWeightsForDTE(dte)**：  
- dte ≤ 5：日交权重；  
- dte ≥ 15：标准权重；  
- 5 < dte < 15：各维度在两种权重之间 **lerp 插值**。

**提升**：
- **消除 6 DTE 跳变**：以前 5 DTE 和 7 DTE 可能因「是否日交」而分数突变；现在 5→15 平滑过渡，同一合约不会因刚好跨日交阈值而排名大动。
- **期限与风险一致**：短期更强调 G/T、theta；长期更强调 lambda、delta bonus，过渡连续。
- **结果**：单腿列表在 DTE 边界附近更稳定，用户体验和回测都更合理。

---

## 6. Single LOQ 动态基线（消除跨标的不公平）

**改动**：单腿 LOQ 不再用固定公式「50 + rawScore×12.5」把 raw 映射到 0–100，而是 **在同一链/同一扫描池内** 用该池 raw 的均值与标准差做 z-score，再映射到 0–100（均值→50，±1 标准差≈30/70）。

**提升**：
- **跨标可比**：「70 分」在 AAPL 链和 SPY 链都表示「在该池内明显高于平均」，而不是绝对 raw 值（高波标的 raw 普遍偏高会导致不公平）。
- **同池内排序不变**：相对优劣不变，只是刻度统一到「相对当前池」。
- **结果**：多标的扫描或单标的策略页中，不同标的的 LOQ 分数可以放心横向比较，避免高 IV 标的普遍高分、低 IV 普遍低分的偏差。

---

## 7. POP 改进（基于 Breakeven 而非 Short Strike）

**改动**：Credit spread 的 **Probability of Profit** 不再用「1 − |short delta|」，而是用 **breakeven 处的 delta**：  
- 在链上按同类型、同到期找到 straddle breakeven 的 strike，插值得到 delta_at_BE；  
- POP = 1 − |delta_at_BE|。  
- 若无法插值（如链不全），则退回 short delta。

**提升**：
- **概率定义更贴近期权含义**：POP 应回答「到期时标的价格在 breakeven 有利一侧的概率」；short strike 的 delta 只是「short 腿 ITM 概率」的近似，breakeven 才是盈亏分界线。
- **EV/分数更准**：EV = POP×credit − (1−POP)×maxRisk；POP 更准 → EV 与排序更可信。
- **结果**：Credit spread 的 POP%、EV 和推荐顺序更符合「真实盈亏概率」，尤其宽 spread 或 breakeven 离 short strike 较远时改进明显。

---

## 8. IV Skew（长期规划）

**改动**：尚未实现；规划为在链上利用不同 strike 的 IV 差异（如 25Δ put vs ATM 的 skew、或 put–call skew），用于定价合理性、风险提示或策略选择。

**预期提升**：
- **更细的「贵/便宜」**：同一标的不同 strike 的 IV 不同；用 skew 可判断某一行权价相对整条曲线是贵还是便宜。
- **风险与尾部**：Skew 陡 → 市场对大跌要价高，可提示卖方 tail 风险或调整推荐权重。
- **策略与 skew 结合**：例如 skew 极陡时对卖 OTM put 的推荐更保守，或单独展示 skew 指标供用户参考。

---

## 小结表

| # | 改动 | 核心提升 |
|---|------|----------|
| 1 | G/T Ratio 纳入 LOQ | 单腿区分「gamma 性价比」，日交 vs 持仓更合理。 |
| 2 | CSQ 用完整 EV | Credit 排序更偏正期望、可重复，而非单纯高权利金。 |
| 3 | Breakeven Move 进 LOQ | 单腿多一个「回本难度」维度，与 DTE 匹配。 |
| 4 | IV Ratio + IV/RV Ratio（无 IV Rank/Percentile） | 仅用期限结构与 IV/RV 截面指标，regime 与评分一致、可复现。 |
| 5 | DTE 连续权重 | 消除 5/15 DTE 附近分数跳变，过渡平滑。 |
| 6 | Single LOQ 动态基线 | 跨标分数可比，消除高波标的系统性高分。 |
| 7 | POP 基于 Breakeven | Credit spread 的 POP/EV 更贴近真实盈亏概率。 |
| 8 | IV Skew（规划） | 更细定价与尾部风险，长期增强推荐与风控。 |

整体上，这八项让 OSS 从「截面、单点、固定刻度」走向「纵向历史、多维度、相对池内、概率更准」，在策略推荐与扫描中的一致性和可解释性都有明显提升。
