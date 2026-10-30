-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — C0: credit and profile hardening (hotfix)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Audit of production on 2026-10-27 (pg_proc / pg_policies, read-only):
--
--   1. admin_grant_credits / admin_set_signup_credits were EXECUTE-able by
--      `anon`: anyone holding the public anon key could grant credits to any
--      account. 010/015 revoked PUBLIC and authenticated but not anon, which
--      Supabase grants on every new function by default.
--   2. increment_credits / decrement_credits (any user_id, any amount, no
--      caller check) were EXECUTE-able by PUBLIC/anon/authenticated.
--   3. add_user_credits: 008 revoked authenticated, but PUBLIC kept EXECUTE,
--      so authenticated could still call it (+50 per call, no limit).
--   4. protect_sensitive_profile_fields (012) is SECURITY DEFINER owned by
--      postgres and authorises when current_user = 'postgres'. Inside a
--      SECURITY DEFINER function current_user is always the owner, so it
--      authorised every write: a user could set bill_credits / is_pro on
--      their own row with a plain UPDATE. It also never covered INSERT.
--   5. process_referral(referrer_id, referred_id) never checked the caller:
--      anyone (anon included) could attribute referrals between any pair.
--   6. handle_new_user (015) inserts into profiles.provider, a column that
--      does not exist in production: every sign-up since 015 failed with
--      42703 ("Database error saving new user"). Last account: 2026-05-19.
--
-- Rollback: supabase/rollback/20261027120000_c0_pre_state_and_rollback.sql
-- (exact pre-C0 definitions and grants, read from production before this ran).
--
-- Not changed here, on purpose:
--   • Trigger functions (handle_new_user, protect_*, update_updated_at_column)
--     keep their EXECUTE grants. A trigger function cannot be called through
--     PostgREST or directly, so revoking gains nothing, and the auth service
--     role fires handle_new_user on sign-up.
--   • is_session_host / is_session_member / is_email_verified: read-only,
--     keyed on auth.uid(), and used by RLS policies evaluated as
--     `authenticated`. Out of scope for a credits hotfix.

-- ── 1–3. Credit-granting functions: service_role only ───────────────────────
-- Callers: grant-credits-from-purchase → admin_grant_credits and
-- initialize-user-credits → admin_set_signup_credits, both with the
-- service-role client. increment_credits / decrement_credits have no caller.
-- add_user_credits' only caller is lib/revenuecat.ts (client), removed in A.

REVOKE ALL ON FUNCTION public.add_user_credits(integer)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_grant_credits(uuid, integer)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_signup_credits(uuid, integer)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_credits(uuid, integer)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decrement_credits(uuid, integer)         FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.add_user_credits(integer)               TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_grant_credits(uuid, integer)      TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_signup_credits(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_credits(uuid, integer)        TO service_role;
GRANT EXECUTE ON FUNCTION public.decrement_credits(uuid, integer)        TO service_role;

-- ── deduct_credit: signed-in users only (replaced server-side in C) ─────────
REVOKE ALL ON FUNCTION public.deduct_credit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deduct_credit() TO authenticated, service_role;

-- ── 4. Profile field protection ─────────────────────────────────────────────
-- SECURITY INVOKER, so current_user is the real caller: `authenticated` for
-- app traffic, `service_role` for edge functions, and the owner (postgres)
-- inside SECURITY DEFINER RPCs (deduct_credit, admin_*, process_referral,
-- handle_new_user), which also set app.credit_authorized.
--
-- UPDATE that changes a protected column without authorisation is refused
-- (42501) rather than silently reverted, so the caller learns it failed.
-- INSERT without authorisation gets the safe defaults instead: the only
-- client insert (app/(app)/index.tsx profile fallback) sends bill_credits: 3
-- and must not mint credits; initialize-user-credits sets the real amount.

CREATE OR REPLACE FUNCTION public.protect_sensitive_profile_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF coalesce(current_setting('app.credit_authorized', true), '') = 'true'
     OR current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.bill_credits   := 0;
    NEW.is_pro         := false;
    NEW.pro_expires_at := NULL;
    NEW.referral_count := 0;
    NEW.referred_by    := NULL;
    RETURN NEW;
  END IF;

  IF NEW.bill_credits   IS DISTINCT FROM OLD.bill_credits
     OR NEW.is_pro         IS DISTINCT FROM OLD.is_pro
     OR NEW.pro_expires_at IS DISTINCT FROM OLD.pro_expires_at
     OR NEW.referral_count IS DISTINCT FROM OLD.referral_count
     OR NEW.referred_by    IS DISTINCT FROM OLD.referred_by THEN
    RAISE EXCEPTION 'bill_credits, is_pro, pro_expires_at, referral_count and referred_by can only be changed by the server'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_bill_credits ON public.profiles;
CREATE TRIGGER protect_bill_credits
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_sensitive_profile_fields();

-- ── 5. process_referral: only the referred user may claim their referral ────
-- The client (store/authStore.ts processReferral) already passes its own id
-- as referred_id, so this check changes nothing for the app.

CREATE OR REPLACE FUNCTION public.process_referral(referrer_id uuid, referred_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM referred_id THEN
    RAISE EXCEPTION 'A referral can only be claimed by the referred user' USING ERRCODE = '42501';
  END IF;

  -- No-op: a user cannot refer themselves
  IF referrer_id = referred_id THEN
    RETURN;
  END IF;

  -- No-op: referrer has reached the 5-referral cap
  IF (SELECT referral_count FROM public.profiles WHERE id = referrer_id) >= 5 THEN
    RETURN;
  END IF;

  -- No-op: referred user was already referred by someone
  IF (SELECT referred_by FROM public.profiles WHERE id = referred_id) IS NOT NULL THEN
    RETURN;
  END IF;

  -- Authorize the upcoming writes so protect_sensitive_profile_fields trigger
  -- allows changes to bill_credits, referral_count, and referred_by.
  -- The third argument (true) makes this LOCAL to the current transaction.
  PERFORM set_config('app.credit_authorized', 'true', true);

  -- Give referrer +1 credit and increment their referral counter
  UPDATE public.profiles
  SET bill_credits   = bill_credits + 1,
      referral_count = referral_count + 1
  WHERE id = referrer_id;

  -- Mark the referred user so this bonus cannot be claimed again
  UPDATE public.profiles
  SET referred_by = referrer_id
  WHERE id = referred_id;

  -- Revoke authorization for any subsequent writes in the same transaction
  PERFORM set_config('app.credit_authorized', 'false', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.process_referral(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_referral(uuid, uuid) TO authenticated, service_role;

-- ── 6. handle_new_user: drop the non-existent profiles.provider column ──────
-- Credits stay at 0 here; initialize-user-credits sets the sign-up amount.

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
