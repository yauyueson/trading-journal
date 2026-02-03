import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from './utils';
// We might generate types later, but for now use generic

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
