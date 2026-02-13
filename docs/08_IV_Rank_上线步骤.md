# IV Rank 上线步骤

按下面两步做完后，Scanner 与 Strategy Recommender 会自动积累 IV 历史并参与评分。

---

## 步骤 1：在 Supabase 执行 Migration 003

### 1.1 打开 Supabase 控制台

1. 登录 [Supabase](https://supabase.com/dashboard)
2. 选中你的项目（Trading Journal 使用的项目）
3. 左侧菜单点 **SQL Editor**

### 1.2 执行 SQL

1. 点 **New query**
2. 复制下面整段 SQL，粘贴到编辑器里
3. 点 **Run**（或 Ctrl/Cmd + Enter）

```sql
-- Migration 003: IV Rank 历史表 (ticker_iv_snapshots)
CREATE TABLE IF NOT EXISTS ticker_iv_snapshots (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    ticker VARCHAR(20) NOT NULL,
    recorded_date DATE NOT NULL,
    iv30 DECIMAL(8,6) NOT NULL,
    iv90 DECIMAL(8,6),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(ticker, recorded_date)
);

CREATE INDEX IF NOT EXISTS idx_ticker_iv_snapshots_ticker_date
ON ticker_iv_snapshots(ticker, recorded_date DESC);

ALTER TABLE ticker_iv_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on ticker_iv_snapshots" ON ticker_iv_snapshots;
CREATE POLICY "Allow all on ticker_iv_snapshots"
ON ticker_iv_snapshots FOR ALL USING (true) WITH CHECK (true);
```

4. 看到 **Success. No rows returned** 即表示执行成功。

（也可以直接打开项目里的 `docs/migrations/003_ticker_iv_snapshots.sql` 复制同样内容执行。）

---

## 步骤 2：配置环境变量

IV 历史读写需要 Supabase 的 URL 和 Anon Key，与 `check-alerts` 用的是同一套。

### 2.1 本地开发（.env）

在项目根目录的 `.env` 或 `.env.local` 里确保有：

```env
VITE_SUPABASE_URL=https://你的项目.supabase.co
VITE_SUPABASE_ANON_KEY=你的_anon_key
```

若已有登录/持仓功能，一般已经配过，检查名字一致即可。  
API 里会读 `process.env.SUPABASE_URL` 或 `process.env.VITE_SUPABASE_URL`，Vercel 部署时通常用下面那组。

### 2.2 Vercel 部署

1. 打开 [Vercel Dashboard](https://vercel.com/dashboard) → 选中 **trading-journal** 项目
2. 点 **Settings** → **Environment Variables**
3. 确认已有：
   - `SUPABASE_URL` = `https://你的项目.supabase.co`
   - `SUPABASE_ANON_KEY` = 你的 anon key（一长串）
4. 若没有则点 **Add** 添加，Environment 选 **Production**（以及需要的话 **Preview**）
5. 改过变量后，到 **Deployments** 里对最新部署点 **Redeploy** 一次，新变量才会生效

Supabase 里查 URL 和 Key：Supabase 项目 → **Settings** → **API** → **Project URL** 与 **anon public**。

---

## 步骤 3：历史数据回填 (可选但建议)

由于新表开始是空的，IV Rank 需要积累 252 天数据才能达到最佳精度。你可以使用内置回填脚本利用 Polygon 的历史价格数据（RV30）生成初始历史。

### 3.1 准备脚本
确保 `api/setup-iv-rank.js` 存在且配置为使用 `polygon-client.js`。

### 3.2 运行回填
在终端执行：
```bash
node api/setup-iv-rank.js
```

**注意事项**：
- **速率限制**：如果你使用的是 Polygon 免费版/入门版，每分钟限制 5 次请求。脚本已内置 15 秒延时和逐条写入逻辑。
- **覆盖标的**：默认脚本包含 `SPY`, `QQQ` 等主流标的。如果需要回填其他标的，请修改脚本中的 `tickers` 数组。
- **数据冲突**：如果标的已有数据，脚本会跳过冲突日期，确保数据不重复。

---

## 验证

- **Scanner**：选一个标的扫一次，看返回的 `context` 里是否有 `ivRank`、`ivPercentile`、`ivRankSampleDays`。首日或新标的多为 `ivRank: null`、`sampleDays: 1`，多扫几天后会逐渐有历史。
- **Strategy Recommender**：看返回的 `regime.ivRank`、`regime.ivPercentile`；**页面上**在 regime 区域同时展示 **IV Rank** 与 **IV Percentile**（Rank XX%、%ile XX%，同色阶）。IV Rank 已参与打分：**Single-leg (LOQ)**、**Credit Spread**、**Debit Spread** 三类策略均通过 `getIVRankAdjustment(ivRank, strategy)` 微调——买方（LOQ、Debit）：IV Rank 高略降分、低略加分；卖方（Credit）：IV Rank 高略加分、低略减分。
- **直接查 IV Rank**：浏览器或 Postman 请求  
  `GET https://你的域名/api/iv-rank?ticker=QQQ`  
  有历史时会出现 `ivRank`、`ivPercentile` 等；无历史时 `ivRank` 为 `null`。

无 Supabase 配置时，接口不会报错，只是不写表、不读表，IV Rank 相关字段为 null，评分不加 IV Rank 调整。
