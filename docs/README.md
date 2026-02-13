# Trading Journal - 文档总览

> 最后更新: 2026年2月12日

欢迎来到Trading Journal项目文档中心！这里包含了项目的完整技术文档和使用指南。

---

## 📚 文档目录

### 0️⃣ [PRD 总览](./00_PRD_总览.md) **NEW**
**适合**: 产品、项目负责人、新成员

**内容**:
- 产品愿景与目标
- 用户角色与典型场景
- 功能总览与优先级（P0/P1/P2）
- 非功能需求、范围边界（In/Out）
- 依赖与约束、相关文档索引

**阅读时间**: 10分钟

---

### 1️⃣ [项目概览](./01_项目概览.md)
**适合**: 新用户、产品经理、投资者

**内容**:
- 项目简介和核心价值主张
- 技术架构概览
- 核心功能模块介绍
- 数据模型概述
- 未来规划路线图

**阅读时间**: 15分钟

---

### 2️⃣ [技术路径](./02_技术路径.md)
**适合**: 开发者、技术负责人

**内容**:
- 前端技术栈详解（React, TypeScript, Vite, Tailwind）
- 后端架构设计（Supabase, Vercel Serverless）
- 数据流设计
- API集成方案
- 状态管理策略
- 性能优化技巧

**阅读时间**: 25分钟

---

### 3️⃣ [核心算法](./03_核心算法.md)
**适合**: 量化交易者、算法工程师、高级用户

**内容**:
- OSS评分系统详解
- LOQ算法（买方评分）
  - Lambda（杠杆率）
  - Gamma Efficiency（爆发力）
  - Theta Burn（时间衰减）
  - Delta Bonus（ATM奖励）
- CSQ算法（卖方评分）
- IV期限结构分析（4-Card Method）
- 警告系统算法
- P&L计算算法

**阅读时间**: 30分钟

---

### 4️⃣ [数据库设计](./04_数据库设计.md)
**适合**: 后端开发者、数据库管理员

**内容**:
- PostgreSQL表结构设计
  - positions（持仓表）
  - transactions（交易记录表）
  - greeks_history（Greeks历史表）
- 关系设计和ER图
- 索引策略
- Row Level Security (RLS)
- 迁移历史
- 常用查询示例

**阅读时间**: 20分钟

---

### 5️⃣ [API文档](./05_API文档.md)
**适合**: 前端开发者、API集成者

**内容**:
- 数据源配置（DATA_SOURCE：MarketData.app 主 / CBOE 备）
- 期权价格API详解（端点、参数、响应格式、dataSource 字段）
- OCC Symbol、价格计算逻辑
- Supabase REST API使用
- 错误处理和重试机制
- 安全性和CORS配置
- 测试方法

**阅读时间**: 20分钟

---

### 6️⃣ [用户工作流](./06_用户工作流.md)
**适合**: 所有用户、交易者

**内容**:
- 日常交易流程（开盘前、盘中、收盘后）
- Scanner使用指南
- Watchlist管理
- 持仓管理
- 风险管理策略
- 最佳实践和常见错误
- 成功案例分析

**阅读时间**: 25分钟

---

### 7️⃣ [止损与目标价提醒方案](./07_止损与目标价短信提醒方案.md) ✅ 已上线
**适合**: 需要「价格触及止损/目标时收 Discord 推送」的用户、开发者

**内容**:
- 为何必须用服务端定时任务
- 现有数据（target_price、止损公式）与可选补齐（stop_price）
- 通知渠道选型（Discord Webhook 免费 / Twilio 付费）
- `/api/check-alerts` 实现（Supabase REST API + Discord Webhook）
- 外部 Cron（cron-job.org）配置（Vercel Hobby 不支持高频 Cron）
- 安全、成本注意点

**阅读时间**: 10分钟

---

### 8️⃣ [IV Rank 上线步骤](./08_IV_Rank_上线步骤.md)
**适合**: 需要 IV Rank 功能的开发者  
**内容**: IV Rank 功能上线步骤与数据准备。

---

### 9️⃣ [Polygon 集成](./09_Polygon集成.md)
**适合**: 开发者、运维

**内容**:
- 期权数据源架构（Polygon 主 / CBOE 备）
- Polygon.io API 客户端、数据格式与用量优化（仅请求所需 DTE/行权 + 1 分钟缓存）
- 环境变量、配置步骤与故障排除

**阅读时间**: 15分钟

> 原 MarketData.app 集成已弃用，见 [09_MarketData集成.md](./09_MarketData集成.md) 仅作重定向。

---

## 🚀 快速开始

### 新用户
1. 阅读 [项目概览](./01_项目概览.md) 了解项目
2. 阅读 [用户工作流](./06_用户工作流.md) 学习使用
3. 开始交易！

### 开发者
1. 阅读 [项目概览](./01_项目概览.md) 了解架构
2. 阅读 [技术路径](./02_技术路径.md) 了解技术栈
3. 阅读 [数据库设计](./04_数据库设计.md) 了解数据模型
4. 阅读 [API文档](./05_API文档.md) 开始集成

### 量化交易者
1. 阅读 [核心算法](./03_核心算法.md) 了解评分系统
2. 阅读 [用户工作流](./06_用户工作流.md) 学习应用
3. 根据算法优化交易策略

---

## 📖 文档结构

```
docs/
├── README.md                 # 本文件（文档索引）
├── 00_PRD_总览.md             # 产品需求文档总览
├── 01_项目概览.md             # 项目简介和架构
├── 02_技术路径.md             # 技术栈和实现细节
├── 03_核心算法.md             # 评分算法详解
├── 04_数据库设计.md           # 数据模型和SQL
├── 05_API文档.md              # API 接口与数据源配置
├── 06_用户工作流.md           # 使用指南和最佳实践
├── 07_止损与目标价短信提醒方案.md  # 短信提醒实现方案
├── 08_IV_Rank_上线步骤.md     # IV Rank 上线步骤
├── 09_Polygon集成.md           # Polygon 数据源集成（主）
└── 09_MarketData集成.md       # [已弃用] 重定向至 09_Polygon集成
```

---

## 🔍 按主题查找

### 架构和设计
- [技术架构概览](./01_项目概览.md#技术架构概览)
- [前端技术栈](./02_技术路径.md#前端技术栈)
- [后端架构](./02_技术路径.md#后端架构)
- [数据库设计](./04_数据库设计.md)

### 核心功能
- [Portfolio管理](./01_项目概览.md#1-portfolio-持仓管理)
- [Scanner扫描器](./01_项目概览.md#3-scanner-期权扫描器)
- [警告系统](./01_项目概览.md#警告系统)

### 算法和计算
- [LOQ评分算法](./03_核心算法.md#loq算法买方评分)
- [IV期限结构](./03_核心算法.md#iv期限结构分析)
- [P&L计算](./03_核心算法.md#pl计算算法)

### API和集成
- [数据源配置](./05_API文档.md#数据源配置)
- [期权价格API](./05_API文档.md#期权价格api)
- [Polygon 集成](./09_Polygon集成.md)
- [Supabase API](./05_API文档.md#supabase-rest-api)
- [错误处理](./05_API文档.md#错误处理)
- [完整技术文档（架构/API/部署）](../TECHNICAL_DOCUMENTATION.md)

### 使用指南
- [日常交易流程](./06_用户工作流.md#日常交易流程)
- [Scanner使用](./06_用户工作流.md#scanner使用指南)
- [风险管理](./06_用户工作流.md#风险管理)
- [最佳实践](./06_用户工作流.md#最佳实践)

---

## 💡 常见问题

### Q: 如何开始使用Trading Journal？
**A**: 阅读 [用户工作流](./06_用户工作流.md) 文档，从"日常交易流程"开始。

### Q: Scanner的评分是如何计算的？
**A**: 详见 [核心算法 - LOQ算法](./03_核心算法.md#loq算法买方评分)。

### Q: 如何设置止损条件？
**A**: 参考 [用户工作流 - 风险管理](./06_用户工作流.md#风险管理)。

### Q: API调用失败怎么办？
**A**: 查看 [API文档 - 错误处理](./05_API文档.md#错误处理)。

### Q: 数据库表结构是什么？
**A**: 详见 [数据库设计 - 表结构设计](./04_数据库设计.md#表结构设计)。

---

## 🔄 文档更新日志

### 2026-02-12（文档精简与数据源统一）
- ✅ **技术文档与数据源一致化**：全项目文档统一为 **Polygon.io（主）+ CBOE（备）**；API 层已仅支持 POLYGON/CBOE，MarketData 已弃用。
- ✅ **删除重复/过时**：删除 `docs/TECHNICAL_DOCUMENTATION.md`（与根目录重复，保留根目录一份）；删除 `MIGRATION_SUMMARY.md`（内容已入 CHANGELOG）。
- ✅ **弃用说明**：`09_MarketData集成.md`、`MARKETDATA_DEV_GUIDE.md` 改为弃用重定向，指向 Polygon 集成与根目录技术文档。
- ✅ **单点技术文档**：完整架构/API/部署见根目录 [TECHNICAL_DOCUMENTATION.md](../TECHNICAL_DOCUMENTATION.md)；docs 目录以 PRD/概览/算法/数据库/API/工作流/提醒/IV Rank/Polygon 为主。
- ✅ **05_API文档、01_项目概览、00_PRD、README**：数据源描述与环境变量统一为 Polygon + CBOE；端点表与故障排除更新。

### 2026-02-09
- ✅ **Portfolio 价差快速添加**: Quick Add 表单支持 Single Leg / Credit Spread / Debit Spread 切换，自动构建 `legs` JSONB 并写入 Supabase。
- ✅ **策略推荐 Spread Width 可配置**: 新增 $2.5/$5/$10/$20 宽度选择器，替代硬编码的 `[5,10]`/`[2.5,5]`，同步更新 `api/strategy-recommend.js` 和 `vite.config.ts` 本地 dev。
- ✅ **iOS/移动端优化**: `.input-field` 添加 `text-base`（16px）防 Safari 缩放；价差 Strike 响应式布局（移动 2 列 / 桌面 3 列）；所有按钮 ≥44px 触控目标；数字输入 `inputMode="decimal"`。
- ✅ **数据库 Schema 更新**: `positions` 表新增 `legs JSONB`、`stop_price DECIMAL`；`type` 列拓宽至 `VARCHAR(50)` 支持价差类型字符串。
- ✅ **类型更新**: `DirectAddItem` 新增 `legs?: PositionLeg[]`；`App.onAddDirect` 传递 legs 至 Supabase。
- ✅ **文档同步**: TECHNICAL_DOCUMENTATION、04_数据库设计、05_API文档 反映最新 Schema、API 参数和前端功能。

### 2026-02-08
- ✅ **Discord 自动提醒上线**: 新增 `api/check-alerts.js`（止损/目标价 Discord 推送）、`api/health.js`（健康检查）。
- ✅ **部署修复**: 移除 `vercel.json` 中的 `crons` 配置（Vercel Hobby 计划不支持高频 Cron，会导致部署失败）；改用 cron-job.org 外部定时触发。
- ✅ **基础设施**: `.gitignore` 增加 `dist/`、`.env`、`.env.local`；从 Git 移除 `dist/` 目录；新增 Deploy Hook 备选部署方式。
- ✅ **文档更新**: 更新 TECHNICAL_DOCUMENTATION（架构图、文件结构、部署方式、Discord 提醒、故障排除）；更新 API 文档（check-alerts、health 端点）；更新技术路径（外部 Cron、Hobby 限制）；更新 PRD（Discord 提醒为 P1 功能）；更新提醒方案文档（反映实际实现）。

### 2026-02-07
- ✅ **PRD 总览**: 新增 [00_PRD_总览.md](./00_PRD_总览.md)，产品愿景、用户场景、功能优先级、范围边界与依赖约束。
- ✅ **技术文档**: 更新 TECHNICAL_DOCUMENTATION.md — OSS 单点事实架构（oss-core + api/_shared）、文件结构、重构说明（LERP/Theta 上限/Lambda 压缩/Day Trade/类型与边界）。
- ✅ **技术路径**: 更新 02_技术路径.md — lib 与 api 目录结构、共享评分模块、Scanner 数据流（后端单遍过滤+评分）。
- ✅ **API 文档**: 更新 05_API文档.md — 端点列表、underlying-rv、评分逻辑统一说明。

### 2026-02-06
- ✅ **Credit Spread Accounting**: 修复信用价差核算，采用 Cost to Close (Short - Long) 逻辑，修正 P&L 计算。
- ✅ **Spread Scoring Optimization**: 将价差评分算法集成至 `scoring.ts`，实现 Portfolio 与 Recommender 评分 100% 映射一致。
- ✅ **Stability & Persistence**: 优化价格刷新逻辑，增加本地 `liveData` 缓存，修复数据刷新时的抖动和 disappearing 问题。
- ✅ **API Polish**: 更新 CBOE 接口头信息，修复 403 错误，标准化 `underlyingPrice` 字段。
- ✅ **Bug Fixes**: 解决评分 NaN 问题，优化 Tooltip 全局展示性能。

### 2026-02-05
- ✅ 优化评分权重 (OSS v2.1)
- ✅ 增加 Delta Bonus 线性插值
- ✅ 增加 Theta Pain Capsule 惩罚算法

### 未来计划
- [ ] 添加视频教程
- [ ] 添加交互式示例
- [ ] 添加故障排除指南
- [ ] 添加性能优化指南

---

## 📞 联系方式

**问题反馈**: GitHub Issues
**功能建议**: GitHub Discussions
**紧急联系**: [待补充]

---

## 📄 许可证

本项目文档采用 [MIT License](../LICENSE)

---

*文档维护者: Trading Journal Team*
*最后更新: 2026年2月12日*
