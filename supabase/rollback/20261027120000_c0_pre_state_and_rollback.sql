-- C0 pre-state snapshot and rollback, taken from production 2026-10-27T17:03:53.050Z
-- Source: pg_proc / pg_trigger read via `supabase db query --linked` just before
-- applying supabase/migrations/20261027120000_c0_credit_hardening.sql.
--
-- Running this file restores the exact pre-C0 definitions and EXECUTE grants.
-- WARNING: that includes the pre-C0 handle_new_user(), which inserts into the
-- non-existent profiles.provider column, so new sign-ups fail again after a rollback.

BEGIN;

-- ── add_user_credits(integer)  (acl before C0: {=X/postgres,postgres=X/postgres,anon=X/postgres,service_role=X/postgres})
CREATE OR REPLACE FUNCTION public.add_user_credits(amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_credits INTEGER;
BEGIN
  IF amount IS NULL OR amount <= 0 OR amount > 50 THEN
    RAISE EXCEPTION 'Invalid credit amount: must be between 1 and 50';
  END IF;

  -- Authorize the credit change for the trigger
  PERFORM set_config('app.credit_authorized', 'true', true);

  UPDATE public.profiles
  SET bill_credits = bill_credits + amount
  WHERE id = auth.uid()
  RETURNING bill_credits INTO v_new_credits;

  RETURN v_new_credits;
END;
$function$;
REVOKE ALL ON FUNCTION public.add_user_credits(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_user_credits(integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_user_credits(integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.add_user_credits(integer) TO anon;
GRANT EXECUTE ON FUNCTION public.add_user_credits(integer) TO service_role;

-- ── admin_grant_credits(uuid,integer)  (acl before C0: {postgres=X/postgres,anon=X/postgres,service_role=X/postgres})
CREATE OR REPLACE FUNCTION public.admin_grant_credits(p_user_id uuid, p_amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_credits INTEGER;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid credit amount: must be > 0';
  END IF;

  -- Authorize the upcoming update so the protect_sensitive_profile_fields trigger
  -- allows the bill_credits change (belt-and-suspenders with the service_role check)
  PERFORM set_config('app.credit_authorized', 'true', true);

  UPDATE public.profiles
  SET bill_credits = bill_credits + p_amount
  WHERE id = p_user_id
  RETURNING bill_credits INTO v_new_credits;

  IF v_new_credits IS NULL THEN
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;

  RETURN v_new_credits;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_grant_credits(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_grant_credits(uuid,integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_grant_credits(uuid,integer) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_grant_credits(uuid,integer) TO service_role;

-- ── admin_set_signup_credits(uuid,integer)  (acl before C0: {postgres=X/postgres,anon=X/postgres,service_role=X/postgres})
CREATE OR REPLACE FUNCTION public.admin_set_signup_credits(p_user_id uuid, p_amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current INTEGER;
  v_new     INTEGER;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid credit amount: must be > 0';
  END IF;

  SELECT bill_credits INTO v_current FROM public.profiles WHERE id = p_user_id;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;

  -- Idempotency guard: only set once (when still at 0)
  IF v_current > 0 THEN
    RETURN v_current;
  END IF;

  PERFORM set_config('app.credit_authorized', 'true', true);

  UPDATE public.profiles
  SET bill_credits = p_amount
  WHERE id = p_user_id
  RETURNING bill_credits INTO v_new;

  RETURN v_new;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_set_signup_credits(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_signup_credits(uuid,integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_set_signup_credits(uuid,integer) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_set_signup_credits(uuid,integer) TO service_role;

-- ── increment_credits(uuid,integer)  (acl before C0: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres})
CREATE OR REPLACE FUNCTION public.increment_credits(user_id uuid, amount integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  UPDATE profiles SET bill_credits = bill_credits + amount WHERE id = user_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.increment_credits(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.increment_credits(uuid,integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_credits(uuid,integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.increment_credits(uuid,integer) TO anon;
GRANT EXECUTE ON FUNCTION public.increment_credits(uuid,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_credits(uuid,integer) TO service_role;

-- ── decrement_credits(uuid,integer)  (acl before C0: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres})
CREATE OR REPLACE FUNCTION public.decrement_credits(user_id uuid, amount integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  UPDATE profiles SET bill_credits = GREATEST(bill_credits - amount, 0) WHERE id = user_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.decrement_credits(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decrement_credits(uuid,integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.decrement_credits(uuid,integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.decrement_credits(uuid,integer) TO anon;
GRANT EXECUTE ON FUNCTION public.decrement_credits(uuid,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decrement_credits(uuid,integer) TO service_role;

-- ── deduct_credit()  (acl before C0: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres})
CREATE OR REPLACE FUNCTION public.deduct_credit()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_credits    INTEGER;
  v_is_pro     BOOLEAN;
  v_provider   TEXT;
  v_confirmed  TIMESTAMPTZ;
BEGIN
  -- Email verification gate: block disposable/unverified accounts
  SELECT
    raw_app_meta_data->>'provider',
    email_confirmed_at
  INTO v_provider, v_confirmed
  FROM auth.users
  WHERE id = auth.uid();

  IF v_provider NOT IN ('google', 'apple', 'azure', 'facebook', 'twitter')
     AND v_confirmed IS NULL THEN
    RAISE EXCEPTION 'Email not verified' USING ERRCODE = 'P0001';
  END IF;

  SELECT bill_credits, COALESCE(is_pro, FALSE)
  INTO v_credits, v_is_pro
  FROM public.profiles
  WHERE id = auth.uid()
  FOR UPDATE;

  IF v_is_pro THEN RETURN TRUE; END IF;
  IF v_credits IS NULL OR v_credits <= 0 THEN RETURN FALSE; END IF;

  -- Authorize the credit change for the trigger
  PERFORM set_config('app.credit_authorized', 'true', true);

  UPDATE public.profiles
  SET bill_credits = bill_credits - 1
  WHERE id = auth.uid();

  RETURN TRUE;
END;
$function$;
REVOKE ALL ON FUNCTION public.deduct_credit() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deduct_credit() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.deduct_credit() TO postgres;
GRANT EXECUTE ON FUNCTION public.deduct_credit() TO anon;
GRANT EXECUTE ON FUNCTION public.deduct_credit() TO authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_credit() TO service_role;

-- ── process_referral(uuid,uuid)  (acl before C0: {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres})
CREATE OR REPLACE FUNCTION public.process_referral(referrer_id uuid, referred_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
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
REVOKE ALL ON FUNCTION public.process_referral(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.process_referral(uuid,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.process_referral(uuid,uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.process_referral(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_referral(uuid,uuid) TO service_role;

-- ── handle_new_user()  (acl before C0: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres})
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  provider_name TEXT;
BEGIN
  provider_name := NEW.raw_app_meta_data->>'provider';

  INSERT INTO public.profiles (id, name, email, provider, bill_credits)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email, 'User'),
    NEW.email,
    provider_name,
    0  -- credits set by initialize-user-credits edge function after verification
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO postgres;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO anon;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

-- ── protect_sensitive_profile_fields()  (acl before C0: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres})
CREATE OR REPLACE FUNCTION public.protect_sensitive_profile_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  is_authorized BOOLEAN;
BEGIN
  is_authorized := (
    current_setting('app.credit_authorized', true) = 'true'
    OR current_user = 'supabase_admin'
    OR current_user = 'postgres'
    OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
  );

  IF NOT is_authorized THEN
    NEW.bill_credits   := OLD.bill_credits;
    NEW.is_pro         := OLD.is_pro;
    NEW.pro_expires_at := OLD.pro_expires_at;
    NEW.referral_count := OLD.referral_count;
    NEW.referred_by    := OLD.referred_by;
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.protect_sensitive_profile_fields() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.protect_sensitive_profile_fields() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.protect_sensitive_profile_fields() TO postgres;
GRANT EXECUTE ON FUNCTION public.protect_sensitive_profile_fields() TO anon;
GRANT EXECUTE ON FUNCTION public.protect_sensitive_profile_fields() TO authenticated;
GRANT EXECUTE ON FUNCTION public.protect_sensitive_profile_fields() TO service_role;

-- ── trigger protect_bill_credits (before C0)
DROP TRIGGER IF EXISTS protect_bill_credits ON public.profiles;
CREATE TRIGGER protect_bill_credits BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION protect_sensitive_profile_fields();

COMMIT;

-- ── Appendix: EXECUTE ACLs of every public function before C0 (reference only)
--   add_user_credits(integer)  {=X/postgres,postgres=X/postgres,anon=X/postgres,service_role=X/postgres}
--   admin_grant_credits(uuid,integer)  {postgres=X/postgres,anon=X/postgres,service_role=X/postgres}
--   admin_set_signup_credits(uuid,integer)  {postgres=X/postgres,anon=X/postgres,service_role=X/postgres}
--   decrement_credits(uuid,integer)  {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   deduct_credit()  {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   handle_new_user()  {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   increment_credits(uuid,integer)  {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   is_email_verified()  {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   is_session_host(uuid)  {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   is_session_member(uuid)  {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   process_referral(uuid,uuid)  {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   protect_bill_credits()  {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   protect_sensitive_profile_fields()  {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   update_updated_at_column()  {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- Triggers on profiles/sessions/session_participants before C0:
--   CREATE TRIGGER protect_bill_credits BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION protect_sensitive_profile_fields()
--   CREATE TRIGGER update_participants_updated_at BEFORE UPDATE ON public.session_participants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
--   CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
--   CREATE TRIGGER update_sessions_updated_at BEFORE UPDATE ON public.sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
