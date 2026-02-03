import { supabase } from './supabase';
import { GreeksHistory } from './types';

/**
 * Check if we already have a greeks history record for this position today
 */
export async function hasRecordedToday(positionId: string): Promise<boolean> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { data, error } = await supabase
        .from('position_greeks_history')
        .select('id')
        .eq('position_id', positionId)
        .gte('recorded_at', today.toISOString())
        .limit(1);

    if (error) {
        console.error('Error checking greeks history:', error);
        return true; // Assume recorded to avoid duplicates
    }

    return data && data.length > 0;
}

/**
 * Save greeks history for a position (once per day)
 */
export async function saveGreeksHistory(
    positionId: string,
    iv: number | undefined,
    delta: number | undefined
): Promise<boolean> {
    // Skip if no data
    if (iv === undefined && delta === undefined) {
        return false;
    }

    // Check if already recorded today
    const alreadyRecorded = await hasRecordedToday(positionId);
    if (alreadyRecorded) {
        return false;
    }

    const { error } = await supabase
        .from('position_greeks_history')
        .insert([{
            position_id: positionId,
            iv: iv ?? null,
            delta: delta ?? null
        }]);

    if (error) {
        console.error('Error saving greeks history:', error);
        return false;
    }

    return true;
}

/**
 * Fetch greeks history for a position, ordered by date
 */
export async function fetchGreeksHistory(positionId: string): Promise<GreeksHistory[]> {
    const { data, error } = await supabase
        .from('position_greeks_history')
        .select('*')
        .eq('position_id', positionId)
        .order('recorded_at', { ascending: true });

    if (error) {
        console.error('Error fetching greeks history:', error);
        return [];
    }

    return data as GreeksHistory[];
}
