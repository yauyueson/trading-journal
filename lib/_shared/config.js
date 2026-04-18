// lib/_shared/config.js
// Shared configuration constants for API routes.

export const DATA_SOURCE = (process.env.DATA_SOURCE || 'ORATS').trim().toUpperCase();

export const SCAN_TICKERS = [
    'SPY', 'QQQ', 'GOOGL', 'JPM', 'META', 'TSLA', 'MSFT', 'NFLX',
    'AAPL', 'NVDA', 'AMD', 'COST', 'IREN', 'BA', 'AMZN', 'HOOD',
    'CRWV', 'COIN', 'MSTR', 'PLTR', 'AVGO', 'LULU', 'UBER', 'GS',
    'UNH', 'IWM', 'GLD',
    // 2026-04-18: expanded research universe additions (9 new tickers)
    'CRM', 'ORCL', 'CRWD', 'SHOP', 'PANW', 'ANET', 'VRT', 'ARM', 'NOW',
];
