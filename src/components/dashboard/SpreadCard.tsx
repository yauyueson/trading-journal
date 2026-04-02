interface SpreadCandidate {
  shortStrike: number;
  longStrike: number;
  credit: number;
  dte: number;
  expiration: string;
  contracts: number;
  maxLoss: number;
  maxProfit: number;
  riskPct: number;
  shortDelta: number;
  pop: number;
}

interface SpreadCardProps {
  spread: SpreadCandidate;
  onVerifyOpen: (spread: SpreadCandidate) => void;
}

export type { SpreadCandidate };

export function SpreadCard({ spread, onVerifyOpen }: SpreadCardProps) {
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-3 hover:border-blue-500/50 transition-colors">
      <div className="flex justify-between items-start mb-2">
        <div>
          <span className="text-white font-semibold text-sm">
            {spread.shortStrike}/{spread.longStrike} put
          </span>
          <span className="text-zinc-500 text-xs ml-2">{spread.dte}d</span>
        </div>
        <span className="text-green-400 font-mono text-sm">${spread.credit.toFixed(2)}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs text-zinc-400 mb-3">
        <div>
          <span className="text-zinc-500">Contracts</span>
          <div className="text-white">{spread.contracts}</div>
        </div>
        <div>
          <span className="text-zinc-500">Max Profit</span>
          <div className="text-green-400">${spread.maxProfit.toFixed(0)}</div>
        </div>
        <div>
          <span className="text-zinc-500">Risk</span>
          <div className="text-zinc-300">${spread.maxLoss.toFixed(0)} ({spread.riskPct.toFixed(1)}%)</div>
        </div>
      </div>
      <button
        onClick={() => onVerifyOpen(spread)}
        className="w-full py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors"
      >
        Verify & Open
      </button>
    </div>
  );
}
