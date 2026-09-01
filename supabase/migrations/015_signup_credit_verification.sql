-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — Signup Credit Verification
-- Changes the initial credit grant from a fixed 3 to a verified amount (2 or 5)
-- determined server-side after an email reputation check.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Start new accounts at 0 credits ───────────────────────────────────────
-- The initialize-user-credits edge function now determines the correct amount
-- (2 for new/unknown emails, 5 for established ones) and calls
-- admin_set_signup_credits below. Starting at 0 prevents any credits being
-- usable before verification completes.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
$$;

-- ─── 2. Email signup audit table ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_signup_audit (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  email                 TEXT        NOT NULL,
  in_breaches           BOOLEAN,
  is_established        BOOLEAN     NOT NULL DEFAULT false,
  free_credits_granted  INTEGER     NOT NULL,
  hibp_status           INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_signup_audit_user ON public.email_signup_audit(user_id);

ALTER TABLE public.email_signup_audit ENABLE ROW LEVEL SECURITY;

-- Users can read their own audit row (e.g., for debugging in-app)
CREATE POLICY "Users can read own signup audit"
  ON public.email_signup_audit FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Only service_role may insert (edge function uses service_role key)

-- ─── 3. admin_set_signup_credits ─────────────────────────────────────────────
-- Idempotent: only applies when bill_credits is still 0 (initial state).
-- Prevents double-granting if the client calls initialize-user-credits twice.

CREATE OR REPLACE FUNCTION public.admin_set_signup_credits(p_user_id UUID, p_amount INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.admin_set_signup_credits(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_signup_credits(UUID, INTEGER) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_set_signup_credits(UUID, INTEGER) TO service_role;
