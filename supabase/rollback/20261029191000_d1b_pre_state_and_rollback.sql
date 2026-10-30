-- Rollback for 20261029191000_d1b_expiry_job.sql
--
-- Pre-state (production, 2026-10-29): pg_cron available (1.6.4) but not
-- installed; no cron jobs.
-- Sessions the job already closed stay closed (their reasons are in
-- session_closures).

BEGIN;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-abandoned-sessions') THEN
    PERFORM cron.unschedule('expire-abandoned-sessions');
  END IF;
END
$do$;
DROP EXTENSION IF EXISTS pg_cron;

-- Remove the migration's row so `supabase db push` would apply it again.
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261029191000';

COMMIT;
