import { Outlet } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { TabNav } from '../components/TabNav';
import { useRealtimeInvalidation } from '../hooks/useRealtimeInvalidation';
import { Settings, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary">
      <form onSubmit={handleLogin} className="w-full max-w-sm p-8 rounded-xl border border-border-default/50 bg-bg-secondary/20">
        <h2 className="text-xl font-bold text-text-primary mb-6">Trading Journal</h2>
        {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
        <input
          type="email" placeholder="Email" value={email}
          onChange={e => setEmail(e.target.value)} required
          className="w-full mb-3 px-3 py-2 rounded-lg bg-bg-primary border border-border-default/50 text-text-primary text-sm focus:outline-none focus:border-amber-500/50"
        />
        <input
          type="password" placeholder="Password" value={password}
          onChange={e => setPassword(e.target.value)} required
          className="w-full mb-4 px-3 py-2 rounded-lg bg-bg-primary border border-border-default/50 text-text-primary text-sm focus:outline-none focus:border-amber-500/50"
        />
        <button
          type="submit" disabled={loading}
          className="w-full py-2 rounded-lg bg-amber-500/20 text-amber-400 font-semibold text-sm border border-amber-500/40 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
        >
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}

export function AppLayout() {
  const { authLoading, isAuthenticated, logout } = useAuth();
  const navigate = useNavigate();

  // Realtime → React Query cache invalidation
  useRealtimeInvalidation();

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-primary">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!isAuthenticated) return <LoginForm />;

  return (
    <div className="min-h-screen bg-bg-primary">
      {/* Header */}
      <div
        className="sticky top-0 z-40 bg-black/85 backdrop-blur-xl border-b border-white/10"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="mx-auto px-4 py-3 flex justify-between items-center max-w-5xl lg:max-w-6xl">
          <h1 className="text-xl font-semibold">Trading Journal</h1>
          <div className="flex items-center gap-2 sm:gap-4">
            <button
              onClick={() => navigate('/settings')}
              className="flex items-center gap-1.5 text-text-tertiary text-sm hover:text-text-secondary transition-colors min-w-[44px] min-h-[44px] justify-center sm:justify-start"
              aria-label="Settings"
            >
              <Settings size={18} />
              <span className="hidden sm:inline">Settings</span>
            </button>
            <button
              onClick={logout}
              className="flex items-center gap-1.5 text-text-tertiary text-sm hover:text-text-secondary transition-colors min-w-[44px] min-h-[44px] justify-center sm:justify-start"
              aria-label="Logout"
            >
              <LogOut size={18} className="sm:hidden" />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto px-4 py-6 pb-24 sm:pb-6 max-w-5xl lg:max-w-6xl">
        <TabNav />
        <Outlet />
      </div>
    </div>
  );
}
