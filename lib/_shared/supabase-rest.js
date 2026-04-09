// lib/_shared/supabase-rest.js
// Shared Supabase REST API helpers for serverless API routes.

export function getSupabaseConfig() {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    return { url, anonKey, serviceKey };
}

/**
 * GET rows from a Supabase table via REST API.
 * @param {string} table Table name
 * @param {string} [queryParams] URL query string (e.g. 'status=eq.active&select=*')
 * @returns {Promise<Array|null>}
 */
export async function supabaseGet(table, queryParams) {
    const { url, anonKey } = getSupabaseConfig();
    if (!url || !anonKey) return null;
    const endpoint = `${url}/rest/v1/${table}${queryParams ? '?' + queryParams : ''}`;
    const res = await fetch(endpoint, {
        headers: { 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}` },
    });
    if (!res.ok) return null;
    return res.json();
}

/**
 * GET rows from a Supabase table via REST API — throws on error.
 * Use in API routes wrapped in try/catch (vs supabaseGet which returns null).
 * @param {string} table Table name
 * @param {string} [queryParams] URL query string (e.g. 'status=eq.active&select=*')
 * @returns {Promise<Array>}
 */
export async function supabaseQuery(table, queryParams) {
    const { url, anonKey } = getSupabaseConfig();
    if (!url || !anonKey) throw new Error('Supabase env not set');
    const endpoint = `${url}/rest/v1/${table}${queryParams ? '?' + queryParams : ''}`;
    const res = await fetch(endpoint, {
        headers: {
            'apikey': anonKey,
            'Authorization': `Bearer ${anonKey}`,
            'Content-Type': 'application/json',
        },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase ${table} query failed: ${res.status} ${text}`);
    }
    return res.json();
}

/**
 * Upsert rows into a Supabase table via REST API.
 * Uses service role key if available, falls back to anon key.
 * @param {string} table Table name
 * @param {Array|Object} rows Row(s) to upsert
 * @param {string} [caller] Caller name for log context
 * @returns {Promise<boolean>} true if successful
 */
export async function supabaseUpsert(table, rows, caller = '') {
    const { url, anonKey, serviceKey } = getSupabaseConfig();
    const key = serviceKey || anonKey;
    if (!url || !key) return false;
    const res = await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify(rows),
    });
    if (!res.ok) {
        const text = await res.text();
        console.warn(`[${caller || 'supabase'}] Upsert ${table} failed: ${res.status} ${text}`);
        return false;
    }
    return true;
}
