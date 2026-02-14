// src/lib/types/settings.ts

export interface PortfolioSettings {
  accountSize: number;
  riskPct: number;
  /** Exit when loss reaches this % of max loss (e.g. 50 = stop at 50% of max loss) */
  stopOutPct: number;
}

export interface TechScoreWeights {
  w_mb: number;
  w_bxs: number;
  w_bxl: number;
  w_ema: number;
  w_mom: number;
}

export interface TechScorePeriods {
  sc_mb_len: number;
  sc_mb_smoothing: number;
  sc_osc_len: number;
  sc_bx_s1: number;
  sc_bx_s2: number;
  sc_bx_s3: number;
  sc_bx_l1: number;
  sc_bx_l2: number;
}

export interface TechScoreSettings {
  weights: TechScoreWeights;
  periods: TechScorePeriods;
}

export interface AppSettings {
  portfolio: PortfolioSettings;
  techScore: TechScoreSettings;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  portfolio: {
    accountSize: 5700,
    riskPct: 1,
    stopOutPct: 50,
  },
  techScore: {
    weights: { w_mb: 30, w_bxs: 25, w_bxl: 20, w_ema: 15, w_mom: 10 },
    periods: {
      sc_mb_len: 100,
      sc_mb_smoothing: 100,
      sc_osc_len: 7,
      sc_bx_s1: 5,
      sc_bx_s2: 20,
      sc_bx_s3: 15,
      sc_bx_l1: 20,
      sc_bx_l2: 15,
    },
  },
};

// Validation bounds
export const PORTFOLIO_BOUNDS = {
  MIN_RISK_PCT: 0.5,
  MAX_RISK_PCT: 10,
  MIN_STOP_OUT_PCT: 20,
  MAX_STOP_OUT_PCT: 80,
} as const;
