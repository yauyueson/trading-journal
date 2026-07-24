import { useQuery } from '@tanstack/react-query';

export interface OptionQuoteQuery {
  ticker: string;
  expiration: string;
  strike: number;
  type: string;
}

export interface OptionQuote {
  price?: number;
  bid?: number;
  ask?: number;
}

function normalizeExpiration(expiration: string): string {
  const trimmed = expiration.trim();
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return trimmed;
}

async function fetchOptionQuote(query: OptionQuoteQuery): Promise<OptionQuote> {
  const params = new URLSearchParams({
    ticker: query.ticker,
    expiration: normalizeExpiration(query.expiration),
    strike: String(query.strike),
    type: query.type,
  });
  const response = await fetch(`/api/option-price?${params}`);
  if (!response.ok) {
    throw new Error(`option-price ${response.status}`);
  }
  return response.json();
}

export function useOptionQuote(query: OptionQuoteQuery | null) {
  return useQuery<OptionQuote>({
    queryKey: ['optionQuote', query],
    queryFn: () => fetchOptionQuote(query!),
    enabled: query != null,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });
}
