// api/strategy-config.js
// GET: return strategy config JSON
// POST (CRON_SECRET auth): update config JSON

import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(process.cwd(), 'data', 'strategy-config.json');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method === 'GET') {
        try {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
            const config = JSON.parse(raw);
            return res.status(200).json(config);
        } catch (err) {
            console.error('[strategy-config] Failed to read config:', err.message);
            return res.status(500).json({ error: 'Failed to read strategy config' });
        }
    }

    if (req.method === 'POST') {
        const secret = req.headers['authorization']?.replace('Bearer ', '');
        const expectedSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
        if (!expectedSecret || secret !== expectedSecret) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        try {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            if (!body || !body.profiles) {
                return res.status(400).json({ error: 'Invalid config: missing profiles' });
            }
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(body, null, 2) + '\n', 'utf-8');
            return res.status(200).json({ ok: true, version: body.version });
        } catch (err) {
            console.error('[strategy-config] Failed to write config:', err.message);
            return res.status(500).json({ error: 'Failed to write strategy config' });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
