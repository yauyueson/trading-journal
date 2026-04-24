import { describe, expect, it } from 'vitest';
import { requireSupabaseData, throwIfSupabaseError } from '../supabaseResult';

describe('supabaseResult helpers', () => {
  it('throws Supabase errors so mutations reject', () => {
    const error = new Error('insert failed');
    expect(() => throwIfSupabaseError({ data: null, error })).toThrow(error);
  });

  it('returns successful results unchanged', () => {
    const result = { data: { id: 'pos-1' }, error: null };
    expect(throwIfSupabaseError(result)).toBe(result);
  });

  it('requires data when a follow-up write depends on inserted rows', () => {
    expect(() => requireSupabaseData({ data: null, error: null }, 'missing row')).toThrow('missing row');
    expect(() => requireSupabaseData({ data: [], error: null }, 'missing row')).toThrow('missing row');
    expect(requireSupabaseData({ data: [{ id: 'pos-1' }], error: null }, 'missing row')).toEqual([{ id: 'pos-1' }]);
  });
});
