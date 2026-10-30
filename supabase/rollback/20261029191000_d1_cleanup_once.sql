-- D.1 one-off clean-up (run once, by hand, after the counts were approved).
-- Closes every open session of the test accounts, except any with activity in
-- the last 30 minutes (someone may be testing right now). Each one gets a
-- session_closures row with reason 'cleanup'. Not reversible as data: the
-- previous status of each session is kept in session_closures.previous_status
-- if it ever needs to be put back.
BEGIN;
SELECT set_config('app.close_reason', 'cleanup', true);
WITH target AS (
  SELECT s.id FROM public.sessions s
  WHERE s.status <> 'closed'
    AND public.session_last_activity(s) < now() - interval '30 minutes'
  FOR UPDATE SKIP LOCKED
)
UPDATE public.sessions SET status = 'closed' WHERE id IN (SELECT id FROM target);
SELECT set_config('app.close_reason', '', true);
SELECT jsonb_build_object(
  'closed_by_cleanup', (SELECT count(*) FROM public.session_closures WHERE reason = 'cleanup' AND closed_at > now() - interval '5 minutes'),
  'still_open', (SELECT count(*) FROM public.sessions WHERE status <> 'closed')) AS v;
COMMIT;
