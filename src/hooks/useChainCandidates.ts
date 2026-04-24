import { useQuery } from '@tanstack/react-query';
import { fetchChainCandidates, type ScanOptionsQuery, type ChainOption } from '../lib/chainCandidates';

export function useChainCandidates(query: ScanOptionsQuery | null) {
    return useQuery<ChainOption[]>({
        queryKey: ['chainCandidates', query],
        queryFn: () => fetchChainCandidates(query!),
        enabled: query != null,
        staleTime: 60_000,
        gcTime: 5 * 60_000,
        retry: 1,
    });
}
