import { Outlet } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { TabNav } from '../components/TabNav';
import { MobileTabBar } from '../components/MobileTabBar';
import { useRealtimeInvalidation } from '../hooks/useRealtimeInvalidation';
import { Settings, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase, supabaseReady, supabaseInitError } from '../lib/supabase';

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!supabaseReady) {
      setError('Supabase client is not configured for this deployment.');
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
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

function StartupErrorScreen({ message }: { message: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-xl rounded-2xl border border-red-500/20 bg-black/30 p-6 sm:p-8">
        <h2 className="text-xl font-bold mb-3">App failed to start</h2>
        <p className="text-sm text-text-secondary mb-4">{message}</p>
        <p className="text-sm text-text-secondary">
          For Vercel, make sure both <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>
          are set in the project environment, then redeploy so Vite can bake them into the client bundle.
        </p>
      </div>
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

  // Reserve the fatal startup screen for build-time config errors only
  // (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). Runtime auth errors
  // like a transient getSession() rejection fall through to LoginForm so the
  // user can retry instead of being trapped on a dead-end screen.
  if (supabaseInitError && !isAuthenticated) {
    return <StartupErrorScreen message={supabaseInitError.message} />;
  }

  if (!isAuthenticated) return <LoginForm />;

  return (
    <div style={{ minHeight: '100dvh' }}>
      {/* Desktop header — flat terminal panel with subtle scanlines */}
      <div className="hidden sm:sticky sm:top-3 sm:block sm:z-50 sm:px-4 sm:px-6">
        <div className="mx-auto px-4 py-2.5 flex items-center gap-6 max-w-7xl
          sm:border sm:border-phosphor-green/20 sm:rounded-md sm:bg-terminal-panel sm:scanlines sm:shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
          <h1
            className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green shrink-0 cursor-pointer"
            onClick={() => navigate('/dashboard')}
          >
            ▌ TRADING_JOURNAL
          </h1>
          <TabNav />
          <div className="flex items-center gap-1 ml-auto shrink-0">
            <button
              onClick={() => navigate('/settings')}
              className="flex items-center gap-1.5 text-text-tertiary font-mono uppercase tracking-wider text-[11px] hover:text-phosphor-green hover:text-glow-green transition-colors min-w-[44px] min-h-[44px] justify-center"
              aria-label="Settings"
            >
              <Settings size={14} />
              <span className="hidden lg:inline">Settings</span>
            </button>
            <button
              onClick={logout}
              className="flex items-center gap-1.5 text-text-tertiary font-mono uppercase tracking-wider text-[11px] hover:text-phosphor-amber hover:text-glow-amber transition-colors min-w-[44px] min-h-[44px] justify-center"
              aria-label="Logout"
            >
              <span>Logout</span>
            </button>
          </div>
        </div>
      </div>

      {/* Mobile top bar — slim, no backdrop-blur (avoids iOS containing block bug) */}
      <div className="sm:hidden flex items-center justify-between px-4 py-2">
        <h1
          className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green cursor-pointer"
          onClick={() => navigate('/dashboard')}
        >
          ▌ TRADING_JOURNAL
        </h1>
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigate('/settings')}
            className="flex items-center justify-center text-text-tertiary hover:text-text-secondary transition-colors min-w-[44px] min-h-[44px]"
            aria-label="Settings"
          >
            <Settings size={18} />
          </button>
          <button
            onClick={logout}
            className="flex items-center justify-center text-text-tertiary hover:text-text-secondary transition-colors min-w-[44px] min-h-[44px]"
            aria-label="Logout"
          >
            <LogOut size={18} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto px-4 sm:px-6 pt-2 sm:pt-14 pb-safe max-w-7xl">
        <Outlet />
      </div>

      {/* Mobile bottom tab bar — outside header, no containing block issue */}
      <MobileTabBar />
    </div>
  );
}
