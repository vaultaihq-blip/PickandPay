-- Rollback for 20261029170000_r8_join_code.sql
--
-- Pre-state (read from production before applying, 2026-10-29):
--   * sessions had no join_code; the client could INSERT host_id,
--     receipt_data, status and UPDATE receipt_data, status (unchanged by R8).
--   * Triggers on sessions: enforce_session_credit_on_insert,
--     guard_session_finalize, link_scan_on_session_insert,
--     session_countdown_state, set_session_original_host,
--     update_sessions_updated_at.
--   * No session_join_codes, join_code_attempts, join_code_alphabet,
--     join_code_max_failures, join_code_window_s, new_join_code,
--     set_session_join_code, resolve_join_code.
--
-- Data notes:
--   * The codes are lost with the column, and session_join_codes (the record
--     of every code ever given) is dropped. If R8 is applied again later, an
--     old code could in theory be given to a new session: copy
--     session_join_codes first and load it back before re-applying, to keep
--     "never reused".
--
-- Clients: roll the app back first — an R8 build reads sessions.join_code
-- and calls resolve_join_code.

BEGIN;

DROP FUNCTION IF EXISTS public.resolve_join_code(text);
DROP TRIGGER IF EXISTS set_session_join_code ON public.sessions;
DROP FUNCTION IF EXISTS public.set_session_join_code();
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_join_code_format;
DROP INDEX IF EXISTS public.sessions_join_code_key;
ALTER TABLE public.sessions DROP COLUMN IF EXISTS join_code;
DROP FUNCTION IF EXISTS public.new_join_code(uuid);
DROP FUNCTION IF EXISTS public.join_code_window_s();
DROP FUNCTION IF EXISTS public.join_code_max_failures();
DROP FUNCTION IF EXISTS public.join_code_alphabet();
DROP TABLE IF EXISTS public.join_code_attempts;
DROP TABLE IF EXISTS public.session_join_codes;

-- Remove the migration's row so `supabase db push` would apply it again.
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261029170000';

COMMIT;
