# MB_DFP_Options_Scanner v3.2 — User Manual
> **Last Updated**: 2026-02-19 | Current Build: **v3.3**

The `MB_DFP_Options_Scanner_v3.2` is a Pine Script indicator that acts as the **primary signal generator** for the Trading Journal workflow. It identifies high-probability options setups by scoring market environments across multiple dimensions, then routes each setup to the most appropriate options structure (Credit Spread, Debit Spread, Long, Iron Condor, etc.).

---

## 🔄 Workflow: TradingView → Web UI

**The TradingView Indicator is the definitive source of truth.** Every trade starts here.

### Step 1: Discover on TradingView
1. Attach `MB_DFP_Options_Scanner_v3.2` to any chart.
2. The scanner table shows tickers ranked by Score. Look at the **rightmost column** — `Structure | Engine` — for actionable setups (highlighted in green/red/purple).
3. Note three fields from an actionable row:
   - **Ticker** (e.g., `NVDA`)
   - **Setup** (e.g., `Strong Trend`)
   - **Target Strategy** (e.g., `Credit Put Spread`)

### Step 2: Plug into Option Selector (Web UI)
1. Open the **Option Selector** page.
2. Enter the Ticker, Direction, Target DTE, Target Strategy, and Setup from Step 1.
3. Click **Scan Options**.

### Step 3: Analyze & Execute
1. The Web UI fetches the exact options chain and scores every spread combination.
2. Review top-scored strikes, click **Add to Watchlist**, and log the trade.

---

## 🔍 How the Scanner Works

### Scoring Engine (0–100)
Each ticker is scored across 7 direction-aware components:

| Component | Weight | What it measures |
| :--- | :--- | :--- |
| **Market Bias (MB)** | 30% | Smoothed Heikin-Ashi oscillator — trend momentum direction |
| **B-Xtrender Short (Bx-S)** | 30% | Short-term MACD/RSI derivative — fast cycle alignment |
| **B-Xtrender Long (Bx-L)** | 15% | Medium-term baseline direction |
| **EMA Stack** | 15% | EMA 21/34/50 fan alignment — structural trend quality |
| **Momentum** | 10% | Price Rate-of-Change — candle velocity confirmation |
| **ADX** | Dynamic | Adjusts EMA weight vs. oscillator weight based on trend strength |
| **RVOL** | Scored | Volume participation — penalizes low-volume signals |

> **Coherence Multiplier**: If all three core indicators (MB, Bx-S, Bx-L) agree with the setup direction → 1.10× boost. If 2+ conflict → 0.85× penalty.

---

## 📊 Scanner Table Columns

### Visual Design Philosophy (v3.3)
The table uses a **dark/muted style** for most columns. Color is reserved only for the **Structure | Engine** column to highlight actionable signals. This prevents visual noise and makes opportunities instantly recognizable.

| Column | Description |
| :--- | :--- |
| **Symbol** | Ticker. Green text = CALL setup. Red text = PUT setup. |
| **Score** | 0–100 composite score. Muted display — high score alone does NOT mean "trade now". |
| **Signal** | Environment classification (see Signal Labels below). |
| **Setup** | Pattern detected (Perfect Storm, Breakout, Pullback Buy, etc.) + star confidence rating (⭐⭐⭐ = highest). |
| **MB / Bx-S / Bx-L / EMA** | Raw indicator values. Green = bullish, Red = bearish. Muted color intentionally. |
| **RVOL** | Relative volume. Color = text only: 🟢 Lime = strong, Teal = ok, Gray = low, 🔴 Red = danger. |
| **ADX · HV** | ADX trend strength + Historical Volatility percentile (Lo/Mid/Hi). HV drives credit vs. debit routing. |
| **Structure \| Engine** | **⬅ THE ONLY COLUMN THAT MATTERS**. Highlighted when actionable: 🟩 CALL strategy, 🟥 PUT strategy, 🟣 Iron Condor. Dim/dark = Wait state. |

---

## 🚦 Signal Labels

### Actionable Signals (Structure column will be HIGHLIGHTED)
| Signal | Meaning |
| :--- | :--- |
| `🟢 STR BUY 🔥` | Perfect high-confidence CALL setup. All indicators firing. |
| `🟢 BUY 💎` | Strong CALL setup with cheap IV (great for debit spreads). |
| `🟡 BUY` | Moderate CALL signal — valid but not premium quality. |
| `🔴 STR SELL 🔥` | High-confidence PUT: trending down + RVOL ≥ 1.0 + below EMA50. |
| `🔴 SELL` | Valid PUT signal — strong score but slightly below peak thresholds. |
| `🟡 SELL` | Moderate PUT: RVOL ≥ 0.8 + below EMA50. Starter size only. |

### Blocked / Wait Signals (Structure column will be DIM — do NOT trade)
| Signal | Meaning | Action |
| :--- | :--- | :--- |
| `⬆️ PULLBACK` | Weekly score > 62. Very strong bull trend — this is a healthy dip, NOT a breakdown. | Wait or look for CALL rebound entry. |
| `⚡ REBOUND RISK` | Weekly score 55–62. Bull trend softening. Shorts are still extremely risky. | Extreme caution. No position. |
| `🟡 BRKDWN WATCH` | Weekly score 52–55. Close to flip. Watch for RVOL confirmation. | One more signal and system will release. Monitor closely. |
| `🐻 BEAR TREND` | Weekly score < 38. Weekly deeply bearish — CALL setups are low-probability. | Do not buy calls. |
| `⚡ RALLY RISK` | Weekly score 38–45. Bearish but could bounce. | No directional bias. |
| `👀 NEUT WATCH` | Weekly score 45–52. Weekly near neutral — cautious setup forming. | Watch for confirmation. |
| `⚠️ OVEREXT` | Price > 3σ from EMA — severely overextended. | Wait for mean reversion. |
| `👀 WATCH · CALL/PUT` | Score below threshold or conflicting internal conditions. | Not ready. |
| `❌ AVOID` | No directional edge. Contradictory signals. | Skip entirely. |

---

## 🛡️ Asymmetric PUT Signal Filters (v3.3)

Because US equities have an inherent **bullish drift**, PUT signals are held to stricter standards than CALL signals:

| Guard | Condition | Effect |
| :--- | :--- | :--- |
| **Weekly MTF Guard** | Weekly score > 52 | PUT blocked → tiered PULLBACK/REBOUND RISK/BRKDWN WATCH label |
| **RVOL Guard** | PUT requires RVOL ≥ 0.8 (min) / ≥ 1.0 (STR SELL) | Low-volume drops are rejected — they're traps |
| **EMA 50 Guard** | Price still above EMA 50 | PUT downgraded to `👀 WATCH · PUT` — no downtrend confirmed |

> **Why this matters**: A stock can score 100 and still show `⬆️ PULLBACK`. This means the algo sees a strong downtrend on the daily, but the weekly is still bullish. History shows these are the most common PUT traps — earnings recovery, weekly support, institutional accumulation zones.

---

## 📈 Backtest Module

The **Accuracy Table** (top-right corner) shows historical forward expectancy for each strategy type on the **current chart symbol**.

### How it works
- Every time the system would have recommended an **actionable strategy** (Structure column highlighted), it records the entry price.
- After **14 bars** and **30 bars**, it evaluates whether the trade succeeded.
- Only signals with a valid Structure recommendation are counted (⏳ Wait and ⚠️ Block states are excluded).

### Table Columns
| Column | Description |
| :--- | :--- |
| **Count** | Number of completed trades recorded for this category |
| **Win 14d** | % of trades profitable after 14 bars |
| **Move 14d** | Average directional return after 14 bars |
| **Win 30d** | % of trades profitable after 30 bars |
| **Move 30d** | Average directional return after 30 bars |

### Table Rows
| Row | What it includes |
| :--- | :--- |
| **OVERALL** | All strategies combined: CALL + PUT + Iron Condor |
| **CALL Only** | Only CALL-direction strategies (Debit Call Spread, Long Call, Credit Put Spread) |
| **PUT Only** | Only PUT-direction strategies (filters exclude above-EMA50, RVOL < 0.8, MTF conflict) |
| **I.CONDOR** | Iron Condor recommendations. Success = price stays within ±4.5% (14d) / ±5.5% (30d) |
| **FILTERED** | Subset filtered by `Setup` type (configurable in Settings) |

> **Iron Condor Move**: Avg Move for IC represents absolute price drift from entry, not directional return. A lower Move = better for IC.

---

## ⚙️ Configuration & Inputs

### Scanner Settings
| Setting | Default | Description |
| :--- | :--- | :--- |
| Watchlist | 25 tickers | Comma-separated list. Max 40. |
| Min Score | 60 | Minimum score to display a ticker in the table. |
| Max Display | 15 | Maximum rows shown. |
| Show PUTs / CALLs | true | Toggle to filter direction shown. |

### Enhancement Filters
| Setting | Default | Description |
| :--- | :--- | :--- |
| RVOL Threshold | 1.3× | Volume required for a "Full Credit" RVOL signal on breakouts. |
| Max RVOL (Pullback) | 1.0× | Volume ceiling for a valid healthy pullback (high volume pullbacks = distribution). |
| ADX Trend Thresh | 25 | ADX above this = Trend regime. |
| ADX Range Thresh | 20 | ADX below this = Range regime (favors Iron Condor). |
| HV High Thresh | 75th pct | Above this = expensive IV → prefer selling premium. |
| HV Low Thresh | 25th pct | Below this = cheap IV → prefer buying premium. |
| MTF Score Floor | 45 | Weekly score below this blocks CALL signals. |
| Earnings Window | 10 days | Blocks credit/debit strategies when earnings approach. |

### Backtest Settings
| Setting | Default | Description |
| :--- | :--- | :--- |
| Enable Backtest | true | Toggle the Accuracy table display. |
| Look-forward 1 | 14 bars | First evaluation window. |
| Look-forward 2 | 30 bars | Second evaluation window. |
| Setup Filter | All | Filter backtest to a specific setup type. |
| Min Score (Backtest) | 75 | Score gate for backtest inclusion. |

---

## 🛑 Structure Column Quick Reference

When the **Structure | Engine** cell is:

| Appearance | Meaning | Action |
| :--- | :--- | :--- |
| 🟩 **Green background** | CALL strategy ready | Trade via Option Selector |
| 🟥 **Red background** | PUT strategy ready | Trade via Option Selector |
| 🟣 **Purple background** | Iron Condor ready | Trade via Option Selector |
| ⬛ Dark / dim text | Wait state active | Do NOT trade — read the wait reason |

**Wait state prefixes:**
- `⏳` = Trend/volume/regime not confirmed yet — just wait
- `⚠️` = Risk warning (overextended, earnings approaching, mean reversion risk)
- `⬆️ / 🐻 / ⚡` = Weekly MTF conflict — tiered warning (see Signal Labels above)
