import React, { useState } from 'react';

interface NotesEditorProps {
  positionId: string;
  notes: string | null | undefined;
  stopReason: string | null | undefined;
  onSave: (vars: { id: string; notes: string }) => void;
}

export const NotesEditor: React.FC<NotesEditorProps> = ({ positionId, notes, stopReason, onSave }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [input, setInput] = useState('');

  const displayText = notes || stopReason;

  if (isEditing) {
    return (
      <div className="mb-4 space-y-2">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Trade notes — why you entered, adjustments, review..."
          className="w-full px-3 py-2 text-sm bg-bg-secondary rounded-lg border border-border-default text-text-primary resize-none"
          rows={3}
          autoFocus
        />
        <div className="flex gap-2">
          <button
            onClick={() => { onSave({ id: positionId, notes: input }); setIsEditing(false); }}
            className="text-xs px-3 py-1.5 bg-accent-green/20 text-accent-green rounded-lg font-medium"
          >Save</button>
          <button onClick={() => setIsEditing(false)} className="text-xs px-3 py-1.5 text-text-tertiary hover:text-text-primary">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <button
        onClick={() => { setIsEditing(true); setInput(displayText || ''); }}
        className="text-xs text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer flex items-center gap-1.5"
      >
        {displayText ? (
          <span className="text-text-secondary truncate max-w-[300px]" title={displayText}>
            {displayText}
          </span>
        ) : (
          <span>+ Add notes</span>
        )}
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
      </button>
    </div>
  );
};
