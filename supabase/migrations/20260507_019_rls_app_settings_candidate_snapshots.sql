-- 019_rls_app_settings_candidate_snapshots.sql
-- Enable RLS on tables flagged by the Supabase security advisor as exposed to
-- anon clients without RLS. Single-user app: policies are permissive (USING
-- true) to preserve current behavior. Enabling RLS makes future tightening
-- possible without re-architecting the tables, and stops the advisor from
-- flagging them. Pattern matches 018_execution_tickets.sql.

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON app_settings FOR SELECT USING (true);
CREATE POLICY "Service role write" ON app_settings FOR ALL USING (true);

ALTER TABLE candidate_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON candidate_snapshots FOR SELECT USING (true);
CREATE POLICY "Service role write" ON candidate_snapshots FOR ALL USING (true);
