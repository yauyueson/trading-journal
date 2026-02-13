# 📊 Trading Journal - Options Trading Platform

> 专业期权交易日志与策略推荐系统  
> **数据源**: Polygon.io（主）/ CBOE（备）

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
- **Vite** - 极速开发服务器
- **Tailwind CSS** - 现代化 UI 设计
- **Recharts** - 数据可视化

### 后端
- **Vercel Serverless Functions** - 无服务器 API
- **Supabase** - PostgreSQL 数据库 + 实时订阅
- **Polygon.io** - 实时期权数据 + Greeks + IV（主数据源）
- **CBOE API** - 备用数据源（15 分钟延迟，免费）

### 核心算法
- **OSS v2.3** - Options Scoring System
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

# 期权数据源（不设置时默认 CBOE；推荐 Polygon 获取实时 Greeks）
DATA_SOURCE=POLYGON
POLYGON_API_KEY=your_polygon_api_key

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
- [Polygon 集成](docs/09_Polygon集成.md) - 数据源配置与用量优化
- [文档中心](docs/README.md) - 全部技术文档（架构、API、部署见 [02_技术路径](docs/02_技术路径.md)、[05_API文档](docs/05_API文档.md)）

---

## 🎯 数据源（Polygon.io）

| 指标 | CBOE（备） | Polygon（主） |
|------|------------|----------------|
| **Greeks 精度** | 全为 0 | 完整 |
| **价格延迟** | 15 分钟 | 实时 |
| **IV 数据** | 不完整 | 完整曲线 |
| **请求优化** | 全链 | 仅所需 DTE/行权 + 1 分钟缓存 |

配置 `DATA_SOURCE=POLYGON` 与 `POLYGON_API_KEY` 即可启用；详见 [docs/09_Polygon集成.md](docs/09_Polygon集成.md)。

---

## 🧪 测试

### 本地 API 测试
```bash
node _test_strategy.js
```

### Vite 开发环境
```bash
npm run dev  # ⚠️ 使用简化的 CBOE 处理器
```

### 完整功能测试
```bash
vercel dev   # 使用真实 API 文件
# 或
vercel --prod  # 部署到生产环境
```

---

## 📊 项目结构

```
trading-journal/
├── api/                      # Serverless Functions
│   ├── _shared/
│   │   └── scoring.cjs      # 共享评分逻辑
│   ├── strategy-recommend.js # 策略推荐
│   ├── scan-options.js       # 期权扫描器
│   ├── option-price.js       # 单合约报价
│   ├── check-alerts.js       # 止损/目标价提醒
│   └── daily-recap.js        # 每日汇总
├── src/
│   ├── components/           # React 组件
│   ├── pages/                # 页面组件
│   ├── lib/
│   │   ├── oss-core.ts      # OSS 评分算法
│   │   ├── scoring.ts       # 批量评分
│   │   └── supabase.ts      # Supabase 客户端
│   └── App.tsx              # 主应用
├── docs/                     # 文档
└── vite.config.ts           # Vite 配置
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
- [x] Polygon.io 数据源集成
- [x] IV Term Structure + IV Rank
- [x] Skew 精准化
- [x] Regime Detection 增强
- [x] 实时 Greeks 和报价（Polygon）

### 进行中 🔄
- [ ] 前端 IV 曲线可视化
- [ ] Vega 加权评分

### 计划中 📋
- [ ] 服务端预过滤优化
- [ ] 历史 IV 数据回测
- [ ] 多数据源聚合

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

*最后更新: 2026年2月12日*
