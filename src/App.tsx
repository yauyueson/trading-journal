import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from './lib/supabase';
import { Position, Transaction, WatchlistItem, DirectAddItem, PositionAction, RollData } from './lib/types';
import { formatDate } from './lib/utils';
import { TabNav } from './components/TabNav';
import { LoginPage } from './pages/Login';
import { PortfolioPage } from './pages/Portfolio';
import { WatchlistPage } from './pages/Watchlist';
import { ScannerPage } from './pages/Scanner';
import { OptionSelector } from './pages/StrategyRecommender';
import { HistoryPage } from './pages/History';
import { StatsPage } from './pages/Stats';
import { Academy } from './pages/Academy';
import { AppSettingsPage } from './pages/AppSettings';
import { BuyModal } from './components/BuyModal';
import { Settings } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';

function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [authLoading, setAuthLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('portfolio'); // Default landing page
    const [positions, setPositions] = useState<Position[]>([]);
    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [loading, setLoading] = useState(true);
    // State for the Buy Modal (Transition from Watchlist -> Active)
    const [buyingItem, setBuyingItem] = useState<Position | null>(null);

    // Earnings cache: deduplicate API calls across all cards/watchlist items
    // TTL: 4 hours. Map<ticker, { daysUntil: number | null; date: string | null; fetchedAt: number }>
    const earningsCacheRef = useRef<Map<string, { daysUntil: number | null; date: string | null; fetchedAt: number }>>(new Map());

    const fetchEarningsForTicker = useCallback(async (ticker: string): Promise<{ daysUntil: number | null; date: string | null }> => {
        const EARNINGS_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
        const cached = earningsCacheRef.current.get(ticker);
        if (cached && Date.now() - cached.fetchedAt < EARNINGS_CACHE_TTL) {
            return { daysUntil: cached.daysUntil, date: cached.date };
        }
        try {
            const response = await fetch(`/api/earnings?symbol=${ticker}`);
            if (response.ok) {
                const data = await response.json();
                const result = {
                    daysUntil: data.hasUpcomingEarnings ? data.daysUntilEarnings : null,
                    date: data.hasUpcomingEarnings ? data.earningsDate : null,
                };
                earningsCacheRef.current.set(ticker, { ...result, fetchedAt: Date.now() });
                return result;
            }
        } catch {
            // ignore
        }
        const empty = { daysUntil: null, date: null };
        earningsCacheRef.current.set(ticker, { ...empty, fetchedAt: Date.now() });
        return empty;
    }, []);

    // Check for existing session on mount
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
            setAuthLoading(false);
        });

        // Listen for auth changes
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
        });

        return () => subscription.unsubscribe();
    }, []);

    const isAuthenticated = !!session;

    const fetchData = useCallback(async () => {
        if (!isAuthenticated) return;
        // setLoading(true); // Can cause blinking if we do this every time
        const { data: posData } = await supabase.from('positions').select('*');
        const { data: txnData } = await supabase.from('transactions').select('*');
        if (posData) setPositions(posData as Position[]);
        if (txnData) setTransactions(txnData as Transaction[]);
        setLoading(false);
    }, [isAuthenticated]);

    useEffect(() => {
        fetchData();

        // Realtime subscriptions
        const posSub = supabase.channel('positions')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'positions' }, fetchData)
            .subscribe();

        const txnSub = supabase.channel('transactions')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, fetchData)
            .subscribe();

        return () => {
            supabase.removeChannel(posSub);
            supabase.removeChannel(txnSub);
        };
    }, [fetchData]);

    const handleLogin = () => {
        // Session will be set by onAuthStateChange listener
    };

    const handleLogout = async () => {
        await supabase.auth.signOut();
    };

    const onAction = useCallback(async (id: string, action: PositionAction) => {
        // Create transaction
        await supabase.from('transactions').insert([{
            position_id: id,
            type: action.type,
            quantity: action.quantity,
            price: action.price,
            note: action.type
        }]);

        // Update position status if closed
        if (action.type === 'Close' || (action.type === 'Size Down' && action.quantity === 0)) {
            if (action.type === 'Close') {
                await supabase.from('positions').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', id);
            }
        }
    }, []);

    const onUpdateScore = useCallback(async (id: string, score: number) => {
        await supabase.from('positions').update({
            current_score: score, // Legacy compatibility
            tech_score: score,
            tech_score_manual: score,
            tech_score_source: 'manual',
            score_updated_at: new Date().toISOString(),
            tech_score_updated_at: new Date().toISOString()
        }).eq('id', id);
        fetchData();
    }, [fetchData]);

    const onUpdatePrice = useCallback(async (id: string, price: number) => {
        await supabase.from('positions').update({ current_price: price }).eq('id', id);
        // Realtime subscription will trigger fetchData
    }, []);

    const onUpdateTarget = useCallback(async (id: string, target: number) => {
        await supabase.from('positions').update({ target_price: target }).eq('id', id);
        fetchData();
    }, [fetchData]);

    const onUpdateStop = useCallback(async (id: string, stopPrice: number) => {
        await supabase.from('positions').update({ stop_price: stopPrice }).eq('id', id);
        setPositions(prev => prev.map(p => p.id === id ? { ...p, stop_price: stopPrice } : p));
        fetchData();
    }, [fetchData]);

    const onUpdateOwner = useCallback(async (id: string, owner: 'Yuchen' | 'Annie' | null) => {
        await supabase.from('positions').update({ owner }).eq('id', id);
        setPositions(prev => prev.map(p => p.id === id ? { ...p, owner } : p));
    }, []);

    const onAddDirect = useCallback(async (item: DirectAddItem) => {
        const { data, error } = await supabase.from('positions').insert([{
            ticker: item.ticker,
            strike: item.strike,
            type: item.type,
            expiration: item.expiration, // Ensure YYYY-MM-DD
            setup: item.setup,
            strategy: item.strategy || item.type,
            status: 'active',
            entry_score: item.entry_score,
            current_score: item.entry_score,
            score_updated_at: new Date().toISOString(),
            notes: item.ticker + ' ' + item.type,
            stop_reason: item.stop_reason,
            legs: item.legs || null,
            owner: item.owner || null,
            tech_score: item.tech_score,
            tech_score_source: item.tech_score_source || 'manual',
            tech_score_manual: item.tech_score,
            // Pine Signal + entry analytics
            direction: item.direction || null,
            market_state: item.market_state || null,
            iv_regime_entry: item.iv_regime_entry || null,
            max_risk_entry: item.max_risk_entry || null,
            trade_profile: item.trade_profile || null,
            iv_rank_entry: item.iv_rank_entry ?? null,
        }]).select();

        if (data && data[0]) {
            await supabase.from('transactions').insert([{
                position_id: data[0].id, // Type assertion handled by Supabase js loosely
                type: 'Open',
                quantity: item.quantity,
                price: item.entry_price,
                note: 'Initial Entry'
            }]);
        } else if (error) {
            console.error(error);
        }
    }, [fetchData]);

    const onRoll = useCallback(async (
        originalPositionId: string,
        rollData: RollData,
    ) => {
        // 1. Close Existing
        const originalPos = positions.find(p => p.id === originalPositionId);
        if (!originalPos) return;

        await supabase.from('transactions').insert([{
            position_id: originalPositionId,
            type: 'Close',
            quantity: rollData.closeQty,
            price: rollData.closePrice,
            note: 'Rolled Position'
        }]);

        // Check if fully closed (simplified check - assumes we track qty properly, 
        // but here we might need to sum transactions. For now rely on user intention or manual status update if logic is complex.
        // Actually, let's just check if we are closing all "known" qty.
        // Since we don't track live qty in DB strictly on position row (we derive it), 
        // we might leave generic close logic or update if we know it helps.
        // Let's assume if user says they are rolling, they might be closing the whole thing often.
        // But for "Scaling down", it might be partial.
        // Let's fetch total open qty? No, `PortfolioPage` usually calculates it.
        // For simplicity, if we rely on UI to trigger 'Close' fully, we are good.
        // Here, we just log 'Close'. The `onAction` usually handles status update if type is 'Close'.
        // Let's reuse that logic if possible, or just duplicate:

        // We will fetch transactions to verify remaining qty if we want to be strict,
        // but for now, we leave the original position as 'active' unless user manually closes it fully later?
        // OR: If we want to be smart, we can't easily know safely without summing.
        // However, standard Roll behavior usually implies closing the specific contracts.

        // Let's update status if it looks like a full close? 
        // Better: let the user manage status or assume Partial unless specific flag?
        // Actually, let's look at `onAction` again. It updates status if type === 'Close'.
        // Here we insert 'Close'. We should probably update status if we think it's done. 
        // But Safe approach: Leave as 'active' unless we are sure. Use `onAction` logic?
        // Let's just create the transactions. If they want to close the old one fully, 
        // they can hit close on the remainder or we assume the `PositionCard` handles derived Qty.
        // (PositionCard derives "totalQty" from transactions).
        // If derived qty is 0, the card might show 0 contracts.
        // The `PortfolioPage` active filter is based on `status === 'active'`.
        // So we should probably update status if qty goes to 0. 
        // I will SKIP updating status to 'closed' here to avoid bugs with partial rolls, 
        // unless I calculate it.
        // Wait, `onAction` in App.tsx line 89 checks 'Close' action.
        // `Close` action implies full close in that context. 
        // Here `Close` transaction type is used.

        // 2. Open New
        const { data: newPosData } = await supabase.from('positions').insert([{
            ticker: originalPos.ticker,
            strike: rollData.newStrike,
            type: rollData.newType,
            expiration: rollData.newExpiration,
            setup: originalPos.setup, // Inherit setup
            status: 'active',
            entry_score: originalPos.entry_score, // Inherit or new? Inherit for now
            current_score: originalPos.current_score,
            score_updated_at: new Date().toISOString(),
            notes: `Rolled from ${originalPos.ticker} $${originalPos.strike} ${formatDate(originalPos.expiration)}`,
            stop_reason: originalPos.stop_reason, // Inherit
            owner: originalPos.owner || null
        }]).select();

        if (newPosData && newPosData[0]) {
            await supabase.from('transactions').insert([{
                position_id: newPosData[0].id,
                type: 'Open',
                quantity: rollData.newQty,
                price: rollData.newPrice,
                note: `Rolled from prev position`
            }]);
            fetchData();
        }
    }, [fetchData, positions]);

    const onAddToWatchlist = useCallback(async (item: WatchlistItem) => {
        console.log('Adding to watchlist:', item);
        const { error } = await supabase.from('positions').insert([{
            ticker: item.ticker,
            strike: item.strike,
            type: item.type,
            expiration: item.expiration,
            setup: item.setup,
            strategy: item.strategy || null,
            status: 'watchlist',
            entry_score: item.entry_score,
            ideal_entry: item.ideal_entry,
            target_price: item.target_price,
            stop_reason: item.stop_reason,
            notes: item.notes,
            legs: item.legs,
            owner: item.owner || null,
            tech_score: item.tech_score,
            tech_score_manual: item.tech_score,
            tech_score_source: item.tech_score_source || 'manual',
            direction: item.direction || null,
            market_state: item.market_state || null,
            trade_profile: item.trade_profile || null,
            iv_rank_entry: item.iv_rank_entry ?? null,
            iv_regime_entry: item.iv_regime_entry || null,
        }]);

        if (error) {
            console.error('Error adding to watchlist:', error);
            alert(`Error adding to watchlist: ${error.message}`);
        } else {
            console.log('Successfully added to watchlist');
            fetchData();
        }
    }, [fetchData]);

    const onMoveToActive = useCallback((item: Position) => {
        setBuyingItem(item);
    }, []);

    const onDelete = useCallback(async (id: string) => {
        if (window.confirm('Are you sure you want to permanently delete this position? This cannot be undone.')) {
            console.log('Deleting position:', id);
            // Note: Transactions and History are set to CASCADE on delete in the DB schema
            const { error } = await supabase.from('positions').delete().eq('id', id);

            if (error) {
                console.error('Error deleting position:', error);
                alert(`Error deleting position: ${error.message}`);
            } else {
                console.log('Successfully deleted position');
                fetchData();
            }
        }
    }, [fetchData]);

    if (authLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-bg-primary">
                <div className="spinner"></div>
            </div>
        );
    }

    if (!isAuthenticated) return <LoginPage onLogin={handleLogin} />;

    return (
        <div className="min-h-screen bg-bg-primary">
            {/* Header matches legacy structure */}
            <div
                className="sticky top-0 z-40 bg-black/85 backdrop-blur-xl border-b border-white/10"
                style={{ paddingTop: 'env(safe-area-inset-top)' }}
            >
                <div className={`mx-auto px-4 py-3 flex justify-between items-center max-w-5xl`}>
                    <h1 className="text-xl font-semibold">Trading Journal</h1>
                    <div className="flex items-center gap-4">
                        <button
                            onClick={() => setActiveTab('settings')}
                            className="flex items-center gap-1.5 text-text-tertiary text-sm hover:text-text-secondary transition-colors"
                            aria-label="Settings"
                        >
                            <Settings size={16} />
                            Settings
                        </button>
                        <button onClick={handleLogout} className="text-text-tertiary text-sm hover:text-text-secondary transition-colors">
                            Logout
                        </button>
                    </div>
                </div>
            </div>

            <div className={`mx-auto px-4 py-6 pb-24 sm:pb-6 max-w-5xl`}>
                <TabNav activeTab={activeTab} setActiveTab={setActiveTab} />

                {activeTab === 'portfolio' && (
                    <PortfolioPage
                        positions={positions}
                        transactions={transactions}
                        onAction={onAction}
                        onUpdateScore={onUpdateScore}
                        onUpdatePrice={onUpdatePrice}
                        onUpdateTarget={onUpdateTarget}
                        onUpdateStop={onUpdateStop}
                        onUpdateOwner={onUpdateOwner}
                        onAddDirect={onAddDirect}
                        onRoll={onRoll}
                        onDelete={onDelete}
                        loading={loading}
                        fetchEarningsForTicker={fetchEarningsForTicker}
                    />
                )}
                {activeTab === 'watchlist' && (
                    <WatchlistPage
                        positions={positions}
                        onAddToWatchlist={onAddToWatchlist}
                        onMoveToActive={onMoveToActive}
                        onDelete={onDelete}
                        loading={loading}
                        fetchEarningsForTicker={fetchEarningsForTicker}
                    />
                )}
                {activeTab === 'scanner' && (
                    <ScannerPage onAddToWatchlist={onAddToWatchlist} />
                )}
                {activeTab === 'selector' && (
                    <OptionSelector onAddToWatchlist={onAddToWatchlist} onAddDirect={onAddDirect} />
                )}
                {activeTab === 'history' && (
                    <HistoryPage
                        positions={positions}
                        transactions={transactions}
                        loading={loading}
                        onDelete={onDelete}
                        onUpdateOwner={onUpdateOwner}
                    />
                )}
                {activeTab === 'stats' && (
                    <StatsPage
                        positions={positions}
                        transactions={transactions}
                        loading={loading}
                    />
                )}
                {activeTab === 'academy' && (
                    <Academy />
                )}
                {activeTab === 'settings' && <AppSettingsPage />}
            </div>



            {buyingItem && (
                <BuyModal
                    position={buyingItem}
                    onConfirm={async (qty, price) => {
                        // 1. Update position status to active
                        await supabase.from('positions').update({
                            status: 'active',
                            current_score: buyingItem.entry_score, // Reset/Init score
                            score_updated_at: new Date().toISOString()
                        }).eq('id', buyingItem.id);

                        // 2. Add transaction
                        await supabase.from('transactions').insert([{
                            position_id: buyingItem.id,
                            type: 'Open',
                            quantity: qty,
                            price: price,
                            note: 'Moved from Watchlist'
                        }]);

                        setBuyingItem(null);
                        fetchData(); // Refresh
                    }}
                    onCancel={() => setBuyingItem(null)}
                />
            )}
        </div>
    );
}

export default App;
