export interface Position {
    id: string;
    ticker: string;
    strike: number;
    type: 'Call' | 'Put';
    expiration: string;
    status: 'watchlist' | 'active' | 'closed';
    setup: string;
    entry_score: number;
    current_score: number;
    score_updated_at?: string;
    ideal_entry?: number;
    current_price?: number;
    stop_reason?: string;
    target_price?: number;
    notes?: string;
    created_at?: string;
    closed_at?: string;
}

export interface Transaction {
    id: string;
    position_id: string;
    type: 'Open' | 'Size Up' | 'Size Down' | 'Take Profit' | 'Close';
    quantity: number;
    price: number;
    date: string;
    note?: string;
}

export interface LiveData {
    price?: number;
    delta?: number;
    iv?: number;
}
