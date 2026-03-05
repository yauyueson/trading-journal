import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';

interface EarningsData {
  daysUntil: number | null;
  date: string | null;
}

export function useEarnings(ticker: string | null) {
  return useQuery({
    queryKey: queryKeys.earnings(ticker ?? ''),
    queryFn: async (): Promise<EarningsData> => {
      const response = await fetch(`/api/earnings?symbol=${ticker}`);
      if (!response.ok) return { daysUntil: null, date: null };
      const data = await response.json();
      return {
        daysUntil: data.hasUpcomingEarnings ? data.daysUntilEarnings : null,
        date: data.hasUpcomingEarnings ? data.earningsDate : null,
      };
    },
    enabled: !!ticker,
    staleTime: 4 * 60 * 60 * 1000, // 4 hours
  });
}
