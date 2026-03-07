/**
 * Backtest Optimizer Web Worker
 *
 * Runs GA optimization and walk-forward off the main thread so the browser
 * stays fully responsive. Communication via postMessage:
 *
 * IN  { id, type: 'optimize',     payload: { candles, config, ivData?, oosConfig? } }
 * IN  { id, type: 'walkforward',  payload: { candles, config } }
 * IN  { id, type: 'cancel' }
 *
 * OUT { id, type: 'progress',     phase, pct }
 * OUT { id, type: 'wf-progress',  wi, total, phase }
 * OUT { id, type: 'optimize-done',result }
 * OUT { id, type: 'wf-done',      result }
 * OUT { id, type: 'error',        message }
 */

import { runTwoStageOptimize, runWalkForward } from './sweep';
import type { OptimizeConfig, WalkForwardConfig, OptimizeResult, WalkForwardResult } from './types';
import type { BacktestCandle } from './types';
import type { IVDataRow } from './engine';

let cancelled = false;

self.onmessage = async (e: MessageEvent) => {
  const { id, type, payload } = e.data as {
    id: string;
    type: 'optimize' | 'walkforward' | 'cancel';
    payload: any;
  };

  if (type === 'cancel') {
    cancelled = true;
    return;
  }

  cancelled = false;

  if (type === 'optimize') {
    const { candles, config, ivData } = payload as {
      candles: BacktestCandle[] | [string, BacktestCandle[]][];
      config: OptimizeConfig;
      ivData?: IVDataRow[] | [string, IVDataRow[]][];
    };

    try {
      // Re-hydrate Map if it was serialised as array of entries
      const candleInput = Array.isArray(candles) && candles.length > 0 && Array.isArray(candles[0])
        ? new Map(candles as [string, BacktestCandle[]][])
        : candles as BacktestCandle[];

      const ivInput = ivData
        ? (Array.isArray(ivData) && ivData.length > 0 && Array.isArray(ivData[0])
            ? new Map(ivData as [string, IVDataRow[]][])
            : ivData as IVDataRow[])
        : undefined;

      const result: OptimizeResult = await runTwoStageOptimize(
        candleInput,
        config,
        (phase, pct) => {
          if (!cancelled) self.postMessage({ id, type: 'progress', phase, pct });
        },
        ivInput,
      );

      if (!cancelled) self.postMessage({ id, type: 'optimize-done', result });
    } catch (err: any) {
      self.postMessage({ id, type: 'error', message: err?.message ?? 'Optimization failed' });
    }
    return;
  }

  if (type === 'walkforward') {
    const { candles, config } = payload as {
      candles: BacktestCandle[];
      config: WalkForwardConfig;
    };

    try {
      const result: WalkForwardResult = await runWalkForward(
        candles,
        config,
        (wi, total, phase) => {
          if (!cancelled) self.postMessage({ id, type: 'wf-progress', wi, total, phase });
        },
      );

      if (!cancelled) self.postMessage({ id, type: 'wf-done', result });
    } catch (err: any) {
      self.postMessage({ id, type: 'error', message: err?.message ?? 'Walk-forward failed' });
    }
  }
};
