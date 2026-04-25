import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';

export interface EarningsLookupResult {
  date: string | null;
  daysUntil: number | null;
}

export type EarningsLookup = Record<string, EarningsLookupResult>;

export function useEarningsLookup(tickers: string[]) {
  const normalizedTickers = [...new Set(tickers.map(t => t.toUpperCase()).filter(Boolean))].sort();

  return useQuery({
    queryKey: queryKeys.earnings(normalizedTickers),
    enabled: normalizedTickers.length > 0,
    staleTime: 6 * 60 * 60_000,
    gcTime: 12 * 60 * 60_000,
    retry: 1,
    queryFn: async () => {
      const entries = await Promise.all(
        normalizedTickers.map(async ticker => {
          try {
            const response = await fetch(`/api/earnings?symbol=${encodeURIComponent(ticker)}`);
            if (!response.ok) return [ticker, { date: null, daysUntil: null }] as const;
            const data = await response.json();
            return [ticker, {
              date: data.hasUpcomingEarnings ? data.earningsDate ?? null : null,
              daysUntil: data.hasUpcomingEarnings ? data.daysUntilEarnings ?? null : null,
            }] as const;
          } catch {
            return [ticker, { date: null, daysUntil: null }] as const;
          }
        }),
      );

      return Object.fromEntries(entries) as EarningsLookup;
    },
  });
}
