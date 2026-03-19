import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { BuyModal } from '../components/BuyModal';
import { useMoveToActive } from '../hooks/usePositionMutations';
import type { Position } from '../lib/types';

interface BuyModalContextValue {
  openBuyModal: (position: Position) => void;
  closeBuyModal: () => void;
}

const BuyModalContext = createContext<BuyModalContextValue | null>(null);

export const BuyModalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [buyingItem, setBuyingItem] = useState<Position | null>(null);
  const moveToActiveMut = useMoveToActive();

  const openBuyModal = useCallback((position: Position) => {
    setBuyingItem(position);
  }, []);

  const closeBuyModal = useCallback(() => {
    setBuyingItem(null);
  }, []);

  const value = useMemo(() => ({ openBuyModal, closeBuyModal }), [openBuyModal, closeBuyModal]);

  return (
    <BuyModalContext.Provider value={value}>
      {children}
      {buyingItem && (
        <BuyModal
          position={buyingItem}
          onConfirm={async (qty, price) => {
            moveToActiveMut.mutate({ position: buyingItem, qty, price });
            setBuyingItem(null);
          }}
          onCancel={() => setBuyingItem(null)}
        />
      )}
    </BuyModalContext.Provider>
  );
};

export function useBuyModal() {
  const ctx = useContext(BuyModalContext);
  if (!ctx) throw new Error('useBuyModal must be used within BuyModalProvider');
  return ctx;
}
