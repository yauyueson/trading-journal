// scripts/backfill-local.js
import handler from '../api/backfill-iv-history.js';

// Mock Req/Res
const req = {
    method: 'GET',
    query: { mode: 'popular' } // or { ticker: 'SPY,QQQ' }
};

const res = {
    setHeader: () => { },
    status: (code) => ({
        json: (data) => {
            console.log(`Response [${code}]:`, JSON.stringify(data, null, 2));
            return data;
        },
        end: () => { }
    })
};

// Run
console.log('Running backfill locally...');
handler(req, res).catch(console.error);
