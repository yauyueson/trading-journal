import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';

interface BulkLeg {
  ticker: string;
  expiration: string;
  strike: number;
  type: string;
  id: string;
}

export function useBulkOptionPrices(legs: BulkLeg[], enabled = true) {
  return useQuery({
    queryKey: queryKeys.optionPrices(legs),
    queryFn: async () => {
      if (legs.length === 0) return {};

      const res = await fetch('/api/option-prices-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ legs }),
      });

      if (!res.ok) throw new Error('Bulk price fetch failed');

      const data = await res.json();
      if (!data.success || !data.results) return {};

      // Group results by position ID
      const grouped: Record<string, any[]> = {};
      data.results.forEach((r: any) => {
        if (!r.id) return;
        if (!grouped[r.id]) grouped[r.id] = [];
        if (r.success !== false) grouped[r.id].push(r);
      });

      return grouped;
    },
    enabled: enabled && legs.length > 0,
    staleTime: 60 * 1000, // 1 minute
  });
}
