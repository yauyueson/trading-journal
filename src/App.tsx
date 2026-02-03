import { useState, useEffect, useCallback } from 'react';
import { supabase } from './lib/supabase';
import { Position, Transaction } from './lib/types';
import { TabNav } from './components/TabNav';
import { LoginPage } from './pages/Login';
import { PortfolioPage } from './pages/Portfolio';
import { WatchlistPage } from './pages/Watchlist';
import { HistoryPage } from './pages/History';
import { StatsPage } from './pages/Stats';
import { BuyModal } from './components/BuyModal';
import type { Session } from '@supabase/supabase-js';

function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [authLoading, setAuthLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('portfolio');
    const [positions, setPositions] = useState<Position[]>([]);
    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [loading, setLoading] = useState(false);
    // State for the Buy Modal (Transition from Watchlist -> Active)
    const [buyingItem, setBuyingItem] = useState<Position | null>(null);

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
        setLoading(true);
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

    const onAction = async (id: string, action: { type: string; quantity: number; price: number }) => {
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
    };

    const onUpdateScore = async (id: string, score: number) => {
        await supabase.from('positions').update({
            current_score: score,
            score_updated_at: new Date().toISOString()
        }).eq('id', id);
    };

    const onUpdatePrice = async (id: string, price: number) => {
        await supabase.from('positions').update({ current_price: price }).eq('id', id);
    };

    const onAddDirect = async (item: any) => {
        const { data, error } = await supabase.from('positions').insert([{
            ticker: item.ticker,
            strike: item.strike,
            type: item.type,
            expiration: item.expiration, // Ensure YYYY-MM-DD
            setup: item.setup,
            status: 'active',
            entry_score: item.entry_score,
            current_score: item.entry_score,
            score_updated_at: new Date().toISOString(),
            notes: item.ticker + ' ' + item.type,
            stop_reason: item.stop_reason
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
    };

    const onAddToWatchlist = async (item: any) => {
        await supabase.from('positions').insert([{
            ticker: item.ticker,
            strike: item.strike,
            type: item.type,
            expiration: item.expiration,
            setup: item.setup,
            status: 'watchlist',
            entry_score: item.entry_score,
            ideal_entry: item.ideal_entry,
            target_price: item.target_price,
            stop_reason: item.stop_reason,
            notes: item.notes
        }]);
    };

    const onMoveToActive = (item: Position) => {
        setBuyingItem(item);
    };

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
            <div className="max-w-2xl mx-auto px-4 py-3 flex justify-between items-center bg-black/85 backdrop-blur-xl border-b border-white/10 sticky top-0 z-40">
                <h1 className="text-xl font-semibold">Trading Journal</h1>
                <button onClick={handleLogout} className="text-text-tertiary text-sm hover:text-text-secondary transition-colors">
                    Logout
                </button>
            </div>

            <div className="max-w-2xl mx-auto px-4 py-6 pb-24 sm:pb-6">
                <TabNav activeTab={activeTab} setActiveTab={setActiveTab} />

                {activeTab === 'portfolio' && (
                    <PortfolioPage
                        positions={positions}
                        transactions={transactions}
                        onAction={onAction}
                        onUpdateScore={onUpdateScore}
                        onUpdatePrice={onUpdatePrice}
                        onAddDirect={onAddDirect}
                        loading={loading}
                    />
                )}
                {activeTab === 'watchlist' && (
                    <WatchlistPage
                        positions={positions}
                        onAddToWatchlist={onAddToWatchlist}
                        onMoveToActive={onMoveToActive}
                        loading={loading}
                    />
                )}
                {activeTab === 'history' && (
                    <HistoryPage
                        positions={positions}
                        transactions={transactions}
                        loading={loading}
                    />
                )}
                {activeTab === 'stats' && (
                    <StatsPage
                        positions={positions}
                        transactions={transactions}
                        loading={loading}
                    />
                )}
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
