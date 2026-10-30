-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — sign-up credits: granted once per account, one source of truth
-- ─────────────────────────────────────────────────────────────────────────────
--
-- admin_set_signup_credits guarded idempotency with "only when the balance
-- is 0". Any user who had spent every credit could call
-- initialize-user-credits again and be granted the sign-up credits again,
-- without limit (reproduced over HTTP on 2026-10-27).
--
-- grant_signup_credits ties the grant to the email_signup_audit row instead:
-- one row per user (new unique index), inserted in the same transaction as the
-- credit update. A second call finds the row and grants nothing.
--
-- The amount itself lives in one place only: SIGNUP_CREDITS in
-- supabase/functions/initialize-user-credits/index.ts. profiles.bill_credits
-- defaults to 0, handle_new_user inserts 0, and the profile trigger forces 0
-- on client inserts, so no other path can produce a sign-up balance.

-- ── Column default: no implicit credits on insert ───────────────────────────
ALTER TABLE public.profiles ALTER COLUMN bill_credits SET DEFAULT 0;

-- ── One audit row per user ──────────────────────────────────────────────────
-- Keep the earliest row if any user has several (none expected in production).
DELETE FROM public.email_signup_audit a
USING public.email_signup_audit b
WHERE a.user_id = b.user_id
  AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX IF NOT EXISTS email_signup_audit_user_id_key
  ON public.email_signup_audit (user_id);

-- Accounts that existed before this migration already received their sign-up
-- credits (the old handle_new_user granted them directly). Mark them so the
-- new function never grants to them. hibp_status -1 = backfilled marker.
INSERT INTO public.email_signup_audit (user_id, email, in_breaches, is_established, free_credits_granted, hibp_status)
SELECT p.id, p.email, false, true, 0, -1
FROM public.profiles p
WHERE NOT EXISTS (SELECT 1 FROM public.email_signup_audit a WHERE a.user_id = p.id);

-- ── grant_signup_credits ────────────────────────────────────────────────────
-- Returns jsonb:
--   {"status":"granted","credits_added":n,"new_balance":n}
--   {"status":"already_granted","balance":n}
-- Raises when the user has no profile (the audit insert is rolled back too).

CREATE OR REPLACE FUNCTION public.grant_signup_credits(
  p_user_id        uuid,
  p_amount         integer,
  p_email          text,
  p_in_breaches    boolean,
  p_is_established boolean,
  p_hibp_status    integer
)
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

-- The old balance-guarded function is no longer called by anything.
REVOKE ALL ON FUNCTION public.admin_set_signup_credits(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
