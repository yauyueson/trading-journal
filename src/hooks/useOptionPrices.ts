import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';

export interface OptionPriceLeg {
  ticker: string;
  expiration: string;
  strike: number | string;
  type: string;
  id?: string;
}

export interface OptionPriceResult extends OptionPriceLeg {
  success?: boolean;
  error?: string;
  price?: number;
  bid?: number;
  ask?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  iv?: number;
  score?: number;
  underlyingPrice?: number;
  cboeTimestamp?: string;
  data?: unknown;
  metrics?: {
    isDayTrade?: boolean;
    ivRatio?: number;
  };
}

function normalizeLegForKey(leg: OptionPriceLeg) {
  return {
    ticker: leg.ticker.toUpperCase(),
    expiration: leg.expiration,
    strike: Number(leg.strike),
    type: leg.type,
    id: leg.id,
  };
}

export function useOptionPrices(legs: OptionPriceLeg[], enabled: boolean) {
  const normalizedLegs = legs.map(normalizeLegForKey);

  return useQuery({
    queryKey: queryKeys.optionPrices(normalizedLegs),
    enabled: enabled && normalizedLegs.length > 0,
    staleTime: 45_000,
    gcTime: 2 * 60_000,
    retry: 1,
    queryFn: async () => {
      const res = await fetch('/api/option-prices-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ legs: normalizedLegs }),
      });

      if (!res.ok) {
        throw new Error(`Bulk option price request failed: ${res.status}`);
      }

      const data = await res.json();
      if (!data?.success || !Array.isArray(data.results)) {
        throw new Error('Bulk option price response was malformed');
      }

      return data.results as OptionPriceResult[];
    },
  });
}
