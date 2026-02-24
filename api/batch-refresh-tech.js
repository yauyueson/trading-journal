// Initialize Supabase Client
// function getSupabase() {
//     const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
//     const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
//     if (!url || !key) throw new Error("Missing Supabase credentials");
//     return createClient(url, key);
// }

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { scope = 'active', limit = 50 } = req.body || req.query || {};
    // scope: 'active' (open positions), 'watchlist', 'all'

    return res.status(200).json({ message: 'Tech score calculation is disabled.', processed: 0 });
}
