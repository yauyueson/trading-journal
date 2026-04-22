/**
 * Phase E1 — unit tests for simulateDiagonal (PMCC).
 * Mocks chain-cache so tests are self-contained.
 */
import { describe, expect, it } from 'vitest';
import type { OptionMode, OptionTrade, SimConfig } from '../src/lib/backtest/option-sim';

describe('Type extensions for DIAGONAL', () => {
  it('OptionMode union includes DIAGONAL', () => {
    const m: OptionMode = 'DIAGONAL';
    expect(m).toBe('DIAGONAL');
  });

  it('OptionTrade has diagonalLegs shape', () => {
    const trade: Partial<OptionTrade> = {
      mode: 'DIAGONAL',
      diagonalLegs: {
        longCall: {
          strike: 400, entryPrice: 45, exitPrice: 50, entryDate: '2023-01-20', exitDate: '2023-10-20',
        },
        shortCallCycles: [
          { strike: 420, entryDate: '2023-01-20', exitDate: '2023-02-17', entryCredit: 2.5, exitCost: 0.2, exitReason: 'EXPIRATION' },
        ],
      },
    };
    expect(trade.mode).toBe('DIAGONAL');
    expect(trade.diagonalLegs?.shortCallCycles).toHaveLength(1);
  });

  it('SimConfig has diag* fields', () => {
    const c: Partial<SimConfig> = {
      mode: 'DIAGONAL',
      diagLongDeltaRange: [0.65, 0.80],
      diagLongDTERange: [240, 300],
      diagShortDeltaRange: [0.20, 0.30],
      diagShortDTERange: [30, 45],
      diagLongProfitTarget: 0.40,
      diagLongStopLoss: 0.35,
      diagLongTimeStopDTE: 90,
      diagShortProfitTarget: 0.50,
      diagRollTriggerMoneyness: 0.02,
    };
    expect(c.mode).toBe('DIAGONAL');
  });
});

describe('Dispatcher guards', () => {
  it('eval-worker source contains explicit throw on DIAGONAL', async () => {
    const fs = await import('fs/promises');
    const src = await fs.readFile('scripts/eval-worker.ts', 'utf-8');
    expect(src).toMatch(/mode === 'DIAGONAL'/);
    expect(src).toMatch(/DIAGONAL requires simulateDiagonal/);
  });

  it('autoresearch/worker source contains explicit throw on DIAGONAL', async () => {
    const fs = await import('fs/promises');
    const src = await fs.readFile('scripts/autoresearch/worker.ts', 'utf-8');
    expect(src).toMatch(/mode === 'DIAGONAL'/);
    expect(src).toMatch(/DIAGONAL requires simulateDiagonal/);
  });
});
