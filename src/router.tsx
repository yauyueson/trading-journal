import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './layouts/AppLayout';

// Tab ID <-> URL path mapping (used by TabNav)
export const TAB_PATHS: Record<string, string> = {
  signals: '/signals',
  selector: '/selector',
  portfolio: '/portfolio',
  history: '/history',
  stats: '/stats',
  academy: '/academy',
  backtest: '/backtest',
  settings: '/settings',
};

// Reverse: path -> tab ID
export const PATH_TO_TAB: Record<string, string> = Object.fromEntries(
  Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab])
);

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Navigate to="/portfolio" replace />,
  },
  {
    element: <AppLayout />,
    children: [
      {
        path: '/signals',
        lazy: () => import('./pages/Signals').then(m => ({ Component: m.SignalsPage })),
      },
      {
        path: '/portfolio',
        lazy: () => import('./pages/Portfolio').then(m => ({ Component: m.PortfolioPage })),
      },
      {
        path: '/scanner',
        element: <Navigate to="/portfolio" replace />,
      },
      {
        path: '/selector',
        lazy: () => import('./pages/StrategyRecommender').then(m => ({ Component: m.OptionSelector })),
      },
      {
        path: '/history',
        lazy: () => import('./pages/History').then(m => ({ Component: m.HistoryPage })),
      },
      {
        path: '/stats',
        lazy: () => import('./pages/Stats').then(m => ({ Component: m.StatsPage })),
      },
      {
        path: '/academy',
        lazy: () => import('./pages/Academy').then(m => ({ Component: m.Academy })),
      },
      {
        path: '/backtest',
        lazy: () => import('./pages/Backtest').then(m => ({ Component: m.BacktestPage })),
      },
      {
        path: '/settings',
        lazy: () => import('./pages/AppSettings').then(m => ({ Component: m.AppSettingsPage })),
      },
    ],
  },
]);
