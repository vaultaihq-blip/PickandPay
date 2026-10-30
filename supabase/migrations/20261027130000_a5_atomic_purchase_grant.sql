-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — A.5: atomic purchase grant for the RevenueCat webhook
-- ─────────────────────────────────────────────────────────────────────────────
--
-- grant-credits-from-purchase used to insert the credit_transactions row and
-- then call admin_grant_credits as two separate requests. If the grant failed
-- after the insert, RevenueCat's retry hit the unique event id, was answered
-- "duplicate_event" and the credits were lost for good.
--
-- grant_purchase_credits does both in one transaction: the event row is only
-- kept if the credits were granted, so a failure leaves nothing behind and the
-- retry grants normally. Idempotency stays on the existing
-- credit_transactions_revenuecat_event_id_key unique constraint. Concurrent
-- deliveries of the same event serialise on that constraint: the second waits
-- for the first and then sees either a duplicate (first committed) or a free
-- slot (first rolled back).
--
-- Returns jsonb:
--   {"status":"granted","credits_added":n,"new_balance":n}
--   {"status":"duplicate_event"}
--   {"status":"invalid_app_user_id"}   app_user_id is not a Supabase user id
--                                      (e.g. a RevenueCat anonymous id); a
--                                      retry cannot fix it, so it is not an error
-- Raises (→ HTTP 500 → RevenueCat retries) when the user has no profile or the
-- update fails for any other reason.

CREATE OR REPLACE FUNCTION public.grant_purchase_credits(
  p_event_id    text,
  p_app_user_id text,
  p_product_id  text,
  p_amount      integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_balance integer;
BEGIN
  IF p_event_id IS NULL OR p_event_id = '' THEN
    RAISE EXCEPTION 'Missing event id' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid credit amount: %', p_amount USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_user_id := p_app_user_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('status', 'invalid_app_user_id');
  END;

  INSERT INTO public.credit_transactions (revenuecat_event_id, user_id, amount, product_id)
  VALUES (p_event_id, v_user_id, p_amount, p_product_id)
  ON CONFLICT (revenuecat_event_id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate_event');
  END IF;

  PERFORM set_config('app.credit_authorized', 'true', true);

  UPDATE public.profiles
  SET bill_credits = bill_credits + p_amount
  WHERE id = v_user_id
  RETURNING bill_credits INTO v_balance;

  PERFORM set_config('app.credit_authorized', 'false', true);

  IF v_balance IS NULL THEN
    -- Rolls back the credit_transactions insert above.
    RAISE EXCEPTION 'User not found: %', v_user_id USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object('status', 'granted', 'credits_added', p_amount, 'new_balance', v_balance);
END;
$function$;

REVOKE ALL ON FUNCTION public.grant_purchase_credits(text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_purchase_credits(text, text, text, integer) TO service_role;
