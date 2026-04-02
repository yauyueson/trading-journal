import { useState } from 'react';
import { X } from 'lucide-react';
import type { SpreadCandidate } from './SpreadCard';
import { useAppSettings } from '../../context/AppSettingsContext';

interface ConfirmSpreadModalProps {
  spread: SpreadCandidate;
  onConfirm: (spread: SpreadCandidate, adjustedCredit: number, adjustedContracts: number) => void;
  onCancel: () => void;
}

export function ConfirmSpreadModal({ spread, onConfirm, onCancel }: ConfirmSpreadModalProps) {
  const [credit, setCredit] = useState(spread.credit);
  const [contracts, setContracts] = useState(spread.contracts);
  const { settings } = useAppSettings();

  const width = spread.shortStrike - spread.longStrike;
  const maxLossPerContract = (width - credit) * 100;
  const totalMaxLoss = maxLossPerContract * contracts;
  const totalMaxProfit = credit * 100 * contracts;
  const riskPct = settings.portfolio.accountSize > 0
    ? (totalMaxLoss / settings.portfolio.accountSize * 100)
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-5 w-full max-w-md">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-white font-semibold">Confirm DTE5 Bull Put Spread</h2>
          <button onClick={onCancel} className="text-zinc-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>

        <div className="space-y-3 mb-4">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-zinc-500">Ticker</div><div className="text-white">QQQ</div>
            <div className="text-zinc-500">Short Strike</div><div className="text-white">{spread.shortStrike} Put</div>
            <div className="text-zinc-500">Long Strike</div><div className="text-white">{spread.longStrike} Put</div>
            <div className="text-zinc-500">Expiration</div><div className="text-white">{spread.expiration} ({spread.dte}d)</div>
            <div className="text-zinc-500">Delta</div><div className="text-white">{spread.shortDelta.toFixed(2)}</div>
          </div>

          <div className="border-t border-zinc-700 pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500 text-sm">Credit (per share)</span>
              <input
                type="number"
                step="0.01"
                value={credit}
                onChange={e => setCredit(parseFloat(e.target.value) || 0)}
                className="w-24 bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-white text-sm text-right"
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500 text-sm">Contracts</span>
              <input
                type="number"
                step="1"
                min="1"
                value={contracts}
                onChange={e => setContracts(parseInt(e.target.value) || 1)}
                className="w-24 bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-white text-sm text-right"
              />
            </div>
          </div>

          <div className="border-t border-zinc-700 pt-3 grid grid-cols-2 gap-2 text-sm">
            <div className="text-zinc-500">Max Profit</div>
            <div className="text-green-400">${totalMaxProfit.toFixed(0)}</div>
            <div className="text-zinc-500">Max Loss</div>
            <div className="text-red-400">${totalMaxLoss.toFixed(0)}</div>
            <div className="text-zinc-500">Risk %</div>
            <div className="text-zinc-300">{riskPct.toFixed(1)}% of equity</div>
          </div>
        </div>

        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 py-2 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-sm">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(spread, credit, contracts)}
            className="flex-1 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium"
          >
            Log Position
          </button>
        </div>
      </div>
    </div>
  );
}
