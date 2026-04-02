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
    <div style={{ minHeight: '100dvh' }}>
      {/* Header — sticky, safe-area handled by #root padding */}
      <div className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#0A0A0E]/90 backdrop-blur-xl sm:bg-black/40 sm:backdrop-blur-2xl">
        <div className="mx-auto px-4 py-2.5 flex items-center gap-6 max-w-7xl">
          {/* Logo */}
          <h1
            className="text-base font-semibold text-gradient-primary shrink-0 cursor-pointer"
            onClick={() => navigate('/dashboard')}
          >
            Trading Journal
          </h1>

          {/* Desktop nav — integrated into header */}
          <TabNav />

          {/* Right actions */}
          <div className="flex items-center gap-1 ml-auto shrink-0">
            <button
              onClick={() => navigate('/settings')}
              className="flex items-center gap-1.5 text-text-tertiary text-sm hover:text-text-secondary transition-colors min-w-[44px] min-h-[44px] justify-center"
              aria-label="Settings"
            >
              <Settings size={16} />
              <span className="hidden lg:inline text-[13px]">Settings</span>
            </button>
            <button
              onClick={logout}
              className="flex items-center gap-1.5 text-text-tertiary text-sm hover:text-text-secondary transition-colors min-w-[44px] min-h-[44px] justify-center"
              aria-label="Logout"
            >
              <LogOut size={16} className="sm:hidden" />
              <span className="hidden sm:inline text-[13px]">Logout</span>
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto px-4 sm:px-6 pt-4 sm:pt-10 pb-safe max-w-7xl ambient-glow">
        <Outlet />
      </div>
    </div>
  );
}
