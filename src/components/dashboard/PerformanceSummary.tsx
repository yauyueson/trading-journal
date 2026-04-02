import type { Position, Transaction } from '../../lib/types';

interface PerformanceSummaryProps {
  positions: Position[];
  transactions: Transaction[];
}

export function PerformanceSummary({ positions, transactions }: PerformanceSummaryProps) {
  const closedDte5 = positions.filter(p => p.status === 'closed' && p.strategy_type === 'dte5');

  const stats = closedDte5.reduce(
    (acc, pos) => {
      const posTransactions = transactions.filter(t => t.position_id === pos.id);
      const openTx = posTransactions.find(t => t.type === 'Open');
      const closeTx = posTransactions.find(t => t.type === 'Close' || t.type === 'Take Profit');

      if (!openTx) return acc;

      const qty = openTx.quantity;
      const entryCredit = openTx.price * qty * 100;
      const exitDebit = closeTx ? closeTx.price * qty * 100 : 0;
      const pnl = entryCredit - exitDebit;

      acc.totalPnl += pnl;
      acc.trades++;
      if (pnl > 0) acc.wins++;
      acc.totalCredit += openTx.price;

      return acc;
    },
    { totalPnl: 0, trades: 0, wins: 0, totalCredit: 0 }
  );

  const winRate = stats.trades > 0 ? (stats.wins / stats.trades * 100) : 0;
  const avgCredit = stats.trades > 0 ? stats.totalCredit / stats.trades : 0;

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-4">
      <h3 className="text-zinc-300 text-xs font-semibold mb-3 uppercase tracking-wider">DTE5 Performance</h3>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <span className="text-zinc-500 text-[10px]">Total P&L</span>
          <div className={`text-lg font-semibold ${stats.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            ${stats.totalPnl.toFixed(0)}
          </div>
        </div>
        <div>
          <span className="text-zinc-500 text-[10px]">Win Rate</span>
          <div className="text-lg font-semibold text-white">{winRate.toFixed(0)}%</div>
        </div>
        <div>
          <span className="text-zinc-500 text-[10px]">Trades</span>
          <div className="text-sm text-zinc-300">{stats.trades}</div>
        </div>
        <div>
          <span className="text-zinc-500 text-[10px]">Avg Credit</span>
          <div className="text-sm text-zinc-300">${avgCredit.toFixed(2)}</div>
        </div>
      </div>

      <div className="border-t border-zinc-700 pt-3">
        <h4 className="text-zinc-500 text-[10px] mb-1">Backtest Reference</h4>
        <div className="flex gap-4 text-[11px]">
          <span className="text-zinc-400">WR 80%</span>
          <span className="text-zinc-400">Sharpe 1.18</span>
          <span className="text-zinc-400">CAGR 38.8%</span>
        </div>
      </div>
    </div>
  );
}
