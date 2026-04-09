import React, { useState } from 'react';

interface InlineEditFieldProps {
  label: string;
  value: number | null;
  onSave: (value: number) => Promise<void> | void;
  formatValue: (v: number) => string;
  colorClass?: string;
  placeholder?: string;
  tooltipLabel: string;
  tooltipExplanation: string;
  TooltipComponent: React.FC<{ label: string; explanation: string; className?: string }>;
}

export const InlineEditField: React.FC<InlineEditFieldProps> = ({
  label,
  value,
  onSave,
  formatValue,
  colorClass = 'text-text-primary',
  tooltipLabel,
  tooltipExplanation,
  TooltipComponent,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [input, setInput] = useState('');

  const handleSave = async () => {
    const parsed = parseFloat(input);
    if (!isNaN(parsed)) {
      await onSave(parsed);
      setIsEditing(false);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center gap-1 h-5">
        <TooltipComponent label={tooltipLabel} explanation={tooltipExplanation} className="text-[11px] text-text-tertiary uppercase tracking-wider" />
        <button
          onClick={() => { setIsEditing(true); setInput((value ?? '').toString()); }}
          className="text-text-tertiary hover:text-text-primary transition-colors cursor-pointer p-2 -m-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label={`Edit ${label.toLowerCase()}`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
        </button>
      </div>
      {isEditing ? (
        <div className="flex items-center gap-1">
          <input
            type="number"
            step="0.01"
            value={input}
            onChange={e => setInput(e.target.value)}
            className="w-16 px-1 py-0.5 text-sm bg-bg-secondary rounded border border-border-default font-mono"
            autoFocus
          />
          <button onClick={handleSave} className="text-accent-green hover:bg-accent-green/10 p-0.5 rounded cursor-pointer">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </button>
          <button onClick={() => setIsEditing(false)} className="text-accent-red hover:bg-accent-red/10 p-0.5 rounded cursor-pointer">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      ) : (
        <div className={`metric-value ${colorClass}`}>
          {value != null ? formatValue(value) : '—'}
        </div>
      )}
    </div>
  );
};
