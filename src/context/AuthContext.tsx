import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase, supabaseInitError, supabaseReady } from '../lib/supabase';
import type { Session } from '@supabase/supabase-js';

interface AuthContextValue {
  session: Session | null;
  authLoading: boolean;
  authError: string | null;
  isAuthenticated: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(supabaseInitError?.message ?? null);

  useEffect(() => {
    if (!supabaseReady) {
      setAuthLoading(false);
      return;
    }

    let isMounted = true;

    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        if (!isMounted) return;
        setSession(session);
      })
      .catch((error) => {
        if (!isMounted) return;
        setAuthError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!isMounted) return;
        setAuthLoading(false);
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isMounted) return;
      setSession(session);
      setAuthError(null);
      setAuthLoading(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const logout = async () => {
    if (!supabaseReady) return;
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, authLoading, authError, isAuthenticated: !!session, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
