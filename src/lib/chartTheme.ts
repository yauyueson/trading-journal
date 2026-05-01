// Centralized chart palette — used by signature pages (Dashboard equity curve,
// PositionCard greeks). Stats / Backtest pages still use their own colors;
// migrate them in a follow-up PR by importing from this file.

export const CHART_COLORS = {
  positive: '#00FF41',
  negative: '#FF2D00',
  warning: '#FFB000',
  neutral: '#868F97',
  grid: 'rgba(0, 255, 65, 0.08)',
  axisLine: 'rgba(0, 255, 65, 0.15)',
  axisText: '#868F97',
  tooltipBg: '#0A0A0A',
  tooltipBorder: 'rgba(0, 255, 65, 0.3)',
  tooltipShadow: '0 0 20px rgba(0, 255, 65, 0.15), 0 8px 32px rgba(0, 0, 0, 0.6)',
} as const;

export const CHART_FONT_MONO = 'DM Mono, monospace';

// Spread Recharts axis props from this. Caller still passes `dataKey` / `tickFormatter`.
export const axisProps = {
  tick: { fill: CHART_COLORS.axisText, fontSize: 11, fontFamily: CHART_FONT_MONO },
  tickLine: false as const,
} as const;

// Multi-series palette — used by research-only Backtest page where we render
// up to ~11 simultaneously distinguishable series (per-ticker equity curves,
// per-spread comparisons). Anchored at phosphor green and walking through
// CRT-friendly tones (amber, dim green, gold, red, etc.) so series stay
// distinguishable without breaking the terminal aesthetic.
export const SERIES_PALETTE: readonly string[] = [
  '#00FF41', // phosphor green
  '#FFB000', // phosphor amber
  '#00CC33', // phosphor dim green
  '#FF8C00', // dimmed amber
  '#FF2D00', // phosphor red
  '#7FFF00', // chartreuse
  '#FFD700', // gold
  '#FF6B35', // amber-red
  '#39FF14', // electric green
  '#FFA500', // orange
  '#DC143C', // crimson
] as const;
