// api/_shared/utils.js

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
