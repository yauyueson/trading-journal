import React, { useState } from 'react';
import { BookOpen, Search, Info, Brain, Zap, Clock, Shield, BarChart2, TrendingUp, AlertTriangle, Layers, Percent, Divide, Activity, Target, Timer, Lock, Radio, FlaskConical, Trophy } from 'lucide-react';

interface GlossaryItem {
    id: string;
    term: string;
    category: 'Metric' | 'Concept' | 'Structure' | 'Greek' | 'Strategy' | 'Risk' | 'Setup';
    explanation: string;
    formula?: string;
    whyItMatters: string;
    icon: any;
}

const GLOSSARY: GlossaryItem[] = [
    // --- METRICS ---
    {
        id: 'oss',
        term: 'OSS (Options Scoring System)',
        category: 'Metric',
        icon: Brain,
        explanation: '这是平台的核心大脑，一套专有的多因子量化评分模型。它不仅仅是一个简单的“强弱”指标，而是模仿了顶尖交易员的思维过程。OSS 会根据你选择的策略类型（是做多还是做空，是单腿还是价差）自动调整其评分逻辑。\n\n它综合考量了四个维度的平衡：\n1. 胜率 (Probability of Profit)：这笔交易有多大概率赚钱？\n2. 赔率 (Risk/Reward)：赚一次够亏几次？\n3. 杠杆效率 (Leverage/Lambda)：占用资金的效率如何？\n4. 市场环境 (Regime)：现在是恐慌还是贪婪？\n\n最终得出一个 0-100 的分数。>80分通常意味着这是一个“胖点球”机会——胜率高、赔率好、且顺应市场趋势。',
        whyItMatters: '让你一眼看出这个期权合约在当前市场环境下是否“值得一做”。100分意味着在所有维度上都达到了最佳平衡点。'
    },
    {
        id: 'iv-rv',
        term: 'IV / RV Ratio - 波动率风险溢价',
        category: 'Metric',
        icon: Shield,
        formula: 'Ratio = Implied Volatility (IV) ÷ Realized Volatility (RV)',
        explanation: '这是量化交易中最经典的“估值”指标。它可以被理解为“保险公司的利润率”。\n\n隐含波动率 (IV) 是期权现在的“售价”（市场预期的波动）；实际波动率 (RV) 是股票过去的“成本”（实际发生的波动）。\n\n当 IV/RV > 1.25 时，相当于保险公司（期权卖方）卖出的保单价格，比历史上实际发生的赔付金额高出了 25% 以上。这是一个极其昂贵的保费，意味着市场在恐慌性地买入保护。这时候做卖方（Seller），就是在收割这种非理性的恐惧溢价。反之，如果 Ratio < 1.0，说明期权售价甚至覆盖不了历史风险，这时候买入期权（Buyer）更划算。',
        whyItMatters: 'Ratio > 1.25 说明期权被恐惧情绪推高，适合卖出（做空波动率）。Ratio < 1.0 说明期权便宜，适合买入（做多波动率）。'
    },
    {
        id: 'pop',
        term: 'POP (Probability of Profit)',
        category: 'Metric',
        icon: Shield,
        formula: 'POP ≈ 1 - |Delta| (for OTM options)',
        explanation: '简单来说，这是你这笔交易最终能赚钱的概率。对于虚值期权 (OTM)，Delta 绝对值几乎等同于它最终变成实值 (ITM) 的概率。\n\n所以，POP ≈ 1 - |Delta|。例如，你卖出一个 Delta 为 0.20 的看跌期权（Put），意味着市场认为它有 20% 的概率会跌穿行权价（你会亏损），那么反过来，你有 80% 的概率会赚钱（它归零）。\n\n但要注意：高 POP 必定伴随着低赔率（赚少赔多）。这是金融市场的铁律。卖方策略通常拥有 65%-90% 的 POP，通过大概率的小额盈利积累财富；而买方策略 POP 通常低于 40%，靠的是那一次大爆发的高额回报。',
        whyItMatters: '核心胜率指标。卖家追求高 POP (>65%)，买家则在牺牲 POP 换取高 Lambda（以小博大）。'
    },
    {
        id: 'seller-edge',
        term: 'Seller\'s Edge - 期望值 (EV)',
        category: 'Metric',
        icon: Brain,
        formula: 'EV = (POP × Credit) - ((1-POP) × Max Loss)',
        explanation: '这是区分赌徒和职业交易员的分水岭。赌徒只看“这把能赚多少”，职业交易员看“这把玩 100 次平均能赚多少”。\n\n期望值 (EV) 结合了胜率 (POP) 和 盈亏比。即使你的胜率只有 40%，但如果你赢一次赚 300，输一次亏 100，你的 EV 依然是正的 (0.4*300 - 0.6*100 = +60)。\n\nSeller\'s Edge 特指在卖方策略中，由于 IV 通常高于 RV（恐惧溢价），长期来看卖方的实际胜率往往高于理论 POP。我们的算法会计算这个数学上的“正期望值”，只有当 EV > 0 时，才值得扣动扳机。',
        whyItMatters: '职业玩家的标尺。只要 EV 为正，长期重复交易必胜。'
    },

    // --- GREEKS ---
    {
        id: 'delta',
        term: 'Delta (Δ) - 方向敏感度',
        category: 'Greek',
        icon: Activity,
        formula: 'Δ = ∂Price / ∂Underlying',
        explanation: 'Delta 是期权交易员最重要的指南针，它有三重含义：\n\n1. **速度**：股价涨 $1，期权涨多少钱？Delta 0.5 意味着正股涨 $1，期权涨 $0.5。\n2. **概率**：期权到期时变成实值 (ITM) 的概率。Delta 0.30 约等于 30% 到期概率。\n3. **仓位**：你的期权头寸相当于持有多少股正股。持有一张 Delta 0.5 的 Call，风险敞口等同于持有 50 股股票。\n\n深入理解 Delta，你就能把复杂的期权组合简化成“我到底持有了多少股股票”。卖出一张 Put (Delta -0.30)，等同于你做多了 30 股股票，只是多了个 Gamma 的非线性变化。',
        whyItMatters: 'Delta 就是你的持仓股数。Delta 0.50 意味着你的风险敞口相当于持有 50 股正股。'
    },
    {
        id: 'gamma',
        term: 'Gamma (Γ) - 加速度',
        category: 'Greek',
        icon: Zap,
        formula: 'Γ = ∂Delta / ∂Underlying',
        explanation: '如果 Delta 是速度，Gamma 就是加速度。它衡量 Delta 随股价变化的速度。\n\nGamma 是所有期权买家梦寐以求的东西，也是卖家挥之不去的噩梦。当你买入期权时（Long Gamma），如果股价做对了方向，Gamma 会让你的 Delta 变大（赚更多）；如果做错了方向，Gamma 会让 Delta 变小（亏更少）。这叫“凸性优势”。\n\n反之，卖方（Short Gamma）则面临“做对赚得慢、做错亏得快”的风险。特别是在期权快到期（ATM）时，Gamma 会变得无穷大，股价微小的波动都会导致 Delta 剧烈跳动，这就是著名的“Gamma Risk”。',
        whyItMatters: 'Gamma 是卖家的敌人（因为一旦出错亏损会加速扩大），是买家的朋友（因为做对了利润会加速增长）。'
    },
    {
        id: 'theta',
        term: 'Theta (Θ) - 时间衰减',
        category: 'Greek',
        icon: Clock,
        formula: 'Θ = ∂Price / ∂Time',
        explanation: '期权是会过期的资产，Theta 就是它每天“腐烂”的速度。如果你持有一张 Theta 为 -0.05 的 Call，意味着哪怕股价一分钱不动，你每天早上醒以此都要亏 $5。\n\nTheta 的衰减不是线性的，而是指数级的。在离到期还有 90 天时，Theta 很小；但在最后 30 天，特别是最后 7 天，Theta 会像瀑布一样加速流逝。这就是为什么卖方策略（Seller）通常喜欢做 30-45 天的期权——因为这是 Theta 衰减最陡峭、收割时间价值效率最高的甜蜜区。',
        whyItMatters: '时间是期权买家的敌人，卖家的朋友。最后 30 天的时间衰减会呈指数级加速。'
    },
    {
        id: 'vega',
        term: 'Vega (ν) - 波动率敏感度',
        category: 'Greek',
        icon: BarChart2,
        formula: 'ν = ∂Price / ∂Volatility',
        explanation: 'Vega 衡量期权价格对“市场情绪变化”的敏感度。如果 Vega 是 0.10，意味着隐含波动率 (IV) 每上涨 1%，期权价格就会上涨 $0.10。\n\n长久期的期权（LEAPS）Vega 极大，因为还有很久才到期，未来充满不确定性。如果你买入长期期权，你实际上是在做多 Vega（做多波动率）。\n\n常见的陷阱是：在财报发布前买入期权。虽然财报后股价大跳了，但由于不确定性落地，IV 瞬间暴跌（Volatility Crush），Vega 亏损掉的价值可能完全抵消 Delta 赚到的钱。',
        whyItMatters: '如果 Vega 是 0.10，意味着 IV 每涨 1%，期权价格涨 $0.10。长久期期权 Vega 最大。'
    },

    // --- CONCEPTS ---
    {
        id: 'iv-rank',
        term: 'IV Rank - 波动率排位',
        category: 'Metric',
        icon: BarChart2,
        formula: 'IV Rank = (Current IV - Low IV) ÷ (High IV - Low IV)',
        explanation: 'IV 的绝对值没有意义。20% 的 IV 对可口可乐来说可能是惊天巨浪，但对特斯拉来说就是死水微澜。IV Rank 解决了这个问题，它把当前的 IV 放到过去一年的历史中去比较。\n\nIV Rank = 0，说明现在的 IV 是过去一年最低的（极其便宜）；IV Rank = 100，说明是过去一年最高的（极贵）。\n\n交易的核心在于“均值回归”。当 IV Rank 极高时 (>60)，市场处于非理性恐慌，这时卖出期权胜算极大，因为 IV 最终会回落。当 IV Rank 极低时 (<15)，市场过于自满，买入期权成本极低，一旦有风吹草动，IV 飙升会带来暴利。',
        whyItMatters: '卖方应该在 IV Rank 高 (>50) 时入场，买方应该在 IV Rank 低 (<20) 时入场。'
    },
    {
        id: 'skew',
        term: 'Volatility Skew - 波动率偏度',
        category: 'Metric',
        icon: Divide,
        formula: 'Skew = IV(Put) - IV(Call)',
        explanation: '理论上，同样 Delta 的看涨和看跌期权 IV 应该一样。但现实中，市场总是对“下跌”更恐惧。因此，虚值 Put 的 IV 通常远高于虚值 Call。这就像一个歪嘴笑脸（Smirk）。\n\nSkew 告诉我们市场资金在防守哪一边。如果 Skew 异常高，说明大资金在疯狂买入 Put 避险，Put 极其昂贵。这时候如果你还是机械地做 Iron Condor（双卖），卖 Call 那一端就很不划算。\n\n这时候应该顺势而为：既然 Put 贵，那就卖 Put（Bull Put Spread），赚取这份额外的“恐惧溢价”。',
        whyItMatters: '顺势而为。如果 Skew 很高，说明 Put 极贵，此时构建 Bull Put Spread (卖Put) 胜率和赔率更佳。'
    },
    {
        id: 'backwardation',
        term: 'Backwardation (倒挂)',
        category: 'Structure',
        icon: AlertTriangle,
        explanation: '正常市场结构（Contango）是远期 IV 高于近期 IV（因为未来越远，不确定性越大）。\n\nBackwardation 是一种罕见且极端的异常状态：近期 IV 暴涨，远高于远期。这通常只发生在黑天鹅事件、崩盘或重大利空发生的当下。\n\n对于卖方来说，这简直是遍地黄金。因为近期期权被恐慌情绪推到了天价，此时卖出短期期权 (Short Term)，你可以收到极其丰厚的权利金，而且一旦恐慌消退（均值回归），IV 会断崖式下跌，让你迅速获利平仓。',
        whyItMatters: '卖家的黄金期。短期期权由于恐慌被定价极高，时间损耗极快。'
    },
    {
        id: 'contango',
        term: 'Contango (正向)',
        category: 'Structure',
        icon: TrendingUp,
        explanation: '市场的常态结构。远期 IV > 近期 IV。这意味着随着时间流逝，远期合约会慢慢变成近期合约，IV 会自然下降（Roll Down），但这通常被 Theta 衰减所覆盖。\n\n在 Contango 结构下，买入远期期权（Leaps）通常是比较安稳的策略，因为你没有在对抗极高的近期波动率。同时，可以利用“日历价差 (Calendar Spread)”：卖出较贵的近期期权，买入较便宜的远期期权，套取这个时间结构上的价差。',
        whyItMatters: '对买家友好。时间流逝在远端比较慢，适合中长线布局。'
    },

    // --- STRATEGIES ---
    {
        id: 'credit-spread',
        term: 'Credit Spread - 信用价差',
        category: 'Strategy',
        icon: Layers,
        formula: 'Profit = Credit Received',
        explanation: '这是最经典的“收租”策略。你不需要预测股价涨到哪里，你只需要预测股价“不会跌破哪里”。\n\n操作上，你卖出一个昂贵的期权（Delta 高），同时买入一个便宜的期权（Delta 低）作为保护。这一卖一买之间，你账户里会先收到一笔钱（Credit）。\n\n只要到期时股价没有触及你的卖出价，这笔钱就全是你的了。Credit Spread 的美妙之处在于它利用了期权的所有优势：作为卖方，由于 IV 通常虚高 (IV>RV)，你的胜率天然占优；同时由于有买入腿做保护，你的最大亏损也是锁定的，不会出现“卖裸权”那种一次爆仓的风险。',
        whyItMatters: '高胜率策略。你的盈利不依赖股价大涨，只要股价“不跌破”或“不涨破”某个点位，你就能赢。利用时间 (Theta) 和波动率下降 (Vega) 获利。'
    },
    {
        id: 'kelly',
        term: 'Kelly Criterion - 凯利公式',
        category: 'Strategy',
        icon: Percent,
        formula: 'f* = (p(b+1) - 1) ÷ b',
        explanation: '这是赌博理论和投资管理中的圣杯公式，由香农的同事 John Kelly 提出。它解决了一个终极问题：\n“假设我知道这场赌局的胜率是 60%，赔率是 1:1，我每一把到底该下注多少本金，才能让我的财富增长最快，同时永远不破产？”\n\n答案不是 100%，也不是 1%。凯利公式能给出一个精确的数学最优解。如果超过这个比例（Over-betting），长期来看你的收益反而会下降，甚至归零；如果低于这个比例，你的资金利用率不足。\n\n在期权交易中，由于参数（胜率p）是估算的，为了安全起见，专业交易员通常使用 "Half-Kelly"（半凯利）甚至 "Quarter-Kelly"（1/4 凯利）来决定仓位大小，给自己留足安全边际。',
        whyItMatters: '很多交易员死于重仓。凯利公式告诉你：即使你有 99% 的胜率，如果在这一次梭哈，你最终破产的概率也是 100%。通常使用 "Half-Kelly" 来控制风险。'
    },

    // --- CREDIT SPREAD STRATEGY ---
    {
        id: 'spread-width',
        term: 'Spread Width - 价差宽度',
        category: 'Strategy',
        icon: Layers,
        formula: 'Width = |Short Strike - Long Strike|',
        explanation: '价差宽度决定了你的风险/收益比例和资金效率。以 Bull Put Spread 为例：\n\n$5 宽度：每手最大风险 $500，权利金收入约 $50-80。资金需求小，但每手利润也小。\n$10 宽度：每手最大风险 $1000，权利金收入约 $100-160。中等规模，适合短线策略。\n$15 宽度：每手最大风险 $1500，权利金收入约 $150-250。WFA 验证显示资金利用率 64%，线性扩展效果最佳。\n\n关键洞察：宽度越大，权利金收入几乎按比例增长（线性），但胜率基本不变（因为卖出腿相同）。所以在资金允许的情况下，适当加宽价差可以提高绝对收益而不显著增加风险概率。\n\n我们的验证结论：Swing 用 $15 宽度，Short-Term 用 $10 宽度。',
        whyItMatters: 'Swing 策略验证最优宽度 $15（资金利用率 64%），Short-Term 最优 $10。宽度决定了每手的绝对收益和风险。'
    },
    {
        id: 'dte-sweet-spot',
        term: 'DTE Sweet Spot - 最佳到期窗口',
        category: 'Strategy',
        icon: Target,
        formula: 'Swing: 45-65 DTE | Short-Term: 7-21 DTE',
        explanation: 'DTE (Days To Expiration) 的选择是 Credit Spread 策略的核心参数之一。\n\n45-65 DTE（Swing）：这是 Theta 衰减曲线的"甜蜜区"。在这个窗口，时间价值的衰减速度开始明显加速，但你还有足够的时间让不利走势自行修正。过早入场（>70 DTE），Theta 衰减太慢，占用资金时间过长；过晚入场（<30 DTE），Gamma 风险急剧上升，股价小幅波动就可能吃掉你所有利润。\n\n7-21 DTE（Short-Term / 130M）：短线策略利用的是 Theta 的"末日加速"效应。在最后 2-3 周，时间价值衰减呈指数级加速。配合 130M（3 bars/day）的信号系统，可以精确捕捉短期趋势。但风险也更高——Gamma 在这个阶段非常敏感，需要更严格的信号过滤。\n\nWFA 研究覆盖了 648 种配置，确认这两个窗口是最优的。',
        whyItMatters: 'Theta 衰减在 45-65 天开始加速（Swing），7-21 天达到峰值（Short-Term）。偏离这些窗口会降低策略效率。'
    },
    {
        id: 'take-profit',
        term: 'Take Profit Rules - 止盈规则',
        category: 'Strategy',
        icon: Trophy,
        formula: 'Swing: 30% of max profit | Short-Term: 50% of max profit',
        explanation: '为什么不等到 100% 利润？因为 Theta 衰减的边际收益递减。\n\n假设你卖出了一个 Credit Spread，收到 $1.50 的权利金（最大利润）。在头 2-3 周，价差可能已经从 $1.50 缩到了 $1.05（30% 利润）。但要把剩余的 $1.05 也赚到，你可能需要再等 3-4 周，承担股价反转的全部风险。\n\n数学上，前 30% 的利润可能在 40% 的持仓时间内完成；而最后 30% 的利润却需要占用 60% 的时间。这就是"边际递减"。\n\nSwing 30%：较早止盈，释放资金投入新交易，提高资金周转率。WFA 验证略优于 50%。\nShort-Term 50%：短线到期快，Theta 加速更猛，可以贪心一点。WFA 验证 50% 优于 30%。\n\n关键：止盈后不要回头看。如果你发现自己经常在想"早知道不止盈了"，那说明你的止盈规则正在保护你——因为你只记得那些继续赚钱的案例，却忘记了止盈后反转的情况。',
        whyItMatters: 'WFA 验证：Swing 在 30% 止盈效率最高，Short-Term 在 50%。边际 Theta 衰减递减，早止盈提高资金周转。'
    },
    {
        id: 'time-stop',
        term: 'Time Stop - 时间止损',
        category: 'Risk',
        icon: Timer,
        formula: 'Swing: DTE ≤ 3 close | Short-Term: DTE ≤ 1 close',
        explanation: '为什么需要时间止损？因为越接近到期，Gamma 风险呈指数级增长。\n\n在到期前 3 天（Swing）或 1 天（Short-Term），即使你的价差还在赚钱，也应该主动平仓。原因：\n\n1. Gamma 爆炸：股价微小的波动就能让你从盈利变成最大亏损。你的命运完全取决于到期日的收盘价，而不是你的分析。\n2. Pin Risk：如果股价恰好"钉"在你的卖出行权价附近，你可能面临被行权的风险，需要处理底层股票头寸。\n3. 流动性枯竭：临近到期的期权买卖价差会显著扩大，平仓成本上升。\n\n时间止损是一条铁律。不论盈亏，到了 DTE 阈值就平仓。这不是"认输"——这是专业的风险管理。',
        whyItMatters: 'Gamma 在到期前呈指数级增长。DTE ≤ 3（Swing）或 DTE ≤ 1（Short-Term）必须平仓，无论盈亏。'
    },
    {
        id: 'defined-risk',
        term: 'Defined Risk - 有限风险',
        category: 'Risk',
        icon: Lock,
        formula: 'Max Loss = (Width - Credit) × 100 × Contracts',
        explanation: 'Credit Spread 最优美的特性：你的最大亏损在建仓时就已经锁定，永远不会超过这个数字。\n\n这是因为你同时买入了一个保护腿（Long Leg）。不管标的股票暴跌 50% 还是 80%，你的亏损上限就是 (宽度 - 收到的权利金) × 合约乘数。\n\n这就是为什么我们的策略不需要传统的价格止损 (Stop Loss)：\n1. WFA 回测 7000+ 组合验证：设置 2× 止损反而摧毁收益（OOS Sharpe 从 1.3 降到 0.04）。\n2. 原因：Credit Spread 的盈亏曲线是非线性的。价差在到期前的波动远大于最终结果。在中途触发止损，你会在最终本可以赢的交易上锁定亏损。\n3. 定义好风险（Width × Contracts），让概率去工作。大数定律会保护你。',
        whyItMatters: 'Credit Spread 的风险在建仓时锁定。WFA 验证：Stop Loss 2× 会摧毁收益（Sharpe 0.04）。不需要止损，让定义好的风险自然运作。'
    },
    {
        id: 'iv-regime',
        term: 'IV Regime - 波动率环境',
        category: 'Concept',
        icon: BarChart2,
        formula: 'CREDIT: IV30/IV90 > 1.05 | DEBIT: < 0.95 | NEUTRAL: 0.95-1.05',
        explanation: '市场的波动率不是一个静态数字，它有自己的"情绪周期"——我们称之为 IV Regime（波动率环境）。\n\nCREDIT Regime（卖方环境）：当 IV 的期限结构倒挂（IV30 > IV90，即近期波动率高于远期），说明市场正在恐慌。这时候卖出期权（Credit Spread）胜率极高，因为你在高位卖出了"恐惧溢价"，IV 均值回归会帮你赚钱。\n\nDEBIT Regime（买方环境）：当 IV 正向（IV30 < IV90），说明市场平静到极点。期权便宜，买入看涨/看跌期权（Debit Spread）的成本低，一旦波动爆发，收益巨大。\n\nNEUTRAL：市场正常状态，IV 期限结构平坦。此时 Credit 和 Debit 都没有明显的结构性优势。\n\n我们的系统会自动检测当前 IV Regime，只在 CREDIT Regime 下推荐 Credit Spread 策略。',
        whyItMatters: '只在 CREDIT Regime 下做 Credit Spread。IV 期限结构倒挂意味着市场恐慌，卖出期权胜率最高。'
    },
    {
        id: 'wfa',
        term: 'WFA (Walk-Forward Analysis)',
        category: 'Concept',
        icon: FlaskConical,
        explanation: 'Walk-Forward Analysis 是我们验证策略参数的核心方法论。它解决了回测中最致命的问题：过拟合。\n\n传统回测的陷阱：你用 5 年数据找到"完美参数"（胜率 95%！），但这些参数只是完美地拟合了历史噪音，对未来毫无预测力。\n\nWFA 的做法：\n1. 将历史数据切成 12 个滚动窗口（如 6 个月训练 + 2 个月测试）\n2. 在每个训练窗口中独立寻找最优参数\n3. 用这些参数在对应的测试窗口（OOS = Out-of-Sample）上验证\n4. 统计所有 OOS 窗口的综合表现\n\n如果一个策略在 12 个独立的 OOS 测试中都保持正收益，那它的稳健性远高于传统回测。\n\n我们的 WFA 结果：Swing 策略 OOS Sharpe 1.275，胜率 89.52%。Short-Term 130M 策略 OOS Sharpe 2.22，胜率 84.6%。这些数字来自 5556+ 条 OOS 交易，横跨 15 只股票和 7-12 个独立时间窗口。',
        whyItMatters: 'WFA 防止过拟合。我们的策略经过 5556+ 条 OOS 交易验证，不是简单的历史回测结果。'
    },
    {
        id: 'signal-system',
        term: 'Signal System (EMA/MOM/EM)',
        category: 'Concept',
        icon: Radio,
        formula: 'EMA = Trend Following | MOM = Momentum Burst | EM = Combined',
        explanation: '我们的信号系统使用三种预设模式来检测入场时机：\n\nEMA（趋势跟踪）：基于多层指数移动平均线 (EMA Stack) 的方向判断。当短期 EMA > 中期 EMA > 长期 EMA 时，确认上升趋势（BULL）；反之确认下降趋势（BEAR）。优点：稳定可靠，假信号少。缺点：响应慢，可能错过快速反转。\n\nMOM（动量爆发）：基于价格动量和市场偏差 (Market Bias) 的短期强度指标。捕捉的是"价格正在加速运动"的时刻。优点：响应快，抓得住急涨急跌。缺点：在震荡行情中假信号多。\n\nEM（EMA + Momentum 组合）：将趋势方向（EMA）和动量强度（MOM）结合。只有两者同时确认时才发出信号。这是 Short-Term 130M 策略的默认模式。WFA 研究显示 EM 的泛化评级最高（Grade A），因为它同时过滤了趋势假信号和动量噪音。',
        whyItMatters: 'Swing 使用 EMA 或 MOM，Short-Term 使用 EM（Grade A 泛化评级）。信号决定入场时机，WFA 验证了各预设的最优适用场景。'
    },
    {
        id: 'max-drawdown',
        term: 'Max Drawdown - 最大回撤',
        category: 'Risk',
        icon: AlertTriangle,
        formula: 'Max DD = (Peak - Trough) ÷ Peak × 100%',
        explanation: '最大回撤衡量的是从资产净值最高点到最低点之间的最大跌幅。它是风险管理中最重要的生存指标。\n\n为什么它比胜率更重要？因为回撤直接影响你的心理和资金生存：\n- 10% 回撤：需要 11% 的回报才能回本。可以接受。\n- 25% 回撤：需要 33% 的回报才能回本。开始痛苦。\n- 50% 回撤：需要 100% 的回报才能回本。几乎不可能恢复。\n\n这就是为什么我们将最大回撤控制在 15% 以内（WFA 实际：Swing 4.64%，Short-Term 12.9%）。\n\n一个胜率 90% 但最大回撤 50% 的策略，远不如一个胜率 85% 但最大回撤 10% 的策略。因为前者只需要一次极端事件就能毁掉你的账户，而后者你可以安心地睡觉。',
        whyItMatters: '回撤 >25% 几乎不可能恢复。我们的策略目标 Max DD <15%（WFA 实际：Swing 4.64%，Short-Term 12.9%）。'
    },
    {
        id: 'winrate-vs-ev',
        term: 'Win Rate vs Expectancy',
        category: 'Concept',
        icon: Trophy,
        formula: 'Expectancy = (WR × Avg Win) - ((1-WR) × Avg Loss)',
        explanation: '在 Credit Spread 策略中，高胜率不是虚荣指标——它是策略的核心引擎。\n\n为什么高 WR 对 Credit Spread 特别重要：\n1. 心理稳定性：85%+ 的胜率意味着每 20 笔交易只有 2-3 笔亏损。这让你有信心持续执行系统，不会因为连续亏损而放弃策略。\n2. 复利效应：小额高频盈利比低频大额盈利更利于复利。每笔赚 $150（30% TP），20 笔中 17 笔赢 = +$2550，3 笔输 $1350（假设 Max Loss $450/笔） = 净利 +$1200。\n3. 有界亏损：Credit Spread 的最大亏损被 Width 锁定。所以即使那 15% 的亏损交易触发 Max Loss，你的亏损也是已知的、有限的。这和低胜率策略（30% WR, 大赢小亏）本质不同——低胜率策略的连续亏损可能击穿心理防线。\n\nExpectancy（期望值）结合了胜率和盈亏比。我们的 WFA 验证：Swing Expectancy +$35/trade，Short-Term +$48/trade。',
        whyItMatters: '85%+ 胜率不是虚荣指标。Credit Spread 的有界亏损 + 高胜率 = 稳定复利。WFA 验证期望值为正。'
    },

];

export const Academy: React.FC = () => {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

    const categories = ['Metric', 'Greek', 'Strategy', 'Risk', 'Concept', 'Structure'];

    const filteredGlossary = GLOSSARY.filter(item => {
        const matchesSearch = item.term.toLowerCase().includes(searchQuery.toLowerCase()) ||
            item.explanation.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesCategory = selectedCategory ? item.category === selectedCategory : true;
        return matchesSearch && matchesCategory;
    });

    return (
        <div className="fade-in pb-20 sm:pb-10 font-sans max-w-5xl mx-auto">
            {/* Header section with glass effect */}
            <div className="mb-6 sm:mb-10 text-center">
                <div className="inline-block p-3 bg-accent-green/10 rounded-2xl mb-3 sm:mb-4 border border-accent-green/20">
                    <BookOpen className="text-accent-green w-7 h-7 sm:w-8 sm:h-8" />
                </div>
                <h1 className="text-2xl sm:text-4xl font-extrabold text-white mb-2 tracking-tight">Trading Academy</h1>
                <p className="text-gray-400 text-sm sm:text-lg">Credit Spread strategy concepts, risk management, and WFA-validated rules.</p>
            </div>

            {/* Search and Filters */}
            <div className="flex flex-col gap-4 mb-8">
                <div className="relative">
                    <input
                        type="text"
                        placeholder="Search terms, formulas or concepts..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full bg-[#1C1C1E] border border-[#2A2A2A] text-white rounded-xl pl-12 pr-4 py-3.5 sm:py-4 focus:outline-none focus:border-accent-green transition-all shadow-xl text-sm sm:text-base"
                    />
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" size={20} />
                </div>
                <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
                    {categories.map(cat => (
                        <button
                            key={cat}
                            onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
                            className={`px-3.5 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-bold border transition-all shrink-0 ${selectedCategory === cat
                                ? 'bg-accent-green text-black border-accent-green'
                                : 'bg-[#1C1C1E] text-gray-400 border-[#2A2A2A] hover:border-gray-600'
                                }`}
                        >
                            {cat}
                        </button>
                    ))}
                </div>
            </div>

            {/* Content Grid */}
            <div className="grid grid-cols-1 gap-6">
                {filteredGlossary.length > 0 ? (
                    filteredGlossary.map((item) => (
                        <div
                            key={item.id}
                            className="bg-[#1C1C1E] border border-[#2A2A2A] rounded-2xl p-6 hover:border-[#444] transition-all group overflow-hidden relative"
                        >
                            {/* Decorative background icon */}
                            <item.icon className="absolute -right-4 -top-4 w-32 h-32 text-white/5 group-hover:text-white/10 transition-colors pointer-events-none" />

                            <div className="flex items-start gap-4 relative z-10">
                                <div className="p-3 bg-white/5 rounded-xl border border-white/10 group-hover:bg-accent-green/10 group-hover:border-accent-green/30 transition-all">
                                    <item.icon className="w-6 h-6 text-gray-400 group-hover:text-accent-green transition-colors" />
                                </div>
                                <div className="flex-1">
                                    <div className="flex flex-wrap items-center gap-3 mb-2">
                                        <h3 className="text-xl font-bold text-white tracking-wide">{item.term}</h3>
                                        <span className={`text-[10px] uppercase font-black px-2 py-0.5 rounded border ${item.category === 'Metric' ? 'bg-purple-500/10 text-purple-400 border-purple-500/30' :
                                            item.category === 'Greek' ? 'bg-pink-500/10 text-pink-400 border-pink-500/30' :
                                                item.category === 'Strategy' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                                                    item.category === 'Risk' ? 'bg-red-500/10 text-red-400 border-red-500/30' :
                                                        item.category === 'Concept' ? 'bg-blue-500/10 text-blue-400 border-blue-500/30' :
                                                            'bg-orange-500/10 text-orange-400 border-orange-500/30'
                                            }`}>
                                            {item.category}
                                        </span>
                                    </div>

                                    <p className="text-gray-400 leading-relaxed mb-4 text-[15px]">
                                        {item.explanation}
                                    </p>

                                    {item.formula && (
                                        <div className="bg-black/40 rounded-xl p-4 mb-4 border border-white/5 font-mono text-sm group-hover:border-accent-green/20 transition-colors">
                                            <div className="text-gray-500 text-[10px] uppercase font-bold mb-1 tracking-widest">Formula</div>
                                            <div className="text-accent-green font-bold text-base">{item.formula}</div>
                                        </div>
                                    )}

                                    <div className="flex items-start gap-2 bg-[#2C2C2E] rounded-xl p-4 border-l-4 border-accent-green/50">
                                        <Info size={18} className="text-accent-green shrink-0 mt-0.5" />
                                        <div>
                                            <div className="text-white text-xs font-bold uppercase mb-1 tracking-wider">Trading Edge</div>
                                            <div className="text-gray-300 text-sm italic">{item.whyItMatters}</div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="text-center py-20 bg-[#1C1C1E] rounded-3xl border border-[#2A2A2A] border-dashed">
                        <div className="mb-4 flex justify-center">
                            <AlertTriangle size={48} className="text-gray-600" />
                        </div>
                        <h3 className="text-xl font-bold text-gray-400 mb-1">No matches found</h3>
                        <p className="text-gray-500">Try searching for different keywords or clear your filters.</p>
                        <button
                            onClick={() => { setSearchQuery(''); setSelectedCategory(null); }}
                            className="mt-6 text-accent-green font-bold hover:underline"
                        >
                            Clear all filters
                        </button>
                    </div>
                )}
            </div>

            {/* Footer Tip */}
            <div className="mt-12 text-center text-gray-500 text-sm">
                <p>Not finding what you need? Data updates every 15 minutes. Happy Trading!</p>
            </div>
        </div>
    );
};
