import React, { useState } from 'react';
import { BookOpen, Search, Info, Brain, Zap, Clock, Shield, BarChart2, TrendingUp, AlertTriangle, Layers, Percent, Divide, Activity } from 'lucide-react';

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
        id: 'lambda',
        term: 'Lambda (Λ) - 真杠杆率',
        category: 'Metric',
        icon: Zap,
        formula: 'Lambda = |Delta| × (Stock Price ÷ Option Price)',
        explanation: '很多人误以为期权的杠杆就是“便宜”。错！真正的杠杆率是 Lambda。它精确描述了你的期权价格相对于正股价格的“弹性”。\n\n想象一下：如果 Lambda 是 15，意味着当标的股票上涨 1% 时，你的期权价格理论上会上涨 15%。这是期权作为“财富放大器”的数学本质。\n\n但是，杠杆是把双刃剑。Lambda 越高，意味着你离实值 (ITM) 越远，或者是期权越快到期。高 Lambda 通常伴随着低胜率（OTM）或高时间损耗（Theta Burn）。专业的买方策略（Debit Buyer）通常寻找 Lambda 在 8-15 之间的“甜蜜点”——既有足够的爆发力，又不会因为太虚值而变成废纸。',
        whyItMatters: '高 Lambda 意味着资金效率极高，但也意味着价格波动极剧烈。买家通常寻找高 Lambda (8-15) 以获取爆发力。'
    },
    {
        id: 'gamma-eff',
        term: 'Gamma Efficiency - 爆发效率',
        category: 'Metric',
        icon: TrendingUp,
        formula: 'Γeff = Gamma ÷ Option Price',
        explanation: '如果你是买方，你不仅希望方向做对，还希望利润能“指数级爆炸”。Gamma 就是这个爆炸的引信。\n\nDelta 决定了你现在赚多少，而 Gamma 决定了你“越赚越快”的能力。Gamma Efficiency (Γeff) 是从成本角度考量这个能力：你每投入 $1 的权利金，能买到多少“爆炸潜力”？\n\n比如说，两张 Call 都有同样的 Delta，但一张极其便宜且 Gamma 很高（通常是短期的 OTM），它的 Γeff 就会非常高。一旦正股发生剧烈运动，这就好比你用自行车的价格买了一辆法拉利的加速度。这通常是“末日轮”或“财报赌博”选筹的核心指标。',
        whyItMatters: '对于寻找快速翻倍机会的交易者来说，这是寻找“快马”的核心指标。'
    },
    {
        id: 'theta-burn',
        term: 'Theta Burn - 时间损耗率',
        category: 'Metric',
        icon: Clock,
        formula: 'TB = |Theta| ÷ Option Price',
        explanation: '这是期权买家的“止血带”指标。Theta (时间价值损耗) 是一个绝对数值，比如 -$0.05，意味着每天掉 5 美分。但这对不同价格的期权意义完全不同。\n\n对于一个价值 $5.00 的期权，掉 5 分钱无关痛痒（1%）；但对于一个价值 $0.10 的期权，掉 5 分钱意味着你一天就亏掉了 50% 的本金！\n\nTheta Burn 就是把这个损耗标准化为百分比。它告诉你：如果股价明天横盘不动，你的账户净值会缩水百分之几。如果 TB > 5%，你的头寸就像一块放在烈日下的冰块，必须速战速决。',
        whyItMatters: '如果你是买家，TB 高于 5% 意味着你每天在亏掉 5% 的本金，必须尽快平仓。如果你是卖家，TB 是你的利润来源。'
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
        id: 'debit-spread',
        term: 'Debit Spread - 借方价差',
        category: 'Strategy',
        icon: Layers,
        formula: 'Max Profit = Width - Debit',
        explanation: '这是单腿买入 (Long Call/Put) 的进化版。买期权最大的痛点是什么？太贵以至于 Theta 损耗太快。\n\nDebit Spread 通过“卖出一个更虚值的期权”来回血，抵消掉一部分成本。虽然这限制了你的最大潜在利润（因为卖出的那一腿封顶了收益），但它有两个巨大的好处：\n1. 极大降低了成本（Debit），从而提高了杠杆。\n2. 极大降低了盈亏平衡点（Breakeven）。\n\n相比于单纯买 Call 彩票，Debit Spread 是一种更理性的、带有方向性判断的投机策略。',
        whyItMatters: '比单纯买 Call/Put 更稳健。虽然限制了最大利润，但大幅降低了成本和盈亏平衡点，提高了胜率。'
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

];

export const Academy: React.FC = () => {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

    const categories = ['Metric', 'Greek', 'Strategy', 'Concept', 'Structure'];

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
                <p className="text-gray-400 text-sm sm:text-lg">Master the OSS algorithms and trade like a professional.</p>
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
