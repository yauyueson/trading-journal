# MarketData Integration - Development Guide

## Quick Reference

### Environment Variables
```bash
# .env.local
DATA_SOURCE=MARKET_DATA
MARKET_DATA_TOKEN=your_token_here
```

### Testing MarketData Integration

#### Option 1: Vercel Deployment (Recommended)
```bash
vercel --prod
```
- Uses real `/api` files
- Full MarketData support
- Complete `ivSurface` data

#### Option 2: Vercel Dev Server
```bash
vercel dev
```
- Local testing with real API files
- Requires Vercel CLI
- May need `yarn` installed

#### Option 3: Direct API Testing
```bash
node _test_strategy.js
```
- Tests API logic directly
- Bypasses frontend
- Quick verification

### Vite Dev Server Limitation

`npm run dev` uses inline API handlers in `vite.config.ts` that are hardcoded to CBOE for simplicity. This is intentional for quick frontend iteration.

**What works in Vite dev:**
- ✅ Frontend UI development
- ✅ Component testing
- ✅ Basic API responses

**What requires Vercel:**
- ⚠️ MarketData.app integration
- ⚠️ `ivSurface` data
- ⚠️ Real Greeks (non-zero)

## File Status

### ✅ MarketData Ready
- `api/strategy-recommend.js`
- `api/scan-options.js`
- `api/option-price.js`
- `api/check-alerts.js`
- `api/daily-recap.js`
- `api/_shared/scoring.cjs`

### ℹ️ Development Only
- `vite.config.ts` - CBOE hardcoded for dev speed
