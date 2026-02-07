import React, { useState } from 'react';
import { BookOpen, Search, Info, Brain, Zap, Clock, Shield, BarChart2, TrendingUp, AlertTriangle } from 'lucide-react';

interface GlossaryItem {
    id: string;
    term: string;
    category: 'Metric' | 'Concept' | 'Structure';
    explanation: string;
    formula?: string;
    whyItMatters: string;
    icon: any;
}

const GLOSSARY: GlossaryItem[] = [
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
        formula: 'Lambda = |Delta| × (股价 ÷ 期权价格)',
        explanation: '它反映了你的期权头寸“以小博大”的能力。例如 Lambda 为 10，意味着标的股票波动 1%，你的期权头寸大概会波动 10%。',
        whyItMatters: '高 Lambda 意味着资金效率极高，但也意味着价格波动极剧烈。买家通常寻找高 Lambda (8-15) 以获取爆发力。'
    },
    {
        id: 'gamma-eff',
        term: 'Gamma Efficiency - 爆发效率',
        category: 'Metric',
        icon: TrendingUp,
        formula: 'Γeff = Gamma ÷ 期权价格',
        explanation: 'Delta 告诉我们现在能赚多少，Gamma 告诉我们随着股价继续涨，利润加速的速度。Gamma Efficiency 衡量的是每一美金成本能带来的这种“加速潜力”。',
        whyItMatters: '对于寻找快速翻倍机会的交易者来说，这是寻找“快马”的核心指标。'
    },
    {
        id: 'theta-burn',
        term: 'Theta Burn - 时间损耗率',
        category: 'Metric',
        icon: Clock,
        formula: 'TB = |Theta| ÷ 期权价格',
        explanation: '期权每一天都会流失价值。Theta Burn 告诉你每天损耗的价格占你总成本的比例。',
        whyItMatters: '如果你是买家，TB 高于 5% 意味着你每天在亏掉 5% 的本金，必须尽快平仓。如果你是卖家，TB 是你的利润来源。'
    },
    {
        id: 'iv-rv',
        term: 'IV / RV Ratio - 波动率风险溢价',
        category: 'Metric',
        icon: Shield,
        formula: 'Ratio = 隐含波动率(IV) ÷ 20日实际波动率(RV)',
        explanation: '隐含波动率(IV)是市场对未来的“恐惧度”，实际波动率(RV)是过去20天的“真实波幅”。如果比率 > 1.25，说明市场过度恐慌，期权被卖贵了。',
        whyItMatters: '这是期权卖家（Sell Side）的生存之本。利用市场的虚高恐惧赚取多出来的保费。'
    },
    {
        id: 'iv-ratio',
        term: 'IV Ratio (30d/90d) - 时间结构',
        category: 'Structure',
        icon: BarChart2,
        formula: 'Ratio = 30天IV ÷ 90天IV',
        explanation: '比较短期风险和长期风险的差异。它可以判断当前的恐慌是暂时的尖峰，还是长期的看空。',
        whyItMatters: '帮助你决定买近期的还是远期的。如果近期极贵 (Ratio > 1.1)，适合卖出近期收保费。'
    },
    {
        id: 'backwardation',
        term: 'Backwardation (倒挂)',
        category: 'Concept',
        icon: AlertTriangle,
        explanation: '一种异常的市场状态，短期 IV 显著高于长期 IV (IV Ratio > 1.0)。这通常发生在暴跌或重大利空传闻时。',
        whyItMatters: '这是卖家的黄金期。短期期权由于恐慌被定价极高，时间损耗极快。'
    },
    {
        id: 'contango (正向市场)',
        term: 'Contango (正向)',
        category: 'Concept',
        icon: TrendingUp,
        explanation: '市场的常态。远期由于不确定性更大，比近期贵 (IV Ratio < 1.0)。',
        whyItMatters: '对买家友好。时间流逝在远端比较慢，可以进行中长线布局。'
    },
    {
        id: 'pop',
        term: 'POP (Probability of Profit)',
        category: 'Metric',
        icon: Shield,
        formula: 'POP ≈ 1 - |Delta|',
        explanation: '赚钱的概率。如果一个看跌期权的 Delta 是 -0.20，意味着它到期变废纸的概率约 80%，如果你是卖出它，你的胜率就是 80%。',
        whyItMatters: '核心胜率指标。卖家追求高 POP，买家则在牺牲 POP 换取高 Lambda（以小博大）。'
    },
    {
        id: 'seller-edge',
        term: 'Seller\'s Edge - 期望值',
        category: 'Metric',
        icon: Brain,
        formula: 'Expected Value = POP × 权利金 - (1-POP) × 最大损失',
        explanation: '综合胜率和收益，算出你每做一比交易理论上能赚多少钱。',
        whyItMatters: '职业玩家的标尺。只要 Edge 为正，长期重复交易必胜。'
    },
    {
        id: 'theta-pain',
        term: 'Theta Pain Curve - 惩罚机制',
        category: 'Concept',
        icon: AlertTriangle,
        explanation: '算法内部的一个调节器。当期权距离到期太近（如 3-5 天），时间损耗会呈指数级加速，此时算法会给出巨额减分。',
        whyItMatters: '防止新手因为便宜而购买末日期权，这些期权看似便宜实则每天损耗巨大。'
    }
];

export const Academy: React.FC = () => {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

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
                <div className="flex gap-2">
                    {['Metric', 'Concept', 'Structure'].map(cat => (
                        <button
                            key={cat}
                            onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
                            className={`px-6 py-2 rounded-xl text-sm font-bold border transition-all ${selectedCategory === cat
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
                                        <div className="bg-black/40 rounded-xl p-4 mb-4 border border-white/5 font-mono text-sm">
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
