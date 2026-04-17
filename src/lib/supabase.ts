import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from './utils';
// Keep startup resilient: missing Vite env should not hard-crash before React can render.

const missingConfigMessage =
  !SUPABASE_URL || !SUPABASE_KEY
    ? 'Missing Supabase client env. Expected VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY at build time.'
    : null;

let initError: Error | null = missingConfigMessage ? new Error(missingConfigMessage) : null;

function throwingClient(error: Error): SupabaseClient {
  return new Proxy({} as SupabaseClient, {
    get() {
      throw error;
    },
  });
}

export const supabase: SupabaseClient = (() => {
  if (initError) return throwingClient(initError);

  try {
    return createClient(SUPABASE_URL, SUPABASE_KEY);
  } catch (error) {
    initError = error instanceof Error ? error : new Error(String(error));
    return throwingClient(initError);
  }
})();

export const supabaseInitError = initError;
export const supabaseReady = !supabaseInitError;
