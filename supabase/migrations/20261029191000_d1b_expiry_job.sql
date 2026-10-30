-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — D.1b: the expiry job (applied after the clean-up was approved)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Runs expire_abandoned_sessions() (D.1) every 15 minutes with pg_cron.
-- Each closed session gets a session_closures row with its reason.

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-abandoned-sessions') THEN
    PERFORM cron.unschedule('expire-abandoned-sessions');
  END IF;
  PERFORM cron.schedule('expire-abandoned-sessions', '*/15 * * * *', 'SELECT public.expire_abandoned_sessions()');
END
$do$;
