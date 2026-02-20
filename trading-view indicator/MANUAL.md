# MB_DFP_Options_Scanner v3.2 - User Manual

The `MB_DFP_Options_Scanner_v3.2` is a robust Pine Script indicator designed exclusively for the Trading Journal web application. It acts as the primary analytical engine for the Trading Journal, completely taking over the workload of identifying the best setup and matching the ideal options strategy architecture.

This scanner combines Market Bias, B-Xtrender (Short & Long), an EMA Stack, Volume Contraction (RVOL), and historical volatility (HV/RV) to detect, parse, and score market environments. 

## 🔄 The New Workflow: Indicator -> Web UI 

Unlike previous versions of the Trading Journal that computed combinations of all possible option strategies for a given ticker, the **Trading Journal Web UI has been fully refactored to act strictly as an "Option Selector".** 

**The TradingView Indicator is now the definitive source of truth.** You must start every trade here.

### Step 1: Discover on TradingView
1. Attach the `MB_DFP_Options_Scanner_v3.2.pine` indicator to your chart in TradingView.
2. The scanner table will display a list of tickers, scores, setups, and recommended structures.
3. Once you identify a high-probability trade (e.g., Score > 80, favorable RVOL), take note of three critical fields:
   * **Ticker**: (e.g., `QQQ`)
   * **Setup**: (e.g., `Pullback Buy`)
   * **Target Strategy / Structure**: (e.g., `Credit Put Spread`)

### Step 2: Plug into Option Selector (Web UI)
1. Open your Trading Journal Web UI and go to the **Option Selector** page.
2. Enter the **Ticker**, set the general **Direction** (BULL/BEAR based on TV), and enter your **Target DTE**.
3. *Crucially*, enter the exact **Target Strategy** and **Setup** that TradingView gave you.
4. Click **Scan Options**.

### Step 3: Analyze Options Chains
1. The Trading Journal Web UI now acts purely as a "靶向期权筛选" (Targeted Option Selector). It will directly fetch only the requested options structure (e.g., only Credit Put Spreads).
2. It will apply complex Greeks calculations, risk-reward algorithms, constraint filtering, and calculate a `Unified Score` ranging from 0-100 for every vertical combination within the chain.
3. Review the top-scored exact strike coordinates, click `Add to Watchlist`, and note that the TradingView parameters (Setup / Strategy) are perfectly inherited.

---

## 🔍 How the TradingView Scanner Works

### Algorithm & Scoring Modules (0-100)
The indicator calculates a unified `Score` out of 100 based on moving averages and oscillators:
1. **Market Bias (30%)**: Analyzes trend momentum via smoothed Heikin Ashi oscillations.
2. **B-Xtrender Short (30%)**: Shorter timeframe MACD/RSI derivative. Evaluates overbought/oversold fast bounces.
3. **B-Xtrender Long (15%)**: Longer timeframe baseline.
4. **EMA Stack (15%)**: Ensures multiple timeframe direction alignment (8, 21, 34 EMAs).
5. **Momentum (10%)**: Validates candle structural velocity (Price ROC).

### Data Columns Explained

| Column Name | Description |
| :--- | :--- |
| **Symbol/Score** | Ticker and final calculated score. Green backgrounds denote premium setups (≥ 85). |
| **Signal/Setup** | The environment detected (e.g. `Strong BUY`, `Pullback Buy`). |
| **Indicators** | The raw outputs (MB, Bx-S, Bx-L, EMA) showing specifically what component is firing. |
| **RVOL** | `Relative Volume`. Confirms participation. Breakouts require high RVOL; Pullbacks prefer fading RVOL. |
| **ADX·HV** | `Average Directional Index` (trend strength) and `Historical Volatility`. `Hi/Lo` dictates if you should buy or sell premium. |
| **Structure\|Engine** | ***THE MOST IMPORTANT COLUMN***. This tells you exactly what Options Strategy works best in this specific environment (e.g., `Credit Put Spread💰`, `Long Call🎯`). |

### Volatility Filters & Strategy Routing
The engine relies on Historical Volatility envelopes to route the play to the correct Option Strategy:

- **High HV (Hi):** Recommends selling premium. You will generally see `Credit Put Spread` or `Credit Call Spread` recommendations. Takes advantage of IV Crush.
- **Normal/Low HV:** Recommends buying premium. You will generally see `Debit Call Spread` or `Long Call`/`Long Put`. Avoids selling cheap premium into expanding environments.

### Volume Analytics
A critical update in v3.2 involves robust Volume Contraction validation using RVOL:
- Breakout & Breakdown setups **require** `has_vol` (RVOL ≥ Threshold).
- Pullback & Divergence setups are allowed or preferred without heavy expansion volume.

---

## ⚙️ Configuration & Inputs

Inside the TradingView `Settings` for this indicator, you can configure:

* **Scanner Tickers**: Up to 40 custom tickers separated by commas.
* **Component Weights**: Tweak exactly how heavily the `Score` relies on Market Bias vs B-Xtrender.
* **Overextension Multiplier**: The z-score threshold used to define when to label a stock as over-extended. If triggered, it suppresses the structure recommendation to prevent chasing.
* **RVOL Threshold**: Minimum Volume multiplier required for Breakout/Breakdown validations (default is `1.2x` average volume).

## 🛑 Warnings & Wait States
If the environment is muddled, the **Structure** column will spit out a wait state. Do NOT trade these via the Option Selector until the setup validates.

* `⏳ ADX<25`: Price is chopping, no direction trend confirmed.
* `⏳ Low RVOL`: Breakout attempting, but big money isn't participating. Wait for volume to confirm.
* `⏳ Weak setup`: The technical score is acceptable, but the environment contradicts it (Range regime). No edge. 
