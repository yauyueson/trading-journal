interface ExpiryCountdownProps {
  expiration: string;
  entryDate: string;
}

export function ExpiryCountdown({ expiration, entryDate }: ExpiryCountdownProps) {
  const now = new Date();
  const expiryDate = new Date(expiration + 'T16:00:00');
  const entry = new Date(entryDate + 'T09:30:00');

  const msLeft = expiryDate.getTime() - now.getTime();
  const totalMs = expiryDate.getTime() - entry.getTime();
  const progress = Math.min(1, Math.max(0, 1 - msLeft / totalMs));

  const daysLeft = Math.max(0, Math.ceil(msLeft / 86400000));
  const hoursLeft = Math.max(0, Math.floor((msLeft % 86400000) / 3600000));

  const isExpired = msLeft <= 0;

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-3">
      <div className="flex justify-between items-center mb-2">
        <span className="text-zinc-400 text-xs font-medium">Expiry Countdown</span>
        <span className={`text-xs font-semibold ${isExpired ? 'text-red-400' : daysLeft <= 1 ? 'text-yellow-400' : 'text-zinc-300'}`}>
          {isExpired ? 'EXPIRED' : `${daysLeft}d ${hoursLeft}h left`}
        </span>
      </div>
      <div className="w-full bg-zinc-700 rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all ${isExpired ? 'bg-red-500' : daysLeft <= 1 ? 'bg-yellow-500' : 'bg-blue-500'}`}
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <p className="text-zinc-500 text-[10px] mt-1">Expires {expiration}</p>
    </div>
  );
}
