-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — Fix process_referral() to work with the protect_sensitive_profile_fields trigger
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Problem: 007_referral_rpc.sql's process_referral(UUID) does a direct UPDATE
-- on bill_credits and referral_count. Since 008_security_hardening.sql added
-- the protect_sensitive_profile_fields trigger, those updates are silently
-- reverted unless app.credit_authorized = 'true' is set first.
--
-- Fix: Rewrite as process_referral(referrer_id UUID, referred_id UUID) with:
--   - PERFORM set_config('app.credit_authorized', 'true', true) before the UPDATEs
--   - PERFORM set_config('app.credit_authorized', 'false', true) after
--   - All guards (self-referral, cap, already-referred) checked before any writes
--
-- Signature change: adds referred_id UUID parameter so the function no longer
-- relies on auth.uid() for the referred user. The caller (authenticated client)
-- passes both IDs explicitly, making the function testable and auditable.
--
-- The old single-argument function is dropped to avoid ambiguity.

-- ─── Drop old single-argument version ────────────────────────────────────────
-- 007_referral_rpc.sql registered process_referral(uuid) — drop it so that
-- client calls with the wrong signature fail fast rather than silently using
-- stale logic.

DROP FUNCTION IF EXISTS public.process_referral(UUID);

-- ─── Rewrite with authorized UPDATE pattern ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.process_referral(referrer_id UUID, referred_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

-- Only authenticated users may call this function.
-- The referred user is responsible for calling it after sign-up.
REVOKE ALL ON FUNCTION public.process_referral(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_referral(UUID, UUID) TO authenticated;
