---
name: deploy-check
description: Pre-deploy verification — runs tsc, build, lint, tests, and checks Vercel deployment status. Use before pushing or after pushing to verify deployment health.
user-invocable: true
allowed-tools: Bash Read Grep
---

# Deploy Check

When invoked via `/deploy-check`, run the full verification pipeline. This exists because:
- A missing `isCreditStrategy` export broke Vercel (commit eead8ff)
- TypeScript errors in Backtest dashboard blocked deploy (commit e5cec2c)
- Vercel Hobby has a 12-function limit — hit 3 times in project history

## Step 1: TypeScript Check

```bash
npx tsc --noEmit
```

If this fails, STOP and fix. Do not proceed — TypeScript errors are the #1 cause of broken deploys.

## Step 2: Build

```bash
npm run build
```

Check for:
- Build errors (fatal)
- Large chunk warnings (>500KB) — informational only, not blocking

## Step 3: Lint

```bash
npm run lint
```

Must have 0 errors. Warnings are OK if under 25 (ESLint maxWarnings).

## Step 4: Tests

```bash
npx vitest run
```

All 695+ tests must pass. If scoring parity tests fail, `oss-core.ts` and `scoring.cjs` are out of sync — fix both before deploying.

## Step 5: Vercel Status (if $ARGUMENTS contains "vercel" or after push)

```bash
npx vercel ls --limit 5
```

Check that the latest deployment is `Ready`. If `Error`:
- Check build logs: `npx vercel inspect <deployment-url>`
- Common causes: missing exports, TypeScript errors, function count > 12

## Step 6: Function Count Check

```bash
ls api/*.js | wc -l
```

Vercel Hobby plan allows max 12 serverless functions. Current count should be monitored. If adding a new API route, check this first.

## Output Format

```
## Deploy Check Report

✓ TypeScript: clean (0 errors)
✓ Build: success (1.7s)
✓ Lint: 22 warnings, 0 errors
✓ Tests: 695 passed
✓ Functions: 8/12 (Vercel Hobby limit)
[✓ Vercel: latest deployment Ready]

Status: SAFE TO DEPLOY
```

Or if issues found:

```
✗ TypeScript: 2 errors
  src/lib/utils.ts:45 — Property 'foo' does not exist on type 'Bar'
  ...

Status: BLOCKED — fix TypeScript errors before deploying
```

## Rules

- Run steps sequentially — TypeScript must pass before build, build before lint
- If $ARGUMENTS is empty, run steps 1-4 only (local verification)
- If $ARGUMENTS contains "full" or "vercel", also run steps 5-6
- Do NOT push or deploy — only verify. The user decides when to push.
- If any step fails, stop and report. Don't continue to later steps.
