export const queryKeys = {
  positions: ['positions'] as const,
  transactions: ['transactions'] as const,
  earnings: (ticker: string) => ['earnings', ticker] as const,
  optionPrice: (ticker: string, expiration: string, strike: number, type: string) =>
    ['optionPrice', ticker, expiration, strike, type] as const,
  optionPrices: (legs: unknown[]) => ['optionPrices', JSON.stringify(legs)] as const,
  strategyRecommend: (params: Record<string, unknown>) =>
    ['strategyRecommend', params] as const,
  scanOptions: (params: Record<string, unknown>) =>
    ['scanOptions', params] as const,
  greeksHistory: (positionId: string) => ['greeksHistory', positionId] as const,
  analytics: (type: string) => ['analytics', type] as const,
};
