import React, { useState } from 'react';
import { BookOpen, Search, Info, Brain, Zap, Clock, Shield, BarChart2, TrendingUp, AlertTriangle, Layers, Percent, Divide, Activity } from 'lucide-react';

interface GlossaryItem {
    id: string;
    term: string;
    category: 'Metric' | 'Concept' | 'Structure' | 'Greek' | 'Strategy' | 'Risk';
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
        explanation: '这是平台的核心综合评分。它不是单一的指标，而是一套“混合加权算法”，自动根据你选择的策略（买入或卖出）转换逻辑，综合平衡杠杆、风险、成本和概率。',
        whyItMatters: '让你一眼看出这个期权合约在当前市场环境下是否“值得一做”。100分意味着在所有维度上都达到了最佳平衡点。'
    },
    {
        id: 'lambda',
        term: 'Lambda (Λ) - 真杠杆率',
        category: 'Metric',
        icon: Zap,
        formula: 'Lambda = |Delta| × (Stock Price ÷ Option Price)',
        explanation: '它反映了你的期权头寸“以小博大”的能力。例如 Lambda 为 10，意味着标的股票波动 1%，你的期权头寸大概会波动 10%。',
        whyItMatters: '高 Lambda 意味着资金效率极高，但也意味着价格波动极剧烈。买家通常寻找高 Lambda (8-15) 以获取爆发力。'
    },
    {
        id: 'gamma-eff',
        term: 'Gamma Efficiency - 爆发效率',
        category: 'Metric',
        icon: TrendingUp,
        formula: 'Γeff = Gamma ÷ Option Price',
        explanation: 'Delta 告诉我们现在能赚多少，Gamma 告诉我们随着股价继续涨，利润加速的速度。Gamma Efficiency 衡量的是每一美金成本能带来的这种“加速潜力”。',
        whyItMatters: '对于寻找快速翻倍机会的交易者来说，这是寻找“快马”的核心指标。'
    },
    {
        id: 'theta-burn',
        term: 'Theta Burn - 时间损耗率',
        category: 'Metric',
        icon: Clock,
        formula: 'TB = |Theta| ÷ Option Price',
        explanation: '期权每一天都会流失价值。Theta Burn 告诉你每天损耗的价格占你总成本的比例。',
        whyItMatters: '如果你是买家，TB 高于 5% 意味着你每天在亏掉 5% 的本金，必须尽快平仓。如果你是卖家，TB 是你的利润来源。'
    },
    {
        id: 'iv-rv',
        term: 'IV / RV Ratio - 波动率风险溢价',
        category: 'Metric',
        icon: Shield,
        formula: 'Ratio = Implied Volatility (IV) ÷ Realized Volatility (RV)',
        explanation: '隐含波动率(IV)是市场对未来的“恐惧度”，实际波动率(RV)是过去30天的“真实波幅”。',
        whyItMatters: 'Ratio > 1.25 说明期权被恐惧情绪推高，适合卖出（做空波动率）。Ratio < 1.0 说明期权便宜，适合买入（做多波动率）。'
    },
    {
        id: 'pop',
        term: 'POP (Probability of Profit)',
        category: 'Metric',
        icon: Shield,
        formula: 'POP ≈ 1 - |Delta| (for OTM options)',
        explanation: '赚钱的概率。如果一个看跌期权的 Delta 是 -0.20，意味着它到期变废纸的概率约 80%，如果你是卖出它，你的胜率就是 80%。',
        whyItMatters: '核心胜率指标。卖家追求高 POP (>65%)，买家则在牺牲 POP 换取高 Lambda（以小博大）。'
    },
    {
        id: 'seller-edge',
        term: 'Seller\'s Edge - 期望值 (EV)',
        category: 'Metric',
        icon: Brain,
        formula: 'EV = (POP × Credit) - ((1-POP) × Max Loss)',
        explanation: '综合胜率和收益，算出你每做一笔交易理论上能赚多少钱。',
        whyItMatters: '职业玩家的标尺。只要 EV 为正，长期重复交易必胜。'
    },

    // --- GREEKS ---
    {
        id: 'delta',
        term: 'Delta (Δ) - 方向敏感度',
        category: 'Greek',
        icon: Activity,
        formula: 'Δ = ∂Price / ∂Underlying',
        explanation: '衡量期权价格对股票价格变动的敏感度。它也是期权到期即实值 (ITM) 的近似概率。',
        whyItMatters: 'Delta 就是你的持仓股数。Delta 0.50 意味着你的风险敞口相当于持有 50 股正股。'
    },
    {
        id: 'gamma',
        term: 'Gamma (Γ) - 加速度',
        category: 'Greek',
        icon: Zap,
        formula: 'Γ = ∂Delta / ∂Underlying',
        explanation: '衡量 Delta 变化的快慢。Gamma 越高，Delta 变化越快，盈亏波动越剧烈。',
        whyItMatters: 'Gamma 是卖家的敌人（因为一旦出错亏损会加速扩大），是买家的朋友（因为做对了利润会加速增长）。'
    },
    {
        id: 'theta',
        term: 'Theta (Θ) - 时间衰减',
        category: 'Greek',
        icon: Clock,
        formula: 'Θ = ∂Price / ∂Time',
        explanation: '期权每过一天损失的价值。通常是负数。',
        whyItMatters: '时间是期权买家的敌人，卖家的朋友。最后 30 天的时间衰减会呈指数级加速。'
    },
    {
        id: 'vega',
        term: 'Vega (ν) - 波动率敏感度',
        category: 'Greek',
        icon: BarChart2,
        formula: 'ν = ∂Price / ∂Volatility',
        explanation: '衡量期权价格对隐含波动率 (IV) 变化的敏感度。',
        whyItMatters: '如果 Vega 是 0.10，意味着 IV 每涨 1%，期权价格涨 $0.10。长久期期权 Vega 最大。'
    },

    // --- CONCEPTS ---
    {
        id: 'iv-rank',
        term: 'IV Rank - 波动率排位',
        category: 'Metric',
        icon: BarChart2,
        formula: 'IV Rank = (Current IV - Low IV) ÷ (High IV - Low IV)',
        explanation: '告诉你当前的 IV 在过去一年中处于什么水平。IV 50% 对特斯拉算低，对可口可乐算高，IV Rank 标准化了这种差异。',
        whyItMatters: '卖方应该在 IV Rank 高 (>50) 时入场，买方应该在 IV Rank 低 (<20) 时入场。'
    },
    {
        id: 'skew',
        term: 'Volatility Skew - 波动率偏度',
        category: 'Metric',
        icon: Divide,
        formula: 'Skew = IV(Put) - IV(Call)',
        explanation: '衡量虚值 Put 和虚值 Call 的贵贱差异。通常 Put 更贵（Smirk），因为市场更害怕暴跌。',
        whyItMatters: '顺势而为。如果 Skew 很高，说明 Put 极贵，此时构建 Bull Put Spread (卖Put) 胜率和赔率更佳。'
    },
    {
        id: 'backwardation',
        term: 'Backwardation (倒挂)',
        category: 'Structure',
        icon: AlertTriangle,
        explanation: '一种异常的市场状态，短期 IV 显著高于长期 IV (IV Ratio > 1.0)。这通常发生在暴跌或重大利空传闻时。',
        whyItMatters: '卖家的黄金期。短期期权由于恐慌被定价极高，时间损耗极快。'
    },
    {
        id: 'contango',
        term: 'Contango (正向)',
        category: 'Structure',
        icon: TrendingUp,
        explanation: '市场的常态。远期不确定性更大，比近期贵 (IV Ratio < 1.0)。',
        whyItMatters: '对买家友好。时间流逝在远端比较慢，适合中长线布局。'
    },

    // --- STRATEGIES ---
    {
        id: 'credit-spread',
        term: 'Credit Spread - 信用价差',
        category: 'Strategy',
        icon: Layers,
        formula: 'Profit = Credit Received',
        explanation: '卖出一个昂贵的期权，买入一个便宜的期权保护。你预先收到权利金 (Credit)。',
        whyItMatters: '高胜率策略。你的盈利不依赖股价大涨，只要股价“不跌破”或“不涨破”某个点位，你就能赢。利用时间 (Theta) 和波动率下降 (Vega) 获利。'
    },
    {
        id: 'debit-spread',
        term: 'Debit Spread - 借方价差',
        category: 'Strategy',
        icon: Layers,
        formula: 'Max Profit = Width - Debit',
        explanation: '买入一个昂贵的期权，卖出一个便宜的期权降低成本。你预先支付权利金 (Debit)。',
        whyItMatters: '比单纯买 Call/Put 更稳健。虽然限制了最大利润，但大幅降低了成本和盈亏平衡点，提高了胜率。'
    },
    {
        id: 'kelly',
        term: 'Kelly Criterion - 凯利公式',
        category: 'Strategy',
        icon: Percent,
        formula: 'f* = (p(b+1) - 1) ÷ b',
        explanation: '资金管理的圣杯。根据胜率 (p) 和赔率 (b) 计算出最佳仓位比例，以最大化长期复利增长。',
        whyItMatters: '很多交易员死于重仓。凯利公式告诉你：即使你有 99% 的胜率，如果在这一次梭哈，你最终破产的概率也是 100%。通常使用 "Half-Kelly" 来控制风险。'
    }
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
            <div className="mb-10 text-center">
                <div className="inline-block p-3 bg-accent-green/10 rounded-2xl mb-4 border border-accent-green/20">
                    <BookOpen className="text-accent-green w-8 h-8" />
                </div>
                <h1 className="text-4xl font-extrabold text-white mb-2 tracking-tight">Trading Academy</h1>
                <p className="text-gray-400 text-lg">Master the OSS algorithms and trade like a professional.</p>
            </div>

            {/* Search and Filters */}
            <div className="flex flex-col md:flex-row gap-4 mb-8">
                <div className="relative flex-1">
                    <input
                        type="text"
                        placeholder="Search for terms, formulas or concepts..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full bg-[#1C1C1E] border border-[#2A2A2A] text-white rounded-xl pl-12 pr-4 py-4 focus:outline-none focus:border-accent-green transition-all shadow-xl"
                    />
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" size={20} />
                </div>
                <div className="flex gap-2 flex-wrap">
                    {categories.map(cat => (
                        <button
                            key={cat}
                            onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
                            className={`px-4 py-2 rounded-xl text-sm font-bold border transition-all ${selectedCategory === cat
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
