// Quick test: Does strategy-recommend work with MarketData?
import handler from './api/strategy-recommend.js';

// Mock request/response
const req = {
    method: 'GET',
    query: {
        ticker: 'SPY',
        direction: 'BULL',
        dte: '30'
    }
};

const res = {
    statusCode: 200,
    headers: {},
    setHeader(key, value) {
        this.headers[key] = value;
    },
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(data) {
        console.log(JSON.stringify(data, null, 2));
        process.exit(0);
    },
    end(data) {
        console.log(data);
        process.exit(0);
    }
};

console.log('Testing strategy-recommend with MarketData...');
handler(req, res).catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
