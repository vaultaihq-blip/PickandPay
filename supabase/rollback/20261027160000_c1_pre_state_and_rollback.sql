-- C.1 pre-state snapshot and rollback, taken from production 2026-10-27T19:45:14Z
-- Source: pg_class / pg_proc / pg_trigger read via `supabase db query --linked`
-- just before applying supabase/migrations/20261027160000_c1_ocr_gate_r3.sql.
--
-- Pre-C.1 state:
--   ocr_requests ACL {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}
--     (RLS on, no policies, 80 rows)
--   ocr_gate / has_session_credit / enforce_session_credit did not exist
--   no enforce_session_credit_on_insert / enforce_participant_credit triggers
--
-- Edge function: parse-receipt v55 is byte-identical to the repo at commit
-- 28aff3c (checked with `supabase functions download`). To roll it back:
--   git show 28aff3c:supabase/functions/parse-receipt/index.ts > supabase/functions/parse-receipt/index.ts
--   supabase functions deploy parse-receipt --use-api
-- Roll the function back FIRST: the new function calls ocr_gate and, failing
-- closed, refuses every scan once ocr_gate is gone.

BEGIN;

DROP TRIGGER IF EXISTS enforce_session_credit_on_insert ON public.sessions;
DROP TRIGGER IF EXISTS enforce_participant_credit ON public.session_participants;
DROP FUNCTION IF EXISTS public.enforce_session_credit();
DROP FUNCTION IF EXISTS public.ocr_gate(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.has_session_credit(uuid);

GRANT ALL ON public.ocr_requests TO anon, authenticated;

COMMIT;
