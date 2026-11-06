// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Minimal CBOE delayed-quotes payload: one QQQ call with a two-sided market.
const cboePayload = {
  data: {
    current_price: 659.1,
    options: [
      { option: 'QQQ261218C00701000', bid: 7.72, ask: 7.87, last_trade_price: 7.5, delta: 0.2555, gamma: 0.006, theta: -0.2032, vega: 0.7256, iv: 0.238 },
      { option: 'QQQ270115C00630000', bid: 47.1, ask: 47.9, last_trade_price: 47.0, delta: 0.80, gamma: 0.002, theta: -0.05, vega: 1.5, iv: 0.22 },
    ],
  },
};

function mockRes() {
  const res: any = { statusCode: 0, body: undefined, headers: {} };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.end = () => res;
  return res;
}

const leg701 = { ticker: 'QQQ', expiration: '2026-12-18', strike: 701, type: 'Call', id: 'pm' };
const leg630 = { ticker: 'QQQ', expiration: '2027-01-15', strike: 630, type: 'Call', id: 'pm' };

describe('api/option-prices handler (CBOE)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let handler: (req: any, res: any) => Promise<unknown>;
  let resetCache: () => void;

  beforeEach(async () => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => cboePayload }));
    vi.stubGlobal('fetch', fetchMock);
    const mod: any = await import('../api/option-prices.js');
    handler = mod.default;
    resetCache = mod.__resetCboeCacheForTests;
    resetCache?.();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST with a single leg still returns the bulk envelope', async () => {
    const res = mockRes();
    await handler({ method: 'POST', body: { legs: [leg701] } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results[0]).toMatchObject({ success: true, price: 7.79, priceSource: 'mid', id: 'pm' });
  });

  it('GET single leg keeps the bare-object shape', async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: { ticker: 'QQQ', expiration: '2026-12-18', strike: '701', type: 'Call' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.results).toBeUndefined();
    expect(res.body).toMatchObject({ success: true, price: 7.79 });
  });

  it('POST with two legs returns both', async () => {
    const res = mockRes();
    await handler({ method: 'POST', body: { legs: [leg630, leg701] } }, res);
    expect(res.body.results.map((r: any) => r.price)).toEqual([47.5, 7.79]);
  });

  it('reuses one chain download across back-to-back requests for the same ticker', async () => {
    await handler({ method: 'POST', body: { legs: [leg630, leg701] } }, mockRes());
    await handler({ method: 'GET', query: { ticker: 'QQQ', expiration: '2026-12-18', strike: '701', type: 'Call' } }, mockRes());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Skip the cdn.cboe.com → cdn-api.cboe.com 307 hop.
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://cdn-api.cboe.com/api/global/delayed_quotes/options/QQQ.json');
  });

  it('does not cache failed downloads', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    const first = mockRes();
    await handler({ method: 'POST', body: { legs: [leg701] } }, first);
    expect(first.body.results[0].success).toBe(false);
    const second = mockRes();
    await handler({ method: 'POST', body: { legs: [leg701] } }, second);
    expect(second.body.results[0].success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
