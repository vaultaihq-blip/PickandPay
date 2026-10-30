-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — Credit Transactions (idempotency + audit trail)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- This table is the idempotency guard for the RevenueCat webhook.
-- Each RevenueCat event has a unique ID. Before granting credits the edge
-- function inserts a row here. The UNIQUE constraint on revenuecat_event_id
-- means a second delivery of the same event fails silently (ON CONFLICT).
--
-- Secondary benefit: full audit trail of every credit grant, linkable to
-- the RevenueCat event and the product purchased.

CREATE TABLE IF NOT EXISTS public.credit_transactions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  revenuecat_event_id   TEXT        UNIQUE NOT NULL,
  user_id               UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  amount                INTEGER     NOT NULL,
  product_id            TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_transactions_user_idx
  ON public.credit_transactions(user_id);

ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

-- INSERT: no policy → only service_role (Edge Function) can insert.
-- RLS blocks all INSERT from authenticated/anon roles without an explicit policy.

-- SELECT: authenticated users may read their own transaction history
CREATE POLICY "Users can view own credit transactions"
  ON public.credit_transactions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ─── admin_grant_credits ──────────────────────────────────────────────────────
-- Atomic credit increment by explicit user_id.
-- Used by the grant-credits-from-purchase Edge Function which runs as service_role
-- and therefore cannot rely on auth.uid() (no JWT in the request context).
--
-- The PERFORM set_config('app.credit_authorized', 'true', true) call satisfies
-- the protect_sensitive_profile_fields trigger's authorization check; additionally,
-- the service_role check in that trigger would also allow the write on its own.
-- Both mechanisms are set to be explicit about intent.

CREATE OR REPLACE FUNCTION public.admin_grant_credits(p_user_id UUID, p_amount INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

-- Explicitly lock down who can call this function.
-- service_role retains access through its superuser-equivalent privileges.
REVOKE ALL ON FUNCTION public.admin_grant_credits(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_grant_credits(UUID, INTEGER) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_grant_credits(UUID, INTEGER) TO service_role;
