# 📊 Trading Journal - Options Trading Platform

> 专业期权交易日志与策略推荐系统  
> **数据源**: ORATS（期权）+ Tiingo（股价）/ CBOE（备）

---

## ✨ 核心功能

### 🎯 智能策略推荐
- **IV Regime Detection**: 基于 IV Term Structure 自动判断 CREDIT/DEBIT/NEUTRAL 模式
- **完整 IV 曲线**: IV7/14/30/60/90/120 全覆盖
- **异常检测**: 自动识别 Earnings Spike
- **多策略支持**: Credit Spreads, Debit Spreads, Long Options

### 📈 OSS 期权扫描器 (v2.3)
- **真实 Greeks**: 交易所级 Delta/Gamma/Theta/Vega
- **精准评分**: Lambda 压缩 + Z-Score 标准化
- **智能过滤**: DTE 分桶 + 流动性筛选
- **实时报价**: 无延迟的 Bid/Ask/Last

### 💼 持仓管理
- **实时 P&L**: 自动刷新持仓价格
- **Greeks 面板**: 完整的风险指标
- **止损/目标价**: Discord 自动提醒
- **交易历史**: 完整的交易记录

### 📊 数据可视化
- **Greeks 历史图表**: 追踪 Delta/Gamma/Theta 变化
- **IV 曲线**: 可视化 IV Term Structure
- **统计分析**: 胜率、平均收益、夏普比率

---

## 🚀 技术栈

### 前端
- **React 18** + **TypeScript** - 类型安全的组件化开发
- **React Router v6** - 客户端路由，每页独立 URL，懒加载
- **React Query v5** (TanStack Query) - 数据缓存、自动失效、mutation 管理
- **Vite 5** - 极速开发服务器
- **Tailwind CSS** - 现代化 UI 设计
- **Recharts** - 数据可视化

### 后端
- **Vercel Serverless Functions** - 无服务器 API
- **Supabase** - PostgreSQL 数据库 + 实时订阅
- **ORATS** - 实时期权数据 + Greeks + IV + 核心分析（主数据源）
- **Tiingo** - 股价历史 + 分红调整（30+ 年免费数据）
- **CBOE API** - 备用数据源（15 分钟延迟，免费）

### 测试与 CI
- **Vitest** - 1213 项自动化测试（评分对等 + 单元 + 风控 + BSM + 回测 + F0 boundary + 交易结果）
- **GitHub Actions** - CI 流水线（lint → build → test）
- **ESLint 9** - 代码质量检查

### 核心算法
- **OSS v2.8** - Options Scoring System
- **IV Term Structure** - 完整波动率曲线构建
- **Regime Detection** - 智能市场环境判断
- **Skew Calculation** - 25-delta Put/Call Skew

---

## 📦 快速开始

### 1. 克隆项目
```bash
git clone https://github.com/yourusername/trading-journal.git
cd trading-journal
```

### 2. 安装依赖
```bash
npm install
```

### 3. 环境变量配置
创建 `.env.local` 文件：
```bash
# Supabase
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key

# 期权数据源（不设置时默认 CBOE；推荐 ORATS 获取实时 Greeks）
DATA_SOURCE=ORATS
ORATS_API_TOKEN=your_orats_api_token
TIINGO_API_TOKEN=your_tiingo_api_token

# Discord 提醒 (可选)
DISCORD_WEBHOOK_URL=your_discord_webhook_url
CRON_SECRET=your_cron_secret
```

### 4. 启动开发服务器
```bash
npm run dev
```

访问 `http://localhost:5173`

### 5. 部署到 Vercel
```bash
# 安装 Vercel CLI
npm i -g vercel

# 部署
vercel --prod
```

---

## 📚 文档

### 核心文档
- [项目概览](docs/01_项目概览.md) - 项目背景和目标
- [技术路径](docs/02_技术路径.md) - 技术架构详解
- [核心算法](docs/03_核心算法.md) - OSS 评分算法
- [数据库设计](docs/04_数据库设计.md) - 数据模型
- [API 文档](docs/05_API文档.md) - API 端点说明

### 数据源与文档
- [文档中心](docs/README.md) - 全部技术文档（架构、API、部署见 [02_技术路径](docs/02_技术路径.md)、[05_API文档](docs/05_API文档.md)）

---

## 🎯 数据源（ORATS + Tiingo）

| 指标 | CBOE（备） | ORATS（主） | Tiingo |
|------|------------|-------------|--------|
| **Greeks 精度** | 全为 0 | 完整 (Delta/Gamma/Theta/Vega) | N/A |
| **价格延迟** | 15 分钟 | 近实时 | 日终 |
| **IV 数据** | 不完整 | 完整曲线 + IV Rank + 历史 | N/A |
| **核心分析** | 无 | RV30, 隐含波动, 财报, 看跌/看涨比 | N/A |
| **股价历史** | 无 | 无 | 30+ 年 (分红调整) |
| **请求优化** | 全链 | DTE/行权过滤 + 1 分钟缓存 | 增量缓存 |

配置 `DATA_SOURCE=ORATS`、`ORATS_API_TOKEN`、`TIINGO_API_TOKEN` 即可启用。

---

## 🧪 测试

### 自动化测试（1213 项）
```bash
npm run test        # 运行全部测试
npm run test:watch  # 开发时实时监听
```

| 测试套件 | 测试数 | 覆盖内容 |
|---------|--------|---------|
| `tests/scoring-parity.test.ts` | 174 | 前端 (oss-core.ts) 与 API (scoring.cjs) 输出一致性 |
| `src/lib/__tests__/oss-core.test.ts` | 48 | 评分函数已知 input→output 回归 |
| `src/lib/__tests__/riskSizing.test.ts` | 19 | 持仓定寸、Kelly、集中度预警 |

### CI/CD
每次 push/PR 自动运行 GitHub Actions：`lint → build → test`

### 本地 API 测试
```bash
vercel dev   # 使用真实 API 文件
```

---

## 📊 项目结构

```
trading-journal/
├── .github/workflows/ci.yml  # GitHub Actions CI
├── api/                       # Vercel Serverless Functions
│   ├── _shared/
│   │   └── scoring.cjs       # 共享评分逻辑（与 oss-core.ts 镜像）
│   ├── strategy-recommend.js  # 策略推荐
│   ├── scan-options.js        # 期权扫描器
│   ├── option-prices.js       # 单/多合约报价（option-price 为 rewrite 目标）
│   ├── check-alerts.js        # 止损/目标价提醒（BCD/PMCC 自动跳过 DTE5 SL 规则）
│   └── daily-recap.js         # 每日汇总
├── src/
│   ├── components/            # React 组件
│   │   └── strategy/          # 策略推荐子组件
│   ├── context/               # React Context (Auth, BuyModal)
│   ├── hooks/                 # React Query hooks (数据获取 + mutations)
│   ├── layouts/               # AppLayout (Shell)
│   ├── pages/                 # 页面组件（懒加载，自治）
│   ├── lib/
│   │   ├── oss-core.ts       # OSS 评分算法（单点事实）
│   │   ├── scoring.ts        # 批量评分，re-export oss-core
│   │   ├── riskSizing.ts     # 风控定寸 + Kelly + 集中度
│   │   ├── queryClient.ts    # React Query 客户端
│   │   ├── queryKeys.ts      # 缓存 key 工厂
│   │   └── supabase.ts       # Supabase 客户端
│   ├── router.tsx             # React Router 路由配置
│   └── main.tsx               # 应用入口（Provider 组合）
├── tests/                     # 对等测试
├── docs/                      # 文档
├── eslint.config.js           # ESLint 9 flat config
└── vite.config.ts             # Vite + Vitest 配置
```

---

## 🔐 安全性

- **环境变量隔离**: 敏感信息不提交到 Git
- **Row Level Security**: Supabase RLS 策略
- **CORS 配置**: 生产环境域名白名单
- **API 鉴权**: Discord 提醒需要 CRON_SECRET

---

## 🚧 开发路线图

### 已完成 ✅
- [x] ORATS + Tiingo 数据源集成（替换 Polygon.io）
- [x] IV Term Structure + IV Rank
- [x] Skew 精准化 + Regime Detection 增强
- [x] 实时 Greeks 和报价（ORATS）
- [x] React Router v6 + React Query v5 架构重构
- [x] 懒加载路由（包大小 983KB → 430KB）
- [x] WFA backtesting engine（rolling window, portfolio stress, slippage, BSM pricing）
- [x] 130M 短线策略迁移（已退役，历史回测基础设施保留）
- [x] Sealed-holdout 协议（pre-reg → audit-rows → 6-gate 封存）
- [x] **Phase F0 clean-slate（2026-04-23）**：有效尝试计数器从全局 N=106 重置，单次性
- [x] **Phase F1 adoption（2026-04-23）**：两个并行策略通过 6/6 封存
  - BCD QQQ wide（bull call debit spread，$2K 级别，10 交易日触发）
  - PMCC QQQ pt60（diagonal，$10K+ 级别，持续在场）
- [x] **平台 F1 改造**：Dashboard/Signals/Portfolio/Stats 适配 BCD+PMCC 并行；DTE5 退役
- [x] 手动入场 modal（BCDEntryModal、PMCCEntryModal），自动追踪 P&L/rolls
- [x] 1213 项自动化测试 + GitHub Actions CI
- [x] Multi-AI team protocol（Claude + Gemini handoff system）

### 计划中 📋
- [ ] BCD/PMCC 实时入场触发警报（目前 PositionCard 仅静态标识触发阈值）
- [ ] PMCC rollShortLeg mutation（一次性关旧短腿 + 开新短腿）
- [ ] Settings 页面新增 BCD/PMCC 资本 tier 编辑器
- [ ] 第三个 F1 候选（CSP HOOD/PLTR、SPY PMCC）— 每新增尝试均收紧 dsrM

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 📄 许可证

MIT License

---

## 📧 联系方式

- **项目主页**: [GitHub Repository](#)
- **问题反馈**: [Issues](#)
- **文档**: [docs/](docs/)

---

*最后更新: 2026年4月24日（Phase F1 平台改造 + cron-signal-scan / useSignalScanner 退役）*
