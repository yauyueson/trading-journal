import { Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LoginPage } from '../pages/Login';
import { TabNav } from '../components/TabNav';
import { useRealtimeInvalidation } from '../hooks/useRealtimeInvalidation';
import { Settings, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

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

  if (!isAuthenticated) return <LoginPage onLogin={() => {}} />;

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
