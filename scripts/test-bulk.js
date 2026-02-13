// scripts/test-bulk.js - run from project root: node scripts/test-bulk.js
import handler from '../api/option-prices-bulk.js';

// Mock Req/Res
const req = {
    method: 'POST',
    body: {
        legs: [
            { ticker: 'SPY', expiration: '2025-12-19', strike: 500, type: 'Call', id: 'pos1' },
            { ticker: 'QQQ', expiration: '2025-12-19', strike: 400, type: 'Put', id: 'pos2' }
        ]
    }
};

const res = {
    setHeader: () => { },
    status: (code) => {
        console.log(`Status: ${code}`);
        return res;
    },
    json: (data) => {
        console.log("Response:", JSON.stringify(data, null, 2));
        return res;
    }
};

async function run() {
    console.log("--- Running Bulk Test ---");
    // Mock process.env（Polygon 或 CBOE；需 POLYGON_API_KEY 时请先加载 .env.local）
    process.env.DATA_SOURCE = process.env.DATA_SOURCE || 'POLYGON';

    // Attempt to run handler
    try {
        await handler(req, res);
    } catch (e) {
        console.error("Handler Error:", e);
    }
}

run();
