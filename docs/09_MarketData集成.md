# MarketData.app 集成技术文档

> 创建日期: 2026年2月12日  
> 版本: 1.0

## 📋 概述

本文档详细说明 MarketData.app API 的集成方案，包括数据源切换、API 架构、算法升级和测试流程。

---

## 🎯 集成目标

### 问题背景
CBOE 免费 API 存在以下限制：
- ❌ **Greeks 数据缺失**: Delta/Gamma/Theta/Vega 全为 0
- ❌ **15分钟延迟**: 非实时报价
- ❌ **速率限制**: 429 Too Many Requests 频繁出现
- ❌ **IV 数据不完整**: 影响 Regime Detection 和 Skew 计算

### 解决方案
集成 MarketData.app 获取：
- ✅ **交易所级 Greeks**: 精确的 Delta/Gamma/Theta/Vega/IV
- ✅ **实时报价**: 无延迟的 Bid/Ask/Last
- ✅ **完整 IV 曲线**: 支持 IV Term Structure 构建
- ✅ **高可用性**: 稳定的 API 服务

---

## 🏗️ 架构设计

### 1. 双数据源架构

```
环境变量 DATA_SOURCE（未设置时默认为 CBOE）
    ├── MARKET_DATA → MarketData.app API（推荐，需 MARKET_DATA_TOKEN）
    └── CBOE        → CBOE 免费 API（备用或默认）
```

**配置方式**:
```bash
# .env.local
DATA_SOURCE=MARKET_DATA
MARKET_DATA_TOKEN=your_api_token_here
```

### 2. API 客户端模块

**文件**: `api/market-data-client.js`

**核心功能**:
```javascript
// 获取期权链
export async function getOptionChain(ticker, options = {}) {
  const { expiration, dte, strikeRange, delta } = options;
  // ... 实现细节
}

// 获取可用到期日
export async function getExpirations(ticker) {
  // ... 实现细节
}
```

**特性**:
- 智能 DTE 过滤（客户端实现）
- Strike 范围过滤
- Delta 范围过滤
- 完整的错误处理和重试机制

### 3. 数据格式标准化

**MarketData 格式**:
```json
{
  "symbol": "SPY260320C00680000",
  "strike": 680,
  "type": "Call",
  "expiration": "2026-03-20",
  "dte": 36,
  "bid": 16.35,
  "ask": 16.42,
  "last": 16.38,
  "delta": 0.5247,
  "gamma": 0.0103,
  "theta": -0.1752,
  "vega": 0.9251,
  "iv": 0.1681,
  "volume": 19,
  "openInterest": 17
}
```

**CBOE 格式** (保留兼容):
```json
{
  "option": "SPY  260320C00680000",
  "bid": 16.35,
  "ask": 16.42,
  "last_trade_price": 16.38,
  "delta": 0,
  "gamma": 0,
  "theta": 0,
  "vega": 0,
  "iv": 0,
  "volume": 19,
  "open_interest": 17
}
```

---

## 📡 API 端点更新

### 已集成 MarketData 的端点

| 端点 | 功能 | MarketData 支持 | CBOE 备用 |
|------|------|----------------|-----------|
| `/api/strategy-recommend` | 策略推荐 | ✅ | ✅ |
| `/api/scan-options` | 期权扫描器 | ✅ | ✅ |
| `/api/option-price` | 单合约报价 | ✅ | ✅ |
| `/api/check-alerts` | 止损/目标价提醒 | ✅ | ✅ |
| `/api/daily-recap` | 每日汇总 | ✅ | ✅ |

### 数据流示例

**策略推荐流程**:
```
用户请求 → strategy-recommend.js
    ↓
检查 DATA_SOURCE 环境变量
    ↓
DATA_SOURCE=MARKET_DATA?
    ├── 是 → market-data-client.js → MarketData API
    └── 否 → CBOE API
    ↓
parseChain() 格式检测
    ├── MarketData 格式 → 直接使用 Greeks
    └── CBOE 格式 → 解析 OCC 符号
    ↓
buildIVTermStructure() → 构建 IV 曲线
    ↓
detectRegime() → 判断 CREDIT/DEBIT/NEUTRAL
    ↓
返回策略推荐 + ivSurface
```

---

## 🧮 算法升级

### 1. 真实 Greeks 集成

**文件**: `api/_shared/scoring.cjs`

**升级前**:
```javascript
// CBOE delta 永远为 0
const delta = opt.delta || 0;  // 总是 0
const deltaBonus = 0;  // 无法计算
```

**升级后**:
```javascript
// MarketData 提供真实 delta
const delta = opt.delta;  // 例如: 0.5247
const deltaBonus = getDeltaBonus(delta);  // LERP 插值
```

### 2. IV Term Structure

**新增函数**: `buildIVTermStructure()`

**功能**:
```javascript
{
  iv7: 17.7,    // 7天期 ATM IV
  iv14: 18.2,   // 14天期
  iv30: 17.4,   // 30天期
  iv60: 17.0,   // 60天期
  iv90: 17.2,   // 90天期
  iv120: 17.5,  // 120天期
  anomaly: false,  // 是否检测到异常（earnings spike）
  anomalyRatio: null  // IV7/IV30 比率
}
```

**应用场景**:
- Regime Detection 精准化
- Earnings 事件检测
- 前端 IV 曲线可视化

### 3. Skew 计算

**升级前**:
```javascript
// delta 为 0，无法找到 25-delta options
const skew = 0;
```

**升级后**:
```javascript
// 精确查找 delta ≈ ±0.25 的期权
const puts = chain.filter(o => Math.abs(o.delta + 0.25) < 0.10);
const calls = chain.filter(o => Math.abs(o.delta - 0.25) < 0.10);
const skew = (putIV - callIV) / atmIV;  // 真实 skew
```

### 4. Regime Detection 增强

**升级前**:
```javascript
// IV 数据不足，经常 fallback
mode: "NEUTRAL"
```

**升级后**:
```javascript
// 基于完整 IV 曲线判断
if (ivRatio < 0.95) mode = "DEBIT";   // Contango
else if (ivRatio > 1.05) mode = "CREDIT";  // Backwardation
else mode = "NEUTRAL";

// 附加异常检测
if (ivSurface.anomaly) {
  adviceDetail += " ⚠️ 检测到短期 IV 异常飙升，可能有即将到来的事件（财报）。";
}
```

---

## 🧪 测试方案

### 1. 本地 API 测试

**直接测试脚本**:
```bash
node _test_strategy.js
```

**验证项**:
- ✅ `ivSurface` 对象存在
- ✅ Greeks 非零 (delta, gamma, theta, vega)
- ✅ Skew 计算结果
- ✅ Regime mode 不是 NEUTRAL

### 2. Vite 开发环境

**限制说明**:
```bash
npm run dev  # 使用 vite.config.ts 中的简化 CBOE 处理器
```

**注意**:
- ⚠️ Vite dev 不包含 MarketData 集成
- ⚠️ 缺少 `ivSurface` 数据
- ⚠️ Greeks 可能为 0

**原因**: Vite 配置文件中的 API 处理器为了简化开发体验，硬编码了 CBOE 逻辑（1000+ 行代码）。

### 3. Vercel 部署测试

**完整功能测试**:
```bash
# 预览部署
vercel

# 生产部署
vercel --prod
```

**验证清单**:
- [ ] 访问 `/api/strategy-recommend?ticker=SPY&direction=BULL`
- [ ] 确认响应包含 `regime.ivSurface`
- [ ] 确认 Greeks 非零
- [ ] 测试 Scanner 页面
- [ ] 测试 Portfolio 价格刷新

---

## 📊 性能对比

| 指标 | CBOE | MarketData |
|------|------|------------|
| **Greeks 精度** | 全为 0 | 交易所级 |
| **价格延迟** | 15 分钟 | 实时 |
| **IV 数据** | 不完整 | 完整曲线 |
| **Skew 计算** | 不可用 | 精确 |
| **Regime 准确度** | 低 (常 NEUTRAL) | 高 |
| **速率限制** | 429 频繁 | 稳定 |
| **成本** | 免费 | 付费 |

---

## 🔐 安全配置

### 环境变量管理

**开发环境** (`.env.local`):
```bash
DATA_SOURCE=MARKET_DATA
MARKET_DATA_TOKEN=your_development_token
```

**生产环境** (Vercel Dashboard):
```
Settings → Environment Variables
├── DATA_SOURCE = MARKET_DATA
└── MARKET_DATA_TOKEN = your_production_token
```

**安全注意事项**:
- ❌ 不要提交 `.env.local` 到 Git
- ✅ 使用 Vercel 环境变量管理生产密钥
- ✅ 定期轮换 API Token
- ✅ 监控 API 使用量

---

## 🚀 部署流程

### 1. 环境变量配置

```bash
# Vercel Dashboard
vercel env add DATA_SOURCE
> MARKET_DATA

vercel env add MARKET_DATA_TOKEN
> your_token_here
```

### 2. 部署验证

```bash
# 1. 部署到预览环境
vercel

# 2. 测试 API 端点
curl "https://your-preview-url.vercel.app/api/strategy-recommend?ticker=SPY&direction=BULL"

# 3. 确认 ivSurface 存在
# 4. 部署到生产
vercel --prod
```

---

## 📚 相关文档

- [MarketData.app API 文档](https://www.marketdata.app/docs/)
- [MARKETDATA_DEV_GUIDE.md](../MARKETDATA_DEV_GUIDE.md) - 开发者测试指南
- [03_核心算法.md](./03_核心算法.md) - 算法详解
- [05_API文档.md](./05_API文档.md) - API 端点说明

---

## 🔄 未来优化

### 短期 (已完成)
- [x] 核心 API 集成
- [x] IV Term Structure
- [x] Skew 精准化
- [x] Regime Detection 增强

### 中期 (可选)
- [ ] 服务端预过滤优化
- [x] Vega 加权评分（v2.4：LOQ Vega 效率 + CSQ Vega 惩罚，见 03_核心算法.md）
- [ ] 前端 IV 曲线可视化
- [ ] 缓存策略优化

### 长期
- [ ] 多数据源聚合
- [ ] 实时 WebSocket 订阅
- [ ] 历史 IV 数据回测

---

*文档维护者: Trading Journal Team*  
*最后更新: 2026年2月12日*
