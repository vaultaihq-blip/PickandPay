-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — C.1: OCR gate + R3 (no credits, no new session)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ocr_gate()  One call per parse-receipt request, made by the edge function
--     with service_role, before any Google Vision / GPT cost. In a single
--     transaction, under a per-user advisory lock:
--       1. the user must have ≥ 1 credit or be pro (nothing is deducted);
--       2. requests in the last p_window_seconds must be < p_max;
--       3. the request is recorded (INSERT … RETURNING).
--     The lock serialises a user's parallel requests, so N requests sent at
--     once cannot all read the same count. The edge function treats any error
--     from this call as a refusal (fails closed).
--
-- R3  With 0 credits (and not pro) a user cannot start or enter a NEW session:
--     enforce_session_credit() refuses, for the signed-in user acting on
--     their own rows,
--       * INSERT into sessions (Start split; manual entry included),
--       * INSERT of their own participant row (join scan, as pending),
--       * UPDATE of their own row from cancelled/left back into the session
--         (re-scan after cancel, rejoin after leaving).
--     Rows already active (pending/joined/selecting/items_picked) are never
--     touched by this, so whoever is already in a session can go back to it
--     at 0 credits. service_role / postgres (auth.uid() IS NULL) and the host
--     acting on someone else's row are not checked. Error: SQLSTATE PP402,
--     message NO_CREDITS, which the app maps to the no-credits dialog.

CREATE OR REPLACE FUNCTION public.has_session_credit(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT coalesce((SELECT is_pro OR bill_credits >= 1 FROM public.profiles WHERE id = p_user_id), false);
$function$;

REVOKE ALL ON FUNCTION public.has_session_credit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_session_credit(uuid) TO service_role;

-- ── OCR gate ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ocr_gate(
  p_user_id        uuid,
  p_max            integer,
  p_window_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
  v_id    uuid;
BEGIN
  IF p_user_id IS NULL OR p_max IS NULL OR p_max < 1 OR p_window_seconds IS NULL OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'ocr_gate: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- Serialises this user's concurrent requests until the transaction ends.
  PERFORM pg_advisory_xact_lock(hashtextextended('ocr_gate:' || p_user_id::text, 0));

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

  INSERT INTO public.ocr_requests (user_id) VALUES (p_user_id) RETURNING id INTO v_id;
  RETURN jsonb_build_object('allowed', true, 'request_id', v_id, 'count', v_count + 1);
END;
$function$;

REVOKE ALL ON FUNCTION public.ocr_gate(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ocr_gate(uuid, integer, integer) TO service_role;

-- The request log is server-only (RLS already had no client policies).
REVOKE ALL ON public.ocr_requests FROM anon, authenticated;

-- ── R3 ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_session_credit()
RETURNS trigger
LANGUAGE plpgsql
-- DEFINER so it can call has_session_credit(), which clients cannot execute
-- (it would tell anyone whether any user id has credits). auth.uid() still
-- reads the caller's JWT.
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_need boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'sessions' THEN
    v_need := TG_OP = 'INSERT' AND NEW.host_id = v_uid;
  ELSIF TG_OP = 'INSERT' THEN
    v_need := NEW.user_id = v_uid AND NEW.role = 'participant';
  ELSE
    v_need := NEW.user_id = v_uid
      AND OLD.status IN ('cancelled', 'left')
      AND NEW.status IN ('pending', 'joined', 'selecting', 'items_picked');
  END IF;

  IF v_need AND NOT public.has_session_credit(v_uid) THEN
    RAISE EXCEPTION 'NO_CREDITS' USING ERRCODE = 'PP402',
      HINT = 'A new session needs at least 1 credit.';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_session_credit() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER enforce_session_credit_on_insert
  BEFORE INSERT ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_session_credit();

CREATE TRIGGER enforce_participant_credit
  BEFORE INSERT OR UPDATE OF status ON public.session_participants
  FOR EACH ROW EXECUTE FUNCTION public.enforce_session_credit();
