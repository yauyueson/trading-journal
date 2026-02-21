# MB_DFP_Options_Scanner v3.2 — User Manual
> **Last Updated**: 2026-02-19 | Current Build: **v3.3**

The `MB_DFP_Options_Scanner_v3.2` is a Pine Script indicator that acts as the **primary signal generator** for the Trading Journal workflow. It identifies high-probability options setups by scoring market environments across multiple dimensions, then routes each setup to the most appropriate options structure (Credit Spread, Debit Spread, Long, Iron Condor, etc.).

---

## 🔄 Workflow: TradingView → Web UI

**The TradingView Indicator is the definitive source of truth.** Every trade starts here.

### Step 1: Discover on TradingView
1. Attach `MB_DFP_Options_Scanner_v3.2` to any chart.
2. The scanner table shows tickers ranked by Score. Look at the right half of the table for actionable setups (indicated by a non-blank **Direction** column and colored **Score Tier**).
3. Read the explicitly listed platform input columns from left to right:
   - **Score Tier** (e.g., `S (90+)`)
   - **Setup** (e.g., `Strong Down`)
   - **Direction** (e.g., `BEAR`)
   - **Market State** (e.g., `TRENDING`)
   - **Risk Flags** (e.g., `Hi Vol`)

### Step 2: Plug into Strategy Recommender (Web UI)
1. Open the **Strategy Recommender** page.
2. Enter the data exactly as read from the scanner table (Direction, Setup, Market State, Risk Flags).
3. Keep the Target Strategy dropdown on **Auto-Select Strategy**.
4. Click **Analyze Strategy**.

### Step 3: Analyze & Execute
1. The Web UI's Options Architect engine fetches the exact options chain and scores every spread combination across all strategy types.
2. Review the top-5 recommended structures, compare the risk-reward profiles, and execute the trade in your broker.

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
| **Symbol** | Ticker symbol. Green text = CALL setup. Red text = PUT setup. |
| **MB / Bx-S / Bx-L / EMA** | Raw indicator values showing oscillator alignment and trend structural health. Muted colors to reduce noise. |
| **RVOL** | Relative volume vs 20-day average. 🟢 Lime > 1.3x, Teal > 1.0x, Gray > 0.8x. |
| **Score Tier** | Grade of the setup from D to S (90+). Highlights in Green/Red for actionable signals. |
| **Setup** | The exact structural pattern detected (e.g. Breakout, Pullback Buy, Strong Down). Enter this in the Web App. |
| **Direction** | BULL, BEAR, or blank. Shows the side of the market the setup is leaning toward. Enter this in the Web App. |
| **Market State** | Explicitly derived regime from ADX, oscillators, and volatility (e.g. TRENDING, RANGING, EXPLOSIVE, REVERTING). Enter this in the Web App. |
| **Risk Flags** | Contains any structural warnings or blockers from Pine Script (e.g., ⚠️ OverExt, ⬆️ MTF Conflict, Hi Vol, ER Blocked). Check the corresponding boxes in the Web App. |

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

The **Accuracy Table** (configurable position) shows historical forward expectancy for each strategy type on the **current chart symbol**. It contains two sub-modules that work together.

---

### Sub-Module 1: Time-Based Windows (14d / 30d)

**How it works:**
- Every time the system issues an **actionable strategy recommendation** (Structure column highlighted), it records the entry price.
- After exactly **14 bars** and **30 bars**, it checks whether the trade was profitable.
- Only signals with a valid Structure recommendation are counted — `⏳ Wait` and `⚠️ Block` states are excluded entirely.

**Table Rows:**
| Row | What it includes |
| :--- | :--- |
| **OVERALL** | All strategies combined: CALL + PUT + Iron Condor |
| **CALL Only** | CALL-direction strategies (Debit Call Spread, Long Call, Credit Put Spread) |
| **PUT Only** | PUT strategies after asymmetric filters (EMA50, RVOL, MTF guards applied) |
| **I.CONDOR** | Iron Condor recommendations. Success = price stays within ±4.5% (14d) / ±5.5% (30d) |
| **FILTERED** | Subset filtered by Setup type (configurable via `Setup Filter` setting) |

**Table Columns:**
| Column | Description |
| :--- | :--- |
| **Count** | Number of signals recorded for this category |
| **Win 14d** | % of trades profitable after exactly 14 bars |
| **Move 14d** | Average directional return after 14 bars (PUT = -move = profit if stock fell) |
| **Win 30d** | % of trades profitable after exactly 30 bars |
| **Move 30d** | Average directional return after 30 bars |

> ⚠️ **Limitation**: Time-based windows don't account for early exits. A trade that peaked at +8% on day 5 then fell to -2% by day 14 is counted as a **loss**, even though you would have taken profit. This is solved by Sub-Module 2.

---

### Sub-Module 2: TP/SL Simulation (Realistic Exit Modeling)

This module simulates what happens when you **actively manage** your position with real take-profit and stop-loss orders. On every bar after entry, it checks if price has crossed either boundary.

**How it works:**
- **CALL trade** → exits when `high ≥ entry × (1 + TP%)` or `low ≤ entry × (1 - SL%)`
- **PUT trade** → exits when `low ≤ entry × (1 - TP%)` or `high ≥ entry × (1 + SL%)`
- **IC trade** → exits when `|drift| ≤ IC_TP%` (still in range = win) or `|drift| ≥ IC_SL%` (broke out = loss)

**Configuration (Settings → TP/SL Simulation):**
| Setting | Default | Description |
| :--- | :--- | :--- |
| Enable TP/SL Simulation | true | Toggle the 4 TP/SL rows |
| Take Profit % | **7%** | Underlying move required for a win exit |
| Stop Loss % | **4%** | Underlying move against you before stop-loss exit |
| IC Take Profit % | **3.5%** | IC profit threshold: price drift ≤ 3.5% = win |
| IC Stop Loss % | **6%** | IC stop threshold: price drift ≥ 6% = loss |

**TP/SL Table Rows (highlighted in color):**
| Row | Background | What it shows |
| :--- | :--- | :--- |
| `TP7/SL4 ALL` | 🟨 Yellow | All strategies combined TP/SL performance |
| `TP7/SL4 CALL` | 🟩 Green | Only CALL direction TP/SL performance |
| `TP7/SL4 PUT` | 🟥 Red | Only PUT direction TP/SL performance |
| `TP7/SL4 IC` | 🟣 Purple | Iron Condor TP/SL performance |

**TP/SL Row Columns:**
| Column | Description |
| :--- | :--- |
| **Count** | Total trades that hit either TP or SL |
| **Win %** | TP hits / (TP + SL hits) |
| **Avg Return** | Weighted average: `(wins × TP%) - (losses × SL%)` / count |
| **TP:xxx** | Raw count of Take Profit exits |
| **SL:xxx** | Raw count of Stop Loss exits |

**How to read the TP/SL data strategically:**

> Example from AMZN: `Win 14d = 39.7%` vs `TP7/SL4 ALL = 73%`

This gap tells you:
1. **The signal direction is correct** 73% of the time — the stock DOES move favorably.
2. **But you're holding too long** — by day 14, many winners have reversed.
3. **Optimal exit strategy**: Set a GTC limit order at +7% and a stop at -4% immediately after entry.
4. **Expected value** = `(0.73 × 7%) - (0.27 × 4%) = +4.03%` per trade on average.

**Using TP/SL to compare CALL vs PUT performance:**
- If `CALL TP/SL Win%` >> `PUT TP/SL Win%` → confirms bullish drift advantage, be more selective with PUTs
- If both are above 60% → signal quality is genuinely strong in both directions
- If `IC TP/SL Win%` >> directional — the stock is better suited for premium selling strategies

**Calibrating your TP/SL:**
- Increase TP% and observe if Win% drops significantly → means most winners don't run that far
- Decrease SL% and observe if SL count spikes → means you're cutting too early on normal volatility
- The optimal ratio for most US large-cap is approximately **TP = 1.5-2× SL** (e.g., TP 7% / SL 4%)

---

### Backtest Settings Reference
| Setting | Default | Description |
| :--- | :--- | :--- |
| Enable Backtest | true | Toggle the Accuracy table |
| Table Position | bottom_right | Where to display the table |
| Short Look-forward | 14 bars | First evaluation window |
| Long Look-forward | 30 bars | Second evaluation window |
| Min Score to Track | 75 | Score gate for backtest inclusion |
| Setup Filter | All | Narrow backtest to a specific setup type |

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
