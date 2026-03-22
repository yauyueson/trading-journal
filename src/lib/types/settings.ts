// src/lib/types/settings.ts

export interface PortfolioSettings {
  accountSize: number;
  riskPct: number;
  /** Exit when loss reaches this % of max loss (e.g. 50 = stop at 50% of max loss) */
  stopOutPct: number;
  /** Minimum open interest to show a contract in spread builder (default 50) */
  minOpenInterest: number;
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

export interface CreditSpreadConfig {
  signalPreset: string;
  defaultDelta: number;
  defaultWidth: number;
  dteMin: number;
  dteMax: number;
  dtePeak: number;
  profitTarget: number;
  ivRankMin: number;
  timeStopDTE: number;
  maxPositions: number;
  maxPerTicker: number;
  adxGate: number | null;
  rvolGate: number;
  minScore: number;
  minDirConfidence: number;
}

export interface StrategySettings {
  tpAtr: number;
  slAtr: number;
  minScore: number;
  thetaDecayRate: number;
  deployedAt: string;    // ISO timestamp
  source: string;        // 'manual' | 'ga-optimize' | 'sweep' | 'walk-forward'
}

export interface AppSettings {
  portfolio: PortfolioSettings;
  techScore: TechScoreSettings;
  strategy: StrategySettings;
  creditSpread?: {
    swing: CreditSpreadConfig;
    shortTerm: CreditSpreadConfig;
  };
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  portfolio: {
    accountSize: 5700,
    riskPct: 1,
    stopOutPct: 50,
    minOpenInterest: 50,
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
  strategy: {
    tpAtr: 2.5,
    slAtr: 1.5,
    minScore: 70,
    thetaDecayRate: 0.03,
    deployedAt: '',
    source: 'manual',
  },
  creditSpread: {
    swing: {
      signalPreset: 'vol',
      defaultDelta: 0.35,
      defaultWidth: 20,
      dteMin: 45,
      dteMax: 65,
      dtePeak: 55,
      profitTarget: 0.40,
      ivRankMin: 0,
      timeStopDTE: 3,
      maxPositions: 5,
      maxPerTicker: 3,
      adxGate: null,
      rvolGate: 0.5,
      minScore: 70,
      minDirConfidence: 70,
    },
    shortTerm: {
      signalPreset: 'vol',
      defaultDelta: 0.35,
      defaultWidth: 5,
      dteMin: 7,
      dteMax: 21,
      dtePeak: 14,
      profitTarget: 0.30,
      ivRankMin: 0,
      timeStopDTE: 1,
      maxPositions: 5,
      maxPerTicker: 2,
      adxGate: null,
      rvolGate: 0.5,
      minScore: 70,
      minDirConfidence: 0,
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
