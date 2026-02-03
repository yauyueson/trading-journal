import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export const formatDate = (d: string | null | undefined): string => {
    if (!d) return '—';
    // Handle YYYY-MM-DD string
    if (typeof d === 'string' && d.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const [year, month, day] = d.split('-');
        const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export const formatCurrency = (n: number | string): string => {
    const num = Number(n);
    if (isNaN(num)) return '$0.00';
    if (num >= 1000) return '$' + (num / 1000).toFixed(1) + 'K';
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const formatPrice = (n: number | string): string => '$' + Number(n).toFixed(2);

export const formatPercent = (n: number | string): string => {
    const num = Number(n);
    return (num >= 0 ? '+' : '') + num.toFixed(2) + '%';
};

export const daysUntil = (d: string): number => {
    if (!d) return 999;
    const [year, month, day] = d.split('-').map(Number);
    const target = new Date(year, month - 1, day);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.ceil((target.getTime() - today.getTime()) / 86400000);
};

export const daysSince = (d: string): number => Math.ceil((new Date().getTime() - new Date(d).getTime()) / 86400000);

// Use a simplified constant for now. 
// In a real app we might put this in .env, but for migration parity we keep it here or env.
export const SUPABASE_URL = 'https://irejefxhgetulqmxponl.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_STPE7Kl1Pnlwm6a-mCa-9g_U7hvret6';
export const CONTRACT_MULTIPLIER = 100;

export const SETUPS = ['Perfect Storm', 'Pullback Buy', 'Breakout', 'Divergence', 'Strong Trend', 'Failed Rally', 'Breakdown', 'Distribution', 'Strong Down', 'Other'];
