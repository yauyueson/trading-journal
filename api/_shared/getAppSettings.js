// api/_shared/getAppSettings.js
// Fetches the global app settings singleton from Supabase.
// Falls back to hardcoded defaults if the row is missing.

const DEFAULT_SETTINGS = {
  portfolio: { accountSize: 5700, riskPct: 1, stopOutPct: 50 },
  techScore: {
    weights: { w_mb: 30, w_bxs: 30, w_bxl: 15, w_ema: 15, w_mom: 10 },
    periods: {
      sc_mb_len: 20, sc_mb_smoothing: 7, sc_osc_len: 7,
      sc_bx_s1: 5, sc_bx_s2: 20, sc_bx_s3: 5,
      sc_bx_l1: 20, sc_bx_l2: 5,
    },
  },
};

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function getAppSettings(supabase) {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('settings')
      .eq('id', 1)
      .single();
    if (error || !data?.settings) return DEFAULT_SETTINGS;
    return {
      ...DEFAULT_SETTINGS,
      ...data.settings,
      portfolio: { ...DEFAULT_SETTINGS.portfolio, ...data.settings.portfolio },
      techScore: {
        weights: { ...DEFAULT_SETTINGS.techScore.weights, ...data.settings.techScore?.weights },
        periods: { ...DEFAULT_SETTINGS.techScore.periods, ...data.settings.techScore?.periods },
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
