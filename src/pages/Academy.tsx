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
        explanation: '这是平台的核心引擎，一套多因子量化评分模型。它不是简单的「强弱」指标，而是把顶级交易员的思考流程结构化了出来。OSS 会根据你选择的策略类型（做多 / 做空、单腿 / 价差）自动调整评分逻辑。\n\n综合权衡的四个维度：\n1. 胜率 (Probability of Profit)：这笔交易最终赚钱的概率有多高？\n2. 赔率 (Risk/Reward)：赢一次能覆盖几次输？\n3. 杠杆效率 (Leverage / Lambda)：每一块资金的工作效率如何？\n4. 市场环境 (Regime)：现在偏恐慌还是偏贪婪？\n\n最终输出一个 0–100 的分数。> 80 分通常意味着这是一个高确定性的机会——胜率高、赔率好、并且顺势。',
        whyItMatters: '让你一眼看出这个合约在当前市场环境下是否「值得做」。100 分代表所有维度都达到了最佳平衡点。'
    },
    {
        id: 'iv-rv',
        term: 'IV / RV Ratio - 波动率风险溢价',
        category: 'Metric',
        icon: Shield,
        formula: 'Ratio = Implied Volatility (IV) ÷ Realized Volatility (RV)',
        explanation: '这是量化交易中最经典的「估值」指标，可以理解为保险公司的毛利率。\n\n隐含波动率 (IV) 是期权当下的「售价」——市场预期未来会有多大波动；已实现波动率 (RV) 则是过去真实发生的波动，相当于历史「成本」。\n\n当 IV / RV > 1.25 时，意味着期权卖方收到的保费比历史平均赔付高出 25% 以上——一份非常昂贵的保单，反映出市场正在恐慌性地买入保护。此时做卖方，就是在收割这层非理性的恐惧溢价。反过来，如果 Ratio < 1.0，期权售价甚至覆盖不了历史风险，这时候做买方更划算。',
        whyItMatters: 'Ratio > 1.25：期权被恐惧情绪推高，适合卖出（做空波动率）。Ratio < 1.0：期权便宜，适合买入（做多波动率）。'
    },
    {
        id: 'pop',
        term: 'POP (Probability of Profit)',
        category: 'Metric',
        icon: Shield,
        formula: 'POP ≈ 1 - |Delta| (for OTM options)',
        explanation: '简单说，这是这笔交易最终赚钱的概率。对于虚值期权 (OTM)，|Delta| 近似等于它最终变成实值的概率。\n\n所以 POP ≈ 1 − |Delta|。例如，卖出一张 Delta = 0.20 的虚值 Put：市场认为它有 20% 的概率会跌穿行权价（你会亏损），反过来你就有 80% 的概率赚钱（期权归零）。\n\n注意：高 POP 必然伴随低赔率（赚少亏多），这是市场的铁律。卖方策略通常 POP 在 65%–90% 之间，靠大量小额盈利累积；买方策略 POP 一般低于 40%，靠的是少数几次爆发的高额回报。',
        whyItMatters: '核心胜率指标。卖方追求高 POP (> 65%)，买方则用低 POP 换取高杠杆 (Lambda)，以小博大。'
    },
    {
        id: 'seller-edge',
        term: 'Seller\'s Edge - 期望值 (EV)',
        category: 'Metric',
        icon: Brain,
        formula: 'EV = (POP × Credit) - ((1-POP) × Max Loss)',
        explanation: '这是区分赌徒与职业交易员的分水岭。赌徒只盯着「这一把能赚多少」，职业交易员问的是「这把重复 100 次，平均下来能赚多少」。\n\n期望值 (EV) 把胜率和盈亏比放进同一个公式。哪怕胜率只有 40%，只要赢一次赚 300、输一次亏 100，EV 依然为正：0.4 × 300 − 0.6 × 100 = +60。\n\nSeller\'s Edge 特指卖方策略的结构性优势——由于 IV 长期高于 RV（恐惧溢价），卖方的实际胜率通常优于理论 POP。系统会自动计算这个数学期望，只有当 EV > 0 时才值得扣动扳机。',
        whyItMatters: '职业交易员的标尺。EV 为正，长期重复就一定赚钱；EV 为负，胜率再高也只是慢性亏损。'
    },

    // --- GREEKS ---
    {
        id: 'delta',
        term: 'Delta (Δ) - 方向敏感度',
        category: 'Greek',
        icon: Activity,
        formula: 'Δ = ∂Price / ∂Underlying',
        explanation: 'Delta 是期权交易员最重要的指南针，一个数字承载三层含义：\n\n1. **速度**：标的涨 $1，期权涨多少。Delta = 0.5 意味着正股涨 $1，期权涨 $0.5。\n2. **概率**：期权到期时变成实值的概率。Delta = 0.30 约等于 30% 的到期概率。\n3. **仓位**：你的期权头寸折合多少股正股。持有一张 Delta 0.5 的 Call，风险敞口约等于持有 50 股股票。\n\n吃透 Delta，你就能把复杂的期权组合简化成一句话——「我到底相当于持有多少股」。卖出一张 Delta = −0.30 的 Put，等于做多 30 股股票，只是额外背了 Gamma 的非线性。',
        whyItMatters: 'Delta 就是你的实际持仓股数。Delta = 0.50 等于持有 50 股正股的方向敞口。'
    },
    {
        id: 'gamma',
        term: 'Gamma (Γ) - 加速度',
        category: 'Greek',
        icon: Zap,
        formula: 'Γ = ∂Delta / ∂Underlying',
        explanation: 'Delta 是速度，Gamma 就是加速度——它衡量 Delta 本身随股价变化的快慢。\n\nGamma 是所有期权买方梦寐以求、卖方挥之不去的存在。买方（Long Gamma）做对方向时，Gamma 让 Delta 越变越大（利润加速膨胀）；做错方向时，Gamma 让 Delta 收缩（亏损减速）——这就是所谓的「凸性优势」。\n\n反过来，卖方（Short Gamma）面对的是「做对赚得慢、做错亏得快」的不对称风险。尤其在期权临近到期且接近实值（ATM）时，Gamma 趋于无穷大，价格的微小波动都会让 Delta 剧烈跳动——这就是著名的「Gamma Risk」。',
        whyItMatters: 'Gamma 是卖方的敌人（出错时亏损加速放大），是买方的朋友（做对时利润加速增长）。'
    },
    {
        id: 'theta',
        term: 'Theta (Θ) - 时间衰减',
        category: 'Greek',
        icon: Clock,
        formula: 'Θ = ∂Price / ∂Time',
        explanation: '期权是有保质期的资产，Theta 衡量的就是它每天「衰减」的速度。如果你持有一张 Theta = −0.05 的 Call，那么哪怕股价一分钱不动，每天醒来你都会损失 $5（−$0.05 × 100）。\n\nTheta 的衰减不是线性的，而是指数级的。距离到期还有 90 天时，Theta 很温和；但在最后 30 天，尤其是最后一周，Theta 会像瀑布一样加速。这正是卖方策略普遍偏好 30–45 DTE 的原因——这一段是时间价值衰减最陡峭、收割效率最高的甜蜜区。',
        whyItMatters: '时间是买方的敌人、卖方的朋友。最后 30 天的衰减会呈指数级加速。'
    },
    {
        id: 'vega',
        term: 'Vega (ν) - 波动率敏感度',
        category: 'Greek',
        icon: BarChart2,
        formula: 'ν = ∂Price / ∂Volatility',
        explanation: 'Vega 衡量期权价格对「市场情绪变化」的敏感度。Vega = 0.10 意味着隐含波动率 (IV) 每上升 1%，期权价格上涨 $0.10。\n\n长久期期权（如 LEAPS）的 Vega 极大——离到期越远，未来不确定性越大。买入长期期权，本质上就是在做多 Vega（做多波动率）。\n\n一个常见的陷阱是「财报前买期权」：财报后股价确实大幅跳动，但由于不确定性落地，IV 瞬间暴跌（Volatility Crush），Vega 端的亏损往往会把 Delta 端赚到的钱完全抵消掉。',
        whyItMatters: 'Vega = 0.10 意味着 IV 每涨 1%，期权价格涨 $0.10。期权越长久期，Vega 越大。'
    },

    // --- CONCEPTS ---
    {
        id: 'iv-rank',
        term: 'IV Rank - 波动率排位',
        category: 'Metric',
        icon: BarChart2,
        formula: 'IV Rank = (Current IV - Low IV) ÷ (High IV - Low IV)',
        explanation: 'IV 的绝对值没有意义——20% 的 IV 对可口可乐是惊涛骇浪，对特斯拉却是风平浪静。IV Rank 把当前 IV 放到过去一年的范围内做百分位比较，解决了这个跨标的不可比的问题。\n\nIV Rank = 0：当前 IV 是过去一年的最低点（极其便宜）；IV Rank = 100：过去一年的最高点（极其昂贵）。\n\n交易的核心是「均值回归」。当 IV Rank 极高 (> 60) 时，市场处于非理性恐慌，此时卖期权胜算最大，因为 IV 终将回落；当 IV Rank 极低 (< 15) 时，市场过度自满，买期权成本最低，一旦风吹草动，IV 飙升会带来杠杆式收益。',
        whyItMatters: '卖方在 IV Rank 高 (> 50) 时入场，买方在 IV Rank 低 (< 20) 时入场。'
    },
    {
        id: 'skew',
        term: 'Volatility Skew - 波动率偏度',
        category: 'Metric',
        icon: Divide,
        formula: 'Skew = IV(Put) - IV(Call)',
        explanation: '理论上，同样 Delta 的 Call 和 Put 应该有相同的 IV。但现实中，市场对「下跌」永远更恐惧——所以虚值 Put 的 IV 普遍高于虚值 Call，整条 IV 曲线呈现出一边高一边低的「歪嘴笑脸」（Smirk）。\n\nSkew 告诉你大资金在哪一边防守。Skew 异常高时，说明机构在疯狂买 Put 避险，Put 极其昂贵——此时机械地做双向卖方（如 Iron Condor）就很不划算，因为卖 Call 那一端的溢价被压扁了。\n\n更聪明的做法是顺势而为：既然 Put 贵，那就卖 Put（Bull Put Spread），把这层额外的恐惧溢价收入囊中。',
        whyItMatters: '顺势而为。Skew 高时 Put 极贵，做 Bull Put Spread（卖 Put）的胜率和赔率都更佳。'
    },
    {
        id: 'backwardation',
        term: 'Backwardation (倒挂)',
        category: 'Structure',
        icon: AlertTriangle,
        explanation: '正常的市场结构（Contango）是远期 IV 高于近期 IV，因为时间越远，不确定性越多。\n\nBackwardation 则是一种罕见且极端的异常结构：近期 IV 暴涨，反过来高于远期。它通常只在黑天鹅事件、崩盘或重大利空当下短暂出现。\n\n对卖方来说，这简直是遍地黄金。近期期权被恐慌推到天价，此时卖出短期期权可以收到极厚的权利金；一旦恐慌消退（均值回归），IV 断崖式下跌，你能迅速获利平仓。',
        whyItMatters: '卖方的黄金窗口。短期期权因恐慌被定价过高，且时间价值衰减极快。'
    },
    {
        id: 'contango',
        term: 'Contango (正向)',
        category: 'Structure',
        icon: TrendingUp,
        explanation: '市场的常态结构：远期 IV > 近期 IV。随着时间流逝，远期合约会逐步「滚」成近期合约，IV 自然向下回落（Roll Down），但这部分通常已被 Theta 衰减消化。\n\n在 Contango 结构下，买入远期期权（如 LEAPS）通常比较稳健，因为你不必在高位对抗近期的波动率。也可以利用「日历价差 (Calendar Spread)」：卖出较贵的近期期权、买入较便宜的远期期权，赚取期限结构上的价差。',
        whyItMatters: '对买方友好。远端时间流逝缓慢，适合中长线布局。'
    },

    // --- STRATEGIES ---
    {
        id: 'credit-spread',
        term: 'Credit Spread - 信用价差',
        category: 'Strategy',
        icon: Layers,
        formula: 'Profit = Credit Received',
        explanation: '这是最经典的「收租」策略。你不需要预测股价会涨到哪里，只需要判断它「不会跌破哪里」。\n\n操作上：卖出一张较贵的期权（Delta 高），同时买入一张较便宜的期权（Delta 低）作为保护。一卖一买之间，账户先收到一笔权利金 (Credit)。\n\n只要到期时股价没有越过你的卖出行权价，这笔钱就全部落袋。Credit Spread 同时利用了期权的两大结构性优势：作为卖方，由于 IV 长期虚高于 RV，胜率天然占优；同时长腿提供了保护，最大亏损在建仓时就被锁定，不会出现「裸卖」那种单次爆仓的风险。',
        whyItMatters: '高胜率策略。盈利不依赖股价大涨，只要不跌破/涨破某个点位即可。靠 Theta 衰减与 Vega 回落获利。'
    },
    {
        id: 'kelly',
        term: 'Kelly Criterion - 凯利公式',
        category: 'Strategy',
        icon: Percent,
        formula: 'f* = (p(b+1) - 1) ÷ b',
        explanation: '这是赌博理论与资金管理中的圣杯公式，由香农的同事 John Kelly 提出。它回答了一个终极问题：\n「假设我知道这局赌博胜率 60%、赔率 1:1，每一把该下注多少本金，才能让财富长期增长最快、同时永远不破产？」\n\n答案既不是 100%，也不是 1%。凯利公式给出一个精确的数学最优解：超过这个比例（Over-betting），长期收益反而下降甚至归零；低于这个比例，资金利用率不足。\n\n在期权交易里，胜率 p 永远是估算值，所以专业交易员通常采用 Half-Kelly（半凯利）甚至 Quarter-Kelly（1/4 凯利）来决定仓位，给自己留足安全边际。本平台默认使用 0.25 Kelly。',
        whyItMatters: '很多交易员死于重仓。凯利的核心警告是：哪怕胜率 99%，只要这一把梭哈，破产概率仍然是 100%。用 Half-Kelly 控制风险才是长期之道。'
    },

    // --- ACTIVE F1 ADOPTED STRATEGIES (2026-04-23) ---
    {
        id: 'bcd-qqq-wide',
        term: 'BCD QQQ wide (F1 采纳 · $2K 级)',
        category: 'Strategy',
        icon: Trophy,
        formula: 'Long δ 0.50 - Short δ 0.20 @ DTE 30-60 · PT 50% · 每 10 交易日',
        explanation: '✅ **当前活跃策略 #1**（2026-04-23 封存通过 6/6 采纳门槛，dsrM F0-effective N = 30，+0.065）。\n\n这是一种结构化的 Bull Call Debit Spread（看涨借方价差）在 QQQ 上的应用：买入一张接近平值的 Long Call（δ ≈ 0.50），同时卖出一张更虚值的 Short Call（δ ≈ 0.20）来抵消部分权利金，两腿到期日相同、DTE 落在 30–60 天。建仓时的净支出 (net debit) 就是最大亏损；当价差 P&L 达到 +50% 时止盈平仓。\n\n**为什么选 Debit 而不是 Credit？** 在 2024–2026 的 QQQ 牛市窗口里，盈利封顶的 Credit Spread（例如 DTE5 Bull Put）系统性输给「一直做多 SPY」这个最简单的对照基准（holdoutSpyIR −0.76）。BCD 则反过来吃下方向性溢价——Long Call 腿在方向对时能贡献 2–3 倍的回报，Short Call 仅起到成本补贴的作用，并不封住上行。\n\n**入场规则的精妙之处**：不使用 EMA34 / EMA55 等技术信号门控（F0 的零假设检验证明这些指标无法贡献 alpha），而是采用「每 10 个交易日 + maxPositions = 1」的简单节奏——上一笔平仓后 10 个交易日才触发下一笔入场。这是在 5 日节奏（过度交易，holdoutSpyIR −0.19）与 20 日节奏（样本不足，dsrM 不通过）之间找到的平衡点。\n\n**资金门槛**：$2K 起步。每手净支出约 $400–600（取决于 QQQ 现价），maxPositions = 1 意味着同一时刻最多只持有一手。\n\n**历史回测**：oosSharpe 0.97 / holdoutSharpe 1.22 / holdoutSpyIR +0.40。封存档案：`docs/holdout-evaluations/2026-04-23-25880326cfe1.md`。',
        whyItMatters: 'F1 双活跃策略之一，小资金账户的主力。在 Signals 页面点击 "Open BCD Position →" 按钮，由 `BCDEntryModal` 手动触发入场。'
    },
    {
        id: 'pmcc-qqq-pt60',
        term: 'PMCC QQQ pt60 (F1 采纳 · $10K+ 级)',
        category: 'Strategy',
        icon: Trophy,
        formula: 'Long LEAP δ 0.70-0.80 @ DTE 240-300 + Short monthly δ 0.20-0.30 @ DTE 30-45 · Long PT 60%',
        explanation: '✅ **当前活跃策略 #2**（2026-04-23 封存通过 6/6 采纳门槛，dsrM F0-effective N = 25，+0.845——极宽裕的安全边际）。\n\nPMCC (Poor Man\'s Covered Call) 是 Diagonal Spread 的一种，模拟传统的「持有 100 股正股 + 每月卖一张 Call」(Covered Call)，但用一张深度实值的 LEAP Call 替代 100 股正股，资金门槛大幅降低。\n\n**结构**：\n1. Long LEAP Call（δ 0.70–0.80，DTE 240–300 天）——长期「持股替代物」，占整笔头寸的绝大部分资金（约 $8K–$12K / 张）。\n2. Short Monthly Call（δ 0.20–0.30，DTE 30–45 天）——在 LEAP 上方卖出一张虚值 Call，每月收取权利金。\n\n**管理规则**：\n- **Long PT +60%**：LEAP 盈利 60% 时整体平仓。\n- **Short PT +50%**：短腿盈利 50% 时单独平短腿。\n- **Roll 触发**：当 QQQ 现价逼近短腿行权价（距离 ≤ 2%）时，把短腿向上 / 向后滚动。\n- **Long SL −35%**：LEAP 亏损 35% 时整体止损。\n\n**为什么是 pt60 而不是 pt50？** F0 零假设检验比较了 50% / 60% / 70% 三种长腿止盈：在 2024–2026 窗口里，60% 的 holdoutSpyIR 最佳 (+0.15)，dsrM 余量最大。pt50 略偏早止盈、pt70 容易让利润回吐。\n\n**资金门槛**：$10K 起步，适合有稳定现金流的账户作为核心持仓。\n\n**与 BCD 的互补性**：PMCC 是「always-in」——只要空仓就入场，不等信号；BCD 是「每 10 日节奏」——离散触发。两者资金等级、节奏、方向敞口都不同，可以并行持有；平台 Dashboard 会显示两个独立的 P&L 面板。\n\n**历史回测**：oosSharpe 1.72 / holdoutSharpe 1.63 / holdoutSpyIR +0.15。封存档案：`docs/holdout-evaluations/2026-04-23-7e9c2026f3df.md`。',
        whyItMatters: 'F1 双活跃策略之一，大资金账户的核心持仓。在 Signals 页面点击 "Open PMCC Position →" 按钮，由 `PMCCEntryModal`（长短两腿独立选择到期日）手动触发入场。'
    },
    {
        id: 'dsr-mertens',
        term: 'Deflated Sharpe Ratio (Mertens) - 多重检验惩罚',
        category: 'Metric',
        icon: FlaskConical,
        formula: 'dsrM = Sharpe − SE × E[max(N standard normals)]',
        explanation: '在同一个数据集上测试 100 个策略，哪怕全都没有 alpha，你也会看到一些「看起来很惊艳」的假阳性——这就是多重检验偏差 (Multiple Testing Bias)。Deflated Sharpe Ratio (dsrM) 是 Bailey & López de Prado 提出的数学校正：从观测到的 Sharpe 中扣掉「在纯噪声里采 N 次，最大 Sharpe 的期望值」。\n\n**直觉**：\n- N = 1（只测一次）：没有多重检验惩罚，dsrM = Sharpe。\n- N = 100（测了 100 种配置）：大约要扣 2.5 × SE ≈ 1.0 个 Sharpe 单位，才能确信不是噪声。\n- N = 1000：惩罚更重。\n\n**Phase F0 clean-slate 的意义**：2026-04-23 之前的 106 次尝试 (pre-F0) 被标记为「历史证据」，不再计入 dsrM 的 N。F0 边界之后重新计数 (F0-effective N)，给新策略一个干净的起点。这是一次性声明，下一次重置要等到 2026-10。\n\n**在 6 / 6 采纳门槛中的角色**：dsrM > 0 是六大门槛之一（另外五个：holdoutSpyIR ≥ 0、holdoutSharpe ≥ 0.3、oosSharpe ≥ 0.8、passesStability、passesStatConsistency）。BCD 与 PMCC 分别在 F0-effective N = 30 与 25 的条件下通过了这道关卡。',
        whyItMatters: '防止你把噪声当成 alpha。每跑一次 runner 都会消耗一次尝试次数（写入 attempts-global.json），所以策略探索必须「想清楚再跑」。'
    },

    // --- CREDIT SPREAD STRATEGY ---
    {
        id: 'spread-width',
        term: 'Spread Width - 价差宽度',
        category: 'Strategy',
        icon: Layers,
        formula: 'Width = |Short Strike - Long Strike|',
        explanation: '价差宽度决定了风险 / 收益比例与资金效率。以 Bull Put Spread 为例：\n\n- $5 宽：每手最大风险 $500，权利金约 $50–80。资金需求小，每手利润也小。\n- $10 宽：每手最大风险 $1,000，权利金约 $100–160。中等规模，适合短线策略。\n- $15 宽：每手最大风险 $1,500，权利金约 $150–250。WFA 验证显示资金利用率约 64%，线性扩展效果最佳。\n\n核心洞察：宽度越大，权利金近乎线性增长，但胜率基本不变（因为卖出腿相同）。所以在资金允许的前提下，适当加宽可以放大绝对收益，而不会显著增加亏损概率。\n\n本平台的验证结论：Swing 用 $15 宽度，Short-Term 用 $10 宽度。',
        whyItMatters: 'WFA 验证：Swing 最优宽度 $15（资金利用率 64%），Short-Term 最优 $10。宽度直接决定了每手的绝对收益与风险。'
    },
    {
        id: 'dte-sweet-spot',
        term: 'DTE Sweet Spot - 最佳到期窗口',
        category: 'Strategy',
        icon: Target,
        formula: 'Swing: 45-65 DTE | Short-Term: 7-21 DTE',
        explanation: 'DTE (Days To Expiration) 的选择是 Credit Spread 策略的核心参数之一。\n\n**45–65 DTE（Swing）**：Theta 衰减曲线的「甜蜜区」。时间价值的衰减开始明显加速，同时还有足够的余地让不利走势自我修复。过早入场（> 70 DTE），Theta 衰减太慢，资金占用时间过长；过晚入场（< 30 DTE），Gamma 风险急剧上升，股价的小幅波动就能吃掉全部利润。\n\n**7–21 DTE（Short-Term / 130M）**：短线策略利用的是 Theta 的「末日加速」效应——最后 2–3 周时间价值呈指数级衰减。配合 130M（每天 3 根 K 线）的信号系统，可以精确捕捉短期趋势。但风险也更高，Gamma 在这一阶段非常敏感，需要更严格的信号过滤。\n\nWFA 研究覆盖了 648 种配置，确认上述两个窗口最优。',
        whyItMatters: 'Theta 衰减在 45–65 天开始加速（Swing），7–21 天达到峰值（Short-Term）。偏离这两个窗口会显著降低策略效率。'
    },
    {
        id: 'take-profit',
        term: 'Take Profit Rules - 止盈规则',
        category: 'Strategy',
        icon: Trophy,
        formula: 'Swing: 30% of max profit | Short-Term: 50% of max profit',
        explanation: '为什么不等到 100% 利润？因为 Theta 衰减存在明显的边际递减。\n\n假设你卖出一个 Credit Spread，收到 $1.50 权利金（最大利润）。前 2–3 周，价差可能已经从 $1.50 缩到 $1.05（即 30% 利润）。但要把剩下的 $1.05 也吃到嘴里，往往需要再等 3–4 周，并承担股价反转的全部风险。\n\n数学上，前 30% 的利润大约在 40% 的持仓时间内完成；最后 30% 的利润却要占用 60% 的时间。这就是「边际递减」。\n\n- Swing 30%：较早止盈，释放资金给下一笔交易，提高周转率。WFA 验证略优于 50%。\n- Short-Term 50%：短线到期快、Theta 加速更猛，可以贪心一点。WFA 验证 50% 优于 30%。\n\n关键纪律：止盈后不要回头看。如果你经常想「早知道不止盈了」，恰恰说明止盈规则正在保护你——大脑只记得那些继续上涨的案例，却选择性遗忘了止盈后反转的情况。',
        whyItMatters: 'WFA 验证：Swing 在 30% 止盈效率最高，Short-Term 在 50%。Theta 衰减的边际递减使得早止盈反而能放大资金周转。'
    },
    {
        id: 'time-stop',
        term: 'Time Stop - 时间止损',
        category: 'Risk',
        icon: Timer,
        formula: 'Swing: DTE ≤ 3 close | Short-Term: DTE ≤ 1 close',
        explanation: '为什么必须设时间止损？因为越接近到期，Gamma 风险呈指数级膨胀。\n\n到期前 3 天（Swing）或 1 天（Short-Term），即使你的价差还在赚钱也要主动平仓。原因有三：\n\n1. **Gamma 爆炸**：股价的微小波动就能让你从盈利瞬间转为最大亏损——结局完全交给到期日收盘价，而不再取决于你的分析。\n2. **Pin Risk**：如果股价恰好「钉」在卖出行权价附近，你可能面临被行权的风险，还要处理底层正股头寸。\n3. **流动性枯竭**：临近到期的期权买卖价差显著扩大，平仓成本上升。\n\n时间止损是一条铁律：不论盈亏，到 DTE 阈值就平仓。这不是「认输」，而是专业的风险管理。',
        whyItMatters: 'Gamma 临近到期呈指数级增长。DTE ≤ 3（Swing）或 DTE ≤ 1（Short-Term）必须平仓，无论盈亏。'
    },
    {
        id: 'defined-risk',
        term: 'Defined Risk - 有限风险',
        category: 'Risk',
        icon: Lock,
        formula: 'Max Loss = (Width - Credit) × 100 × Contracts',
        explanation: 'Credit Spread 最优美的特性：最大亏损在建仓那一刻就已锁定，永远不会突破这个上限。\n\n原理是同时买入了一条保护腿（Long Leg）。不管标的股票暴跌 50% 还是 80%，你的亏损上限就是 (宽度 − 收到的权利金) × 100 × 手数。\n\n所以本策略不使用传统的价格止损 (Stop Loss)：\n1. WFA 在 7,000+ 组合上验证：设置 2× 止损反而摧毁收益（OOS Sharpe 从 1.3 跌到 0.04）。\n2. 原因：Credit Spread 的盈亏曲线高度非线性，到期前的中途波动远大于最终结果。中途触发止损，等于在那些本可以赢的交易上提前锁定亏损。\n3. 把风险预先定义好（Width × 手数），剩下的交给概率与大数定律。',
        whyItMatters: 'Credit Spread 的风险在建仓时已锁定。WFA 验证：2× 止损会摧毁收益（Sharpe 0.04）。不要再加止损，让事先定义好的有限风险自然运作。'
    },
    {
        id: 'iv-regime',
        term: 'IV Regime - 波动率环境',
        category: 'Concept',
        icon: BarChart2,
        formula: 'CREDIT: IV30/IV90 > 1.05 | DEBIT: < 0.95 | NEUTRAL: 0.95-1.05',
        explanation: '波动率不是一个静态数字，它有自己的「情绪周期」——我们称之为 IV Regime（波动率环境）。\n\n- **CREDIT Regime（卖方环境）**：IV 期限结构倒挂（IV30 > IV90，近期波动率高于远期），说明市场正在恐慌。此时卖出期权（Credit Spread）胜率极高——你在高位卖出了恐惧溢价，IV 均值回归会替你赚钱。\n- **DEBIT Regime（买方环境）**：IV 正向（IV30 < IV90），市场极度平静。期权便宜，买入 Call / Put 或 Debit Spread 的成本最低，一旦波动爆发，收益惊人。\n- **NEUTRAL**：市场正常，IV 期限结构平坦。Credit 与 Debit 都没有明显的结构性优势。\n\n系统会自动检测当前 IV Regime，只在 CREDIT Regime 下推荐 Credit Spread 策略。',
        whyItMatters: '只在 CREDIT Regime 下做 Credit Spread。IV 期限结构倒挂意味着市场恐慌，是卖期权胜率最高的时刻。'
    },
    {
        id: 'wfa',
        term: 'WFA (Walk-Forward Analysis)',
        category: 'Concept',
        icon: FlaskConical,
        explanation: 'Walk-Forward Analysis 是本平台验证策略参数的核心方法论，解决了回测中最致命的问题——过拟合。\n\n传统回测的陷阱：用 5 年数据找到「完美参数」（胜率 95%！），可那些参数只是完美拟合了历史噪声，对未来毫无预测力。\n\nWFA 的做法：\n1. 把历史数据切成 12 个滚动窗口（例如 6 个月训练 + 2 个月测试）。\n2. 在每个训练窗口里独立挑选最优参数。\n3. 把这些参数应用到对应的样本外测试窗口 (OOS = Out-of-Sample)。\n4. 汇总所有 OOS 窗口的综合表现。\n\n如果一个策略在 12 个独立的 OOS 测试里都能保持正收益，它的稳健性远高于传统单样本回测。\n\nWFA 历史结果：Swing 策略 OOS Sharpe 1.275、胜率 89.52%；Short-Term 130M 策略 OOS Sharpe 2.22、胜率 84.6%。这些数字基于 5,556+ 条 OOS 交易，覆盖 15 只股票、7–12 个独立时间窗口。',
        whyItMatters: 'WFA 防止过拟合。本平台的策略经过 5,556+ 条 OOS 交易的验证，不是单一区间的传统历史回测结果。'
    },
    {
        id: 'signal-system',
        term: 'Signal System (EMA/MOM/EM)',
        category: 'Concept',
        icon: Radio,
        formula: 'EMA = Trend Following | MOM = Momentum Burst | EM = Combined',
        explanation: '本平台的信号系统提供三种预设模式来判断入场时机：\n\n- **EMA（趋势跟踪）**：基于多层指数移动平均线 (EMA Stack) 的方向判断。短期 > 中期 > 长期 EMA 确认上升趋势 (BULL)，反之确认下降趋势 (BEAR)。优点：稳定可靠、假信号少；缺点：响应慢，容易错过快速反转。\n- **MOM（动量爆发）**：基于价格动量与市场偏差 (Market Bias) 的短期强度指标，捕捉「价格正在加速」的时刻。优点：响应快，抓得住急涨急跌；缺点：在震荡行情里假信号多。\n- **EM（EMA + Momentum 组合）**：把趋势方向 (EMA) 与动量强度 (MOM) 同时纳入，两者一致时才出信号。这是 Short-Term 130M 策略的默认模式，WFA 研究显示 EM 的泛化评级最高（Grade A），因为它同时过滤掉了趋势假信号与动量噪声。',
        whyItMatters: 'Swing 用 EMA 或 MOM，Short-Term 用 EM（Grade A 泛化评级）。信号决定入场时机，每种预设的最优适用场景都经过 WFA 验证。'
    },
    {
        id: 'max-drawdown',
        term: 'Max Drawdown - 最大回撤',
        category: 'Risk',
        icon: AlertTriangle,
        formula: 'Max DD = (Peak - Trough) ÷ Peak × 100%',
        explanation: '最大回撤衡量从资产净值最高点跌到最低点的最大幅度，它是风险管理中最重要的「生存指标」。\n\n为什么它比胜率更重要？因为回撤直接决定了心理与资金的双重生存空间：\n- 10% 回撤：需要 11% 的回报才能回本——可以接受。\n- 25% 回撤：需要 33% 的回报才能回本——开始痛苦。\n- 50% 回撤：需要 100% 的回报才能回本——几乎不可能。\n\n这正是本平台把最大回撤目标设在 15% 以内的原因（WFA 实际：Swing 4.64%、Short-Term 12.9%）。\n\n一个胜率 90% 但最大回撤 50% 的策略，远不如一个胜率 85% 但最大回撤 10% 的策略。前者只需一次极端事件就能毁掉账户，后者却能让你安心睡觉。',
        whyItMatters: '回撤 > 25% 几乎不可能恢复。本平台目标 Max DD < 15%（WFA 实际：Swing 4.64%、Short-Term 12.9%）。'
    },
    {
        id: 'winrate-vs-ev',
        term: 'Win Rate vs Expectancy',
        category: 'Concept',
        icon: Trophy,
        formula: 'Expectancy = (WR × Avg Win) - ((1-WR) × Avg Loss)',
        explanation: '在 Credit Spread 策略里，高胜率不是「虚荣指标」，而是策略的核心引擎。\n\n为什么高胜率对 Credit Spread 尤其关键：\n1. **心理稳定性**：85%+ 的胜率意味着每 20 笔交易只有 2–3 笔亏损。这种节奏让你有信心持续执行系统，不会因为连续亏损而中途放弃。\n2. **复利效应**：小额高频盈利比低频大额盈利更利于复利。每笔赚 $150（30% TP），20 笔里 17 笔赢 = +$2,550；3 笔输 $1,350（假设单笔 Max Loss $450）= 净利 +$1,200。\n3. **有界亏损**：Credit Spread 的最大亏损被 Width 锁死。即使那 15% 的失败交易触发 Max Loss，损失也是已知且有限的。这和低胜率策略（如 30% WR、大赢小亏）有本质差异——后者的连续亏损很容易击穿心理防线。\n\nExpectancy（期望值）把胜率与盈亏比同时纳入。本平台 WFA 验证：Swing Expectancy +$35/trade、Short-Term +$48/trade。',
        whyItMatters: '85%+ 的胜率不是虚荣指标。Credit Spread 的「有界亏损 + 高胜率」组合 = 稳定复利。WFA 验证期望值为正。'
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
        <div className="stagger-fade-in pb-20 sm:pb-10 font-sans max-w-5xl mx-auto">
            {/* Header section */}
            <div className="mb-6 sm:mb-10 text-center">
                <div className="inline-block p-3 bg-phosphor-green/10 rounded-md mb-3 sm:mb-4 border border-phosphor-green/30">
                    <BookOpen className="text-phosphor-green w-7 h-7 sm:w-8 sm:h-8" />
                </div>
                <h1 className="text-2xl sm:text-4xl font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green mb-2">▌ TRADING_ACADEMY</h1>
                <p className="text-text-tertiary text-xs sm:text-sm font-mono uppercase tracking-wider">CREDIT SPREAD CONCEPTS · RISK MANAGEMENT · WFA-VALIDATED RULES</p>
            </div>

            {/* Search and Filters */}
            <div className="flex flex-col gap-4 mb-8">
                <div className="relative">
                    <input
                        type="text"
                        placeholder="Search terms, formulas or concepts..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full bg-terminal-panel border border-phosphor-green/20 text-text-primary rounded-md pl-12 pr-4 py-3.5 sm:py-4 focus:outline-none focus:border-phosphor-green/60 transition-all font-mono text-sm sm:text-base"
                    />
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-phosphor-dim/70" size={20} />
                </div>
                <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
                    {categories.map(cat => {
                        // Phosphor collapse: Strategy/Concept → green, Greek/Metric → amber, Risk/Structure → red.
                        const isActive = selectedCategory === cat;
                        const family =
                            (cat === 'Strategy' || cat === 'Concept') ? 'green' :
                            (cat === 'Greek' || cat === 'Metric') ? 'amber' : 'red';
                        const activeCls =
                            family === 'green' ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/40' :
                            family === 'amber' ? 'bg-phosphor-amber/10 text-phosphor-amber text-glow-amber border border-phosphor-amber/40' :
                                                  'bg-phosphor-red/10 text-phosphor-red text-glow-red border border-phosphor-red/40';
                        return (
                            <button
                                key={cat}
                                onClick={() => setSelectedCategory(isActive ? null : cat)}
                                className={`px-3.5 sm:px-4 py-2 rounded-md text-xs font-mono uppercase tracking-wider border transition-all shrink-0 cursor-pointer ${isActive
                                    ? activeCls
                                    : 'bg-terminal-panel text-text-tertiary border-border-default/50 hover:text-phosphor-dim hover:border-phosphor-green/20'
                                    }`}
                            >
                                {cat}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Content Grid */}
            <div className="grid grid-cols-1 gap-6">
                {filteredGlossary.length > 0 ? (
                    filteredGlossary.map((item) => {
                        // Same phosphor collapse for category badges as the filter pills.
                        const family =
                            (item.category === 'Strategy' || item.category === 'Concept') ? 'green' :
                            (item.category === 'Greek' || item.category === 'Metric') ? 'amber' : 'red';
                        const badgeCls =
                            family === 'green' ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border-phosphor-green/30' :
                            family === 'amber' ? 'bg-phosphor-amber/10 text-phosphor-amber text-glow-amber border-phosphor-amber/30' :
                                                  'bg-phosphor-red/10 text-phosphor-red text-glow-red border-phosphor-red/30';
                        return (
                            <div
                                key={item.id}
                                className="terminal-panel p-6 hover:border-phosphor-green/40 transition-all group overflow-hidden relative"
                            >
                                {/* Decorative background icon */}
                                <item.icon className="absolute -right-4 -top-4 w-32 h-32 text-phosphor-green/5 group-hover:text-phosphor-green/10 transition-colors pointer-events-none" />

                                <div className="flex items-start gap-4 relative z-10">
                                    <div className="p-3 bg-phosphor-green/[0.04] rounded-md border border-phosphor-green/20 group-hover:bg-phosphor-green/10 group-hover:border-phosphor-green/40 transition-all">
                                        <item.icon className="w-6 h-6 text-phosphor-dim group-hover:text-phosphor-green group-hover:text-glow-green transition-colors" />
                                    </div>
                                    <div className="flex-1">
                                        <div className="flex flex-wrap items-center gap-3 mb-2">
                                            <h3 className="text-xl font-mono font-bold uppercase tracking-wider text-text-primary">{item.term}</h3>
                                            <span className={`text-[10px] uppercase font-mono font-bold tracking-wider px-2 py-0.5 rounded border ${badgeCls}`}>
                                                {item.category}
                                            </span>
                                        </div>

                                        <p className="text-text-tertiary leading-relaxed mb-4 text-[15px] font-sans">
                                            {item.explanation}
                                        </p>

                                        {item.formula && (
                                            <div className="bg-terminal-black rounded-md p-4 mb-4 border border-phosphor-green/20 font-mono text-sm group-hover:border-phosphor-green/40 transition-colors">
                                                <div className="label-mono mb-1">▌ FORMULA</div>
                                                <div className="text-phosphor-green text-glow-green font-bold text-base">{item.formula}</div>
                                            </div>
                                        )}

                                        <div className="flex items-start gap-2 bg-terminal-panel rounded-md p-4 border-l-4 border-phosphor-green">
                                            <Info size={18} className="text-phosphor-green text-glow-green shrink-0 mt-0.5" />
                                            <div>
                                                <div className="label-mono mb-1">▌ TRADING_EDGE</div>
                                                <div className="text-text-secondary text-sm italic font-sans">{item.whyItMatters}</div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })
                ) : (
                    <div className="terminal-panel text-center py-20 border-dashed">
                        <div className="mb-4 flex justify-center">
                            <AlertTriangle size={48} className="text-phosphor-amber" />
                        </div>
                        <h3 className="text-xl font-mono font-bold text-phosphor-amber text-glow-amber uppercase tracking-widest mb-1">▌ NO_MATCHES</h3>
                        <p className="text-text-tertiary font-mono text-xs uppercase tracking-wider">Try different keywords or clear your filters.</p>
                        <button
                            onClick={() => { setSearchQuery(''); setSelectedCategory(null); }}
                            className="mt-6 btn-terminal"
                        >
                            ▌ CLEAR FILTERS
                        </button>
                    </div>
                )}
            </div>

            {/* Footer Tip */}
            <div className="mt-12 text-center text-text-tertiary text-[11px] font-mono uppercase tracking-wider">
                <p>▌ Data updates every 15 minutes. Happy trading.</p>
            </div>
        </div>
    );
};
