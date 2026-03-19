/**
 * Input validation utilities for API query params.
 */

/**
 * Parse and validate a numeric query param within bounds.
 * Returns the parsed number, or the default if missing/invalid.
 * @param {string|undefined} value - raw query param
 * @param {number} min - minimum allowed value
 * @param {number} max - maximum allowed value
 * @param {number} defaultVal - fallback if missing or out of range
 * @returns {number}
 */
export function clampNum(value, min, max, defaultVal) {
    if (value == null || value === '') return defaultVal;
    const num = Number(value);
    if (!Number.isFinite(num)) return defaultVal;
    return Math.max(min, Math.min(max, num));
}

/**
 * Validate cron auth via Authorization header only.
 * Returns null if authorized, or a 401 response object if not.
 * @param {import('http').IncomingMessage} req
 * @returns {{ status: number, body: object } | null}
 */
export function verifyCronAuth(req) {
    const secret = req.headers['authorization']?.replace('Bearer ', '');
    const expectedSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
    if (expectedSecret && secret !== expectedSecret) {
        return { status: 401, body: { error: 'Unauthorized' } };
    }
    return null;
}
