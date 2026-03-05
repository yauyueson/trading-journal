import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';
import type { StrategyResult } from '../lib/types';

interface StrategyParams {
  ticker: string;
  direction: 'BULL' | 'BEAR';
  targetDte?: number;
  [key: string]: unknown;
}

export function useStrategyRecommend(params: StrategyParams | null) {
  const searchParams = params
    ? new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v != null)
          .map(([k, v]) => [k, String(v)])
      ).toString()
    : '';

  return useQuery({
    queryKey: queryKeys.strategyRecommend(params ?? {}),
    queryFn: async (): Promise<StrategyResult> => {
      const res = await fetch(`/api/strategy-recommend?${searchParams}`);
      if (!res.ok) throw new Error('Strategy recommend failed');
      return res.json();
    },
    enabled: false, // manual trigger via refetch()
  });
}
