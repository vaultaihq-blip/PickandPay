-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — Fix protect_sensitive_profile_fields role detection
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Problem: current_setting('role', true) = 'service_role' is unreliable in
-- Supabase hosted environments. The session GUC 'role' reflects the PostgREST
-- claim role, but inside a SECURITY DEFINER trigger the GUC may not carry the
-- original caller's role correctly, causing service_role callers to fail the
-- check and having the trigger revert their writes.
--
-- Fix: replace the GUC role check with superuser detection via pg_roles, which
-- is always accurate regardless of PostgREST claim propagation:
--   • current_setting('app.credit_authorized', true) — set by SECURITY DEFINER
--     RPCs (deduct_credit, admin_grant_credits, process_referral) before writes
--   • current_user = 'supabase_admin' / 'postgres' — direct DB connections
--   • rolsuper FROM pg_roles — service_role has superuser privileges in Supabase

CREATE OR REPLACE FUNCTION public.protect_sensitive_profile_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
$$;

DROP TRIGGER IF EXISTS protect_bill_credits ON public.profiles;

CREATE TRIGGER protect_bill_credits
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_sensitive_profile_fields();
