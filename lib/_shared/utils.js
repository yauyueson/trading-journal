// lib/_shared/utils.js

/**
 * Generate OCC Option Symbol
 * Format: TICKERYYMMDD[C/P]STRIKE (6+6+1+8 = 21 chars)
 * @param {string} symbol Underlying Ticker
 * @param {string} expiration YYYY-MM-DD
 * @param {string} type 'Call' or 'Put'
 * @param {string|number} strike Strike Price
 * @returns {string|null}
 */
export function generateOCCSymbol(symbol, expiration, type, strike) {
    try {
        const paddedSymbol = symbol.toUpperCase().padEnd(6, ' ');
        const parts = expiration.split('-');
        if (parts.length !== 3) throw new Error('Invalid date format');

        const yy = parts[0].slice(2);
        const mm = parts[1].padStart(2, '0');
        const dd = parts[2].padStart(2, '0');
        const dateStr = `${yy}${mm}${dd}`;

        const loweredType = type.toLowerCase();
        const typeCode = (loweredType.includes('call') || loweredType === 'c') ? 'C' : 'P';
        const strikeNum = Math.round(parseFloat(strike) * 1000);
        const strikeStr = strikeNum.toString().padStart(8, '0');

        return `${paddedSymbol}${dateStr}${typeCode}${strikeStr}`;
    } catch (e) {
        console.error("OCC Generation Error:", e);
        return null;
    }
}

/**
 * Find an option's mid price from an options array (ORATS or CBOE format).
 * @param {Array} options Option chain array
 * @param {string} ticker Underlying ticker
 * @param {string} expiration YYYY-MM-DD
 * @param {string|number} strike Strike price
 * @param {string} type 'Call' or 'Put'
 * @returns {number|null}
 */
export function findOptionMid(options, ticker, expiration, strike, type) {
    if (!options || !Array.isArray(options) || options.length === 0) return null;

    const isORATS = options[0].symbol !== undefined && options[0].strike !== undefined;

    if (isORATS) {
        const targetStrike = parseFloat(strike);
        const targetType = (type || 'Call').toLowerCase().includes('call') ? 'Call' : 'Put';
        const expStr = expiration.slice(0, 10);

        const match = options.find(opt =>
            Math.abs(opt.strike - targetStrike) < 0.01 &&
            opt.type === targetType &&
            opt.expiration === expStr
        );

        if (!match) return null;
        if (match.bid > 0 && match.ask > 0) return (match.bid + match.ask) / 2;
        if (match.last > 0) return match.last;
        return null;
    }

    // CBOE format: OCC symbol matching
    const occ = generateOCCSymbol(ticker, expiration, type || 'Call', strike);
    if (!occ) return null;
    const cboeSymbol = occ.replace(/\s/g, '');

    let match = options.find(o => o.option === cboeSymbol);

    if (!match) {
        const expDateStr = expiration.replace(/-/g, '').slice(2);
        const typeCode = (type || 'Call').toLowerCase().includes('call') ? 'C' : 'P';
        const strikeStr = Math.round(parseFloat(strike) * 1000).toString().padStart(8, '0');
        match = options.find(o => {
            if (!o.option) return false;
            const sym = o.option.replace(/\s/g, '');
            return sym.includes(expDateStr) && sym.charAt(12) === typeCode && sym.endsWith(strikeStr);
        });
    }

    if (!match) return null;
    if (match.bid > 0 && match.ask > 0) return (match.bid + match.ask) / 2;
    if (match.last_trade_price > 0) return match.last_trade_price;
    return null;
}

/**
 * Normalize expiration date string to YYYY-MM-DD
 * @param {string} exp 
 * @returns {string}
 */
export function normalizeExpiration(exp) {
    if (!exp || typeof exp !== 'string') return exp;
    const s = exp.trim();
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashMatch) {
        const [, mm, dd, yyyy] = slashMatch;
        return `${yyyy}-${String(parseInt(mm, 10)).padStart(2, '0')}-${String(parseInt(dd, 10)).padStart(2, '0')}`;
    }
    return s;
}
