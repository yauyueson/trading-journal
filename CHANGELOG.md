# 更新日志 (CHANGELOG)

所有重要的项目更改都将记录在此文件中。

---

## [2.1.0] - 2026-02-12

### 🔄 重大更新: MarketData.app → Polygon.io 数据源迁移

#### 核心变更
- ✅ **Polygon.io (MASSIVE) 集成**
  - 完全替换 MarketData.app 作为主要数据源
  - 高质量实时期权数据 + Greeks + IV
  - 企业级 API 稳定性和可靠性

#### 技术实现
- **新增文件**
  - `api/polygon-client.js` - Polygon.io 客户端模块（替换 market-data-client.js）
  - `docs/09_Polygon集成.md` - 完整集成文档

- **更新的 API 端点** (7个)
  - `api/option-price.js` - 单个期权定价
  - `api/scan-options.js` - Scanner 扫描器
  - `api/strategy-recommend.js` - 策略推荐
  - `api/option-prices-bulk.js` - 批量定价（并发优化）
  - `api/check-alerts.js` - 告警检查
  - `api/daily-recap.js` - 每日汇总
  - `api/backfill-iv-history.js` - IV 历史回填

#### API 功能映射
| 功能 | Polygon.io 端点 |
|------|----------------|
| 期权链 | `/v3/reference/options/contracts` |
| 期权快照 | `/v3/snapshot/options/{underlying}/{contract}` |
| 历史K线 | `/v2/aggs/ticker/{ticker}/range/{timespan}` |

#### 数据格式适配
- 响应格式从 MarketData 的列式数组转为 Polygon 的嵌套对象
- Greeks 字段映射：`greeks.delta/gamma/theta/vega`
- IV 路径更新：`greeks.implied_volatility`
- 自动计算 DTE (Days To Expiration)

#### 性能优化
- 批量请求分块处理（CHUNK_SIZE = 10）
- 5 秒内存缓存机制
- CBOE fallback 保留为备用数据源

#### 配置变更
- **环境变量更新**:
  - ~~`MARKET_DATA_TOKEN`~~ → `POLYGON_API_KEY`
  - `DATA_SOURCE=MARKET_DATA` → `DATA_SOURCE=POLYGON`

#### 文档更新
- ✅ 更新 `docs/00_PRD_总览.md` - 数据源引用
- ✅ 新增 `docs/09_Polygon集成.md` - 完整迁移指南
- ✅ 更新 CHANGELOG.md

#### 验证测试
- ✅ Scanner API 测试通过（AAPL, 46 results, Greeks 完整）
- ✅ Option Price API 正常工作
- ⚠️ 需求：Polygon subscription 需包含 Options Advanced features

#### 迁移影响
- **向后兼容**: CBOE fallback 保留，未配置 Polygon 时自动降级
- **成本变化**: Polygon.io Starter plan ($99/月) vs MarketData.app
- **速率限制**: 需监控 API 使用量，避免触发 429 错误

---

## [2.0.0] - 2026-02-12

### 🎉 重大更新: MarketData.app 集成

#### 新增功能
- ✅ **MarketData.app 数据源集成**
  - 实时期权报价（无延迟）
  - 交易所级 Greeks（Delta/Gamma/Theta/Vega/IV）
  - 完整 IV Term Structure（IV7-IV120）
  - 智能数据源切换（MarketData → CBOE 备用）

- ✅ **IV Term Structure 构建**
  - 新增 `buildIVTermStructure()` 函数
  - 支持 6 个 DTE 点：IV7, IV14, IV30, IV60, IV90, IV120
  - 异常检测：自动识别 Earnings Spike（IV7/IV30 > 1.3）

- ✅ **Skew 计算精准化**
  - 真实 25-delta Put/Call Skew 计算
  - Skew-aware 策略选择优化

- ✅ **Regime Detection 增强**
  - 基于完整 IV 曲线的精准判断
  - 不再频繁 fallback 到 NEUTRAL
  - 新增 `adviceDetail` 详细建议

#### 更新的 API 端点
- `api/strategy-recommend.js`
  - 新增 `regime.ivSurface` 对象
  - 新增 `regime.adviceDetail` 字段
  - 支持 MarketData 数据源

- `api/scan-options.js`
  - 真实 Greeks 支持
  - 精准 Delta Bonus 计算
  - MarketData 优先，CBOE 备用

- `api/option-price.js`
  - 实时报价（非 15 分钟延迟）
  - 完整 Greeks 数据
  - 数据源标识 `dataSource` 字段

- `api/check-alerts.js`
  - 实时止损/目标价监控
  - 支持多腿策略 Net Value 计算
  - MarketData 集成

- `api/daily-recap.js`
  - 实时持仓价格
  - 精确 P&L 计算
  - 格式无关的价格查找

#### 新增文件
- `api/market-data-client.js` - MarketData.app 客户端模块
- `docs/09_MarketData集成.md` - 完整集成文档
- `MARKETDATA_DEV_GUIDE.md` - 开发者测试指南

#### 算法优化
- `api/_shared/scoring.cjs`
  - `parseChain()` 智能格式检测
  - `buildIVTermStructure()` IV 曲线构建
  - `calculateSkew()` 自动生效（真实 delta）

#### 文档更新
- 更新 `README.md` - 添加 MarketData 集成说明
- 更新 `docs/05_API文档.md` - 数据源配置和对比
- 更新 `docs/02_技术路径.md` - 架构更新

#### 配置变更
- 新增环境变量：
  - `DATA_SOURCE` - 数据源选择（MARKET_DATA/CBOE）
  - `MARKET_DATA_TOKEN` - MarketData.app API Token

- `vite.config.ts` 文档化
  - 添加 Vite dev 环境限制说明
  - 提供完整测试方案

---

## [1.5.0] - 2026-02-10

### 新增功能
- ✅ **OSS v2.3 算法升级**
  - DTE 分桶 Z-Score 标准化
  - 候选池 Hard Filters
  - 真实到期 Breakeven 计算

### 优化
- 改进流动性筛选逻辑
- 优化 Lambda 压缩算法

---

## [1.4.0] - 2026-02-08

### 新增功能
- ✅ **Discord 自动提醒**
  - 止损/目标价触发提醒
  - 每日持仓汇总
  - 外部 Cron 集成

### 修复
- 修复 Vercel Hobby 计划 Cron 限制
- 优化 Supabase REST API 调用

---

## [1.3.0] - 2026-02-07

### 新增功能
- ✅ **策略推荐引擎**
  - Credit Spreads
  - Debit Spreads
  - Long Options
  - IV Regime Detection

### 优化
- 改进评分算法一致性
- 统一前后端评分逻辑

---

## [1.2.0] - 2026-02-05

### 新增功能
- ✅ **Greeks 历史图表**
- ✅ **Portfolio 自动刷新**
- ✅ **Scanner UI 增强**

### 修复
- 修复 Tooltip 显示问题
- 优化移动端适配

---

## [1.1.0] - 2026-02-04

### 新增功能
- ✅ **OSS v2.2 算法**
  - Delta Bonus (LERP)
  - Theta 上限 10
  - Lambda 压缩

### 优化
- 改进评分权重
- 优化过滤逻辑

---

## [1.0.0] - 2026-02-03

### 初始发布
- ✅ 基础持仓管理
- ✅ 期权扫描器
- ✅ Supabase 集成
- ✅ CBOE API 集成

---

## 版本说明

版本号格式：`MAJOR.MINOR.PATCH`

- **MAJOR**: 重大架构变更或不兼容更新
- **MINOR**: 新功能添加
- **PATCH**: Bug 修复和小优化

---

*最后更新: 2026年2月12日*
