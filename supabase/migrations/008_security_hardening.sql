-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — Security Hardening
-- Closes two attack surfaces identified in the production audit:
--   1. Removes direct client access to add_user_credits()
--   2. Extends profile field protection to cover is_pro, pro_expires_at,
--      referral_count, and referred_by alongside the existing bill_credits guard
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Revoke client access to add_user_credits ─────────────────────────────
-- add_user_credits() was previously GRANTed to authenticated users, meaning any
-- authenticated client could call supabase.rpc("add_user_credits", { amount: 50 })
-- without making a real purchase.
-- Credits must only be added via a trusted path:
--   RevenueCat purchase → webhook → Supabase Edge Function (service_role key)
-- The function itself is not dropped — only the GRANT is revoked so that
-- service_role callers (Edge Functions) can still invoke it.

REVOKE EXECUTE ON FUNCTION public.add_user_credits(INTEGER) FROM authenticated;

-- ─── 2. Extended profile field protection trigger ─────────────────────────────
-- The existing protect_bill_credits() trigger only guarded the bill_credits column.
-- The other monetization-sensitive columns (is_pro, pro_expires_at, referral_count,
-- referred_by) were writable by any authenticated user via direct REST API update,
-- bypassing application logic entirely.
--
-- This function replaces protect_bill_credits() and guards all five fields.
--
-- Protected fields and the attack they block:
--   bill_credits   — free scans (each credit = one OCR scan)
--   is_pro         — is_pro = true bypasses all credit checks → unlimited free scans
--   pro_expires_at — manipulating expiry = permanent pro status without payment
--   referral_count — capped at 5 in process_referral(); direct write resets the cap
--   referred_by    — NULL → referrer_id re-enables referral bonus for existing users
--
-- Authorization rules (a write is allowed if EITHER condition is true):
--   a) app.credit_authorized = 'true'
--      Set per-transaction by SECURITY DEFINER functions (deduct_credit,
--      add_user_credits, process_referral) before modifying credits.
--      Regular REST API calls never set this variable.
--   b) role = 'service_role'
--      Supabase Edge Functions and the RevenueCat webhook use the service_role
--      key and are trusted server-side callers.
--
-- Unauthorised changes are silently reverted to OLD values (no error raised,
-- so the UPDATE succeeds for unprotected columns while sensitive ones are reset).

CREATE OR REPLACE FUNCTION public.protect_sensitive_profile_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  is_authorized BOOLEAN;
BEGIN
  -- Determine whether this write is coming from a trusted source
  is_authorized := (
    current_setting('app.credit_authorized', true) = 'true'
    OR current_setting('role', true) = 'service_role'
  );

  IF NOT is_authorized THEN

    -- bill_credits: controls how many OCR scans the user can perform
    IF NEW.bill_credits IS DISTINCT FROM OLD.bill_credits THEN
      NEW.bill_credits := OLD.bill_credits;
    END IF;

    -- is_pro: when TRUE, all credit checks are skipped — effectively unlimited scans
    IF NEW.is_pro IS DISTINCT FROM OLD.is_pro THEN
      NEW.is_pro := OLD.is_pro;
    END IF;

    -- pro_expires_at: expiry of the pro subscription; direct write = permanent pro
    IF NEW.pro_expires_at IS DISTINCT FROM OLD.pro_expires_at THEN
      NEW.pro_expires_at := OLD.pro_expires_at;
    END IF;

    -- referral_count: process_referral() caps bonuses at 5 referrals;
    -- direct write resets or inflates the counter, bypassing the cap
    IF NEW.referral_count IS DISTINCT FROM OLD.referral_count THEN
      NEW.referral_count := OLD.referral_count;
    END IF;

    -- referred_by: once set, prevents a user from claiming referral bonuses again;
    -- setting it to NULL re-enables the bonus; changing it re-attributes the referrer
    IF NEW.referred_by IS DISTINCT FROM OLD.referred_by THEN
      NEW.referred_by := OLD.referred_by;
    END IF;

  END IF;

  RETURN NEW;
END;
$$;

-- Drop the old trigger (pointed at the old protect_bill_credits() function)
-- and re-create it under the same name so existing references remain valid.
-- The trigger name stays protect_bill_credits for backwards compatibility.
DROP TRIGGER IF EXISTS protect_bill_credits ON public.profiles;

CREATE TRIGGER protect_bill_credits
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_sensitive_profile_fields();
