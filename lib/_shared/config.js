// lib/_shared/config.js
// Shared configuration constants for API routes.

export const DATA_SOURCE = (process.env.DATA_SOURCE || 'ORATS').trim().toUpperCase();

export const SCAN_TICKERS = [
    'SPY', 'QQQ', 'GOOGL', 'JPM', 'META', 'TSLA', 'MSFT', 'NFLX',
    'AAPL', 'NVDA', 'AMD', 'COST', 'IREN', 'BA', 'AMZN', 'HOOD',
    'CRWV', 'COIN', 'MSTR', 'PLTR', 'AVGO', 'LULU', 'UBER', 'GS',
    'UNH', 'IWM', 'GLD',
];
