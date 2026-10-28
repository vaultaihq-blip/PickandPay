-- Rollback for 20261028150000_c3fix2_colors_countdown.sql
--
-- Pre-state: none of the objects below existed; the migration replaced no
-- existing function, trigger, policy or grant (only added). So the rollback
-- only removes what it added. The migration also ran one UPDATE (colour
-- backfill on session_participants.color, a new column) — dropping the
-- column undoes it.
--
-- Data note: dropping credit_balance_log loses the balance history written
-- since the migration. Keep it (comment the DROP TABLE out) unless that
-- history is unwanted.
--
-- Clients: a build that reads session_participants.color / the countdown
-- columns gets a PostgREST error once they are gone; roll the app back first.

BEGIN;

DROP TRIGGER IF EXISTS log_credit_balance ON public.profiles;
DROP FUNCTION IF EXISTS public.log_credit_balance();
DROP TABLE IF EXISTS public.credit_balance_log;

DROP FUNCTION IF EXISTS public.expire_countdown_cancel(uuid);
DROP FUNCTION IF EXISTS public.decide_countdown_cancel(uuid, boolean);
DROP FUNCTION IF EXISTS public.request_countdown_cancel(uuid);
DROP FUNCTION IF EXISTS public.resume_countdown(uuid, text);
DROP FUNCTION IF EXISTS public.countdown_snapshot(public.sessions);
DROP TRIGGER IF EXISTS session_countdown_state ON public.sessions;
DROP FUNCTION IF EXISTS public.session_countdown_state();
DROP FUNCTION IF EXISTS public.countdown_length_ms();
ALTER TABLE public.sessions
  DROP COLUMN IF EXISTS countdown_started_at,
  DROP COLUMN IF EXISTS countdown_paused_at,
  DROP COLUMN IF EXISTS countdown_remaining_ms,
  DROP COLUMN IF EXISTS cancel_request_user_id,
  DROP COLUMN IF EXISTS cancel_request_at,
  DROP COLUMN IF EXISTS cancel_last_decision,
  DROP COLUMN IF EXISTS cancel_last_user_id,
  DROP COLUMN IF EXISTS cancel_last_at;

DROP TRIGGER IF EXISTS assign_participant_color ON public.session_participants;
DROP FUNCTION IF EXISTS public.assign_participant_color();
DROP INDEX IF EXISTS public.session_participants_session_color_key;
ALTER TABLE public.session_participants DROP COLUMN IF EXISTS color;
DROP FUNCTION IF EXISTS public.session_color_palette();

-- Remove the migration's row so `supabase db push` would apply it again.
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261028150000';

COMMIT;
