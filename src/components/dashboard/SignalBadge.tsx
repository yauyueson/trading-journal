import { Radio } from 'lucide-react';

interface SignalBadgeProps {
  isActive: boolean;
  streak: number;
  lastSignalDate: string | null;
  asOfDate: string | null;
}

export function SignalBadge({ isActive, streak, lastSignalDate, asOfDate }: SignalBadgeProps) {
  if (isActive) {
    return (
      <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4">
        <div className="flex items-center gap-2 mb-1">
          <Radio className="w-4 h-4 text-green-400 animate-pulse" />
          <span className="text-green-400 font-semibold text-sm">QQQ Bull Signal Active</span>
          {streak > 1 && (
            <span className="text-green-400/70 text-xs">Day {streak}</span>
          )}
        </div>
        <p className="text-zinc-400 text-xs">Best entry: 10:00–10:30 AM</p>
        {asOfDate && <p className="text-zinc-500 text-[10px] mt-1">As of {asOfDate} close</p>}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Radio className="w-4 h-4 text-zinc-500" />
        <span className="text-zinc-400 font-semibold text-sm">No Signal — QQQ Below EMA34</span>
      </div>
      {lastSignalDate ? (
        <p className="text-zinc-500 text-xs">Last signal: {lastSignalDate}</p>
      ) : (
        <p className="text-zinc-500 text-xs">Waiting for signal...</p>
      )}
    </div>
  );
}
