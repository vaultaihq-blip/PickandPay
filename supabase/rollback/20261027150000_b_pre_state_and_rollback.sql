-- B pre-state snapshot and rollback, taken from production 2026-10-27T19:25:57.214Z
-- Source: pg_class / pg_attribute / pg_policies / pg_proc read via `supabase db query --linked`
-- just before applying supabase/migrations/20261027150000_b_session_data.sql.
--
-- Pre-B state:
--   sessions             table ACL {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}
--   session_participants table ACL {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}
--   no column-level ACLs on either table
--   policy "Users can join sessions" (INSERT, authenticated) WITH CHECK (auth.uid() = user_id)
--   grant_signup_credits(uuid,integer,text,boolean,boolean,integer)  acl {postgres=X/postgres,service_role=X/postgres}
--   handle_new_user()  acl {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   sessions had no cent_adjustment_* columns; set_cent_adjustment / set_participant_paid /
--   set_participant_covered_by / grant_signup_credits(uuid,text,boolean,boolean,integer) did not exist.
--
-- Running this file restores that state. WARNING:
--   * drops sessions.cent_adjustment_* (stored rounding assignments are lost);
--   * the edge function initialize-user-credits must go back to the 6-argument call:
--     git show 1baf65f:supabase/functions/initialize-user-credits/index.ts, then deploy it;
--   * the app build from b742854 calls the dropped RPCs (paid / covered / rounding fail).

BEGIN;

DROP FUNCTION IF EXISTS public.set_cent_adjustment(uuid, uuid, integer, text);
DROP FUNCTION IF EXISTS public.set_participant_paid(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.set_participant_covered_by(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.grant_signup_credits(uuid, text, boolean, boolean, integer);

ALTER TABLE public.sessions
  DROP COLUMN IF EXISTS cent_adjustment_cents,
  DROP COLUMN IF EXISTS cent_adjustment_user_id,
  DROP COLUMN IF EXISTS cent_adjustment_method;

-- Column grants added by B, then the table-level grants it revoked.
REVOKE INSERT (host_id, receipt_data, status), UPDATE (host_id, receipt_data, status) ON public.sessions FROM authenticated;
REVOKE INSERT (session_id, user_id, role, status), UPDATE (status, selections) ON public.session_participants FROM authenticated;
GRANT ALL ON public.sessions TO anon, authenticated;
GRANT ALL ON public.session_participants TO anon, authenticated;

DROP POLICY IF EXISTS "Users can join sessions" ON public.session_participants;
CREATE POLICY "Users can join sessions"
  ON public.session_participants AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- grant_signup_credits, 6-argument version (acl before B: {postgres=X/postgres,service_role=X/postgres})
CREATE OR REPLACE FUNCTION public.grant_signup_credits(p_user_id uuid, p_amount integer, p_email text, p_in_breaches boolean, p_is_established boolean, p_hibp_status integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid credit amount: %', p_amount USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.email_signup_audit (user_id, email, in_breaches, is_established, free_credits_granted, hibp_status)
  VALUES (p_user_id, p_email, p_in_breaches, p_is_established, p_amount, p_hibp_status)
  ON CONFLICT (user_id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT bill_credits INTO v_balance FROM public.profiles WHERE id = p_user_id;
    RETURN jsonb_build_object('status', 'already_granted', 'balance', v_balance);
  END IF;

  PERFORM set_config('app.credit_authorized', 'true', true);

  UPDATE public.profiles
  SET bill_credits = bill_credits + p_amount
  WHERE id = p_user_id
  RETURNING bill_credits INTO v_balance;

  PERFORM set_config('app.credit_authorized', 'false', true);

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'User not found: %', p_user_id USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object('status', 'granted', 'credits_added', p_amount, 'new_balance', v_balance);
END;
$function$;
REVOKE ALL ON FUNCTION public.grant_signup_credits(uuid, integer, text, boolean, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_signup_credits(uuid, integer, text, boolean, boolean, integer) TO service_role;

-- handle_new_user (acl before B: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}; CREATE OR REPLACE keeps the ACL)
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, name, email, bill_credits)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email, 'User'),
    NEW.email,
    0  -- credits set by initialize-user-credits edge function after verification
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- After commit, confirm: select relacl from pg_class where relname in ('sessions','session_participants');
COMMIT;
