-- Rollback for 20261029210000_scan_one_at_a_time.sql
--
-- Pre-state (read from production before applying, 2026-10-29): ocr_gate as
-- below (pg_get_functiondef output), EXECUTE to service_role only; no
-- ocr_in_flight_seconds(). Roll the parse-receipt function back first if its
-- SCAN_IN_PROGRESS mapping matters (without it the reason simply becomes
-- SCAN_UNAVAILABLE).

BEGIN;

CREATE OR REPLACE FUNCTION public.ocr_gate(p_user_id uuid, p_max integer, p_window_seconds integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
  v_id    uuid;
  v_pro   boolean;
  v_stale uuid;
BEGIN
  IF p_user_id IS NULL OR p_max IS NULL OR p_max < 1 OR p_window_seconds IS NULL OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'ocr_gate: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- Serialises this user's concurrent requests until the transaction ends.
  PERFORM pg_advisory_xact_lock(hashtextextended('ocr_gate:' || p_user_id::text, 0));

  -- A scan whose function died before settling gives its credit back.
  FOR v_stale IN
    SELECT id FROM public.ocr_requests
    WHERE user_id = p_user_id AND status = 'charged' AND created_at < now() - interval '15 minutes'
  LOOP
    PERFORM public.ocr_refund_request(v_stale);
  END LOOP;

  IF NOT public.has_session_credit(p_user_id) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'no_credits');
  END IF;

  SELECT count(*) INTO v_count
  FROM public.ocr_requests
  WHERE user_id = p_user_id
    AND created_at >= now() - make_interval(secs => p_window_seconds);

  IF v_count >= p_max THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'rate_limited', 'count', v_count);
  END IF;

  SELECT coalesce(is_pro, false) INTO v_pro FROM public.profiles WHERE id = p_user_id FOR UPDATE;

  INSERT INTO public.ocr_requests (user_id, status, credits, was_pro)
  VALUES (p_user_id, 'charged', CASE WHEN v_pro THEN 0 ELSE 1 END, v_pro)
  RETURNING id INTO v_id;

  IF NOT v_pro THEN
    PERFORM set_config('app.credit_authorized', 'true', true);
    UPDATE public.profiles SET bill_credits = bill_credits - 1 WHERE id = p_user_id;
  END IF;
  INSERT INTO public.session_credit_ledger (session_id, user_id, kind, credits, was_pro, ocr_request_id)
  VALUES (NULL, p_user_id, 'scan_charge', CASE WHEN v_pro THEN 0 ELSE 1 END, v_pro, v_id);

  RETURN jsonb_build_object('allowed', true, 'request_id', v_id, 'count', v_count + 1, 'charged', NOT v_pro);
END;
$function$;
REVOKE ALL ON FUNCTION public.ocr_gate(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ocr_gate(uuid, integer, integer) TO service_role;

DROP FUNCTION IF EXISTS public.ocr_in_flight_seconds();

-- Remove the migration's row so `supabase db push` would apply it again.
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261029210000';

COMMIT;
