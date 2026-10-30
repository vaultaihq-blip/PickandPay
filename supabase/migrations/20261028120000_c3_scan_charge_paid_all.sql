-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — C.3: the scan spends the credit, mark everyone paid, R3 return set
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Scan (parse-receipt):
--   ocr_gate() now CHARGES: under the same advisory lock as the credit check
--   and the rate limit it inserts the request as 'charged', takes 1 credit
--   (pro: 0) and appends a scan_charge to session_credit_ledger. Charging
--   here, not after the answer, is what makes the check and the spend one
--   atomic step: with 1 credit, parallel scans cannot all pass the check
--   before any of them pays.
--   ocr_scan_settle() is called by the function once it has answered:
--     keep   (200, or 422 UNREADABLE_RECEIPT — Vision/GPT were paid for):
--            the request becomes 'kept'; with a session the scanner hosts
--            and has not paid for yet, the credit becomes that session's
--            consumption (finalize_session then does not charge the host);
--     refund (any other failure — 5xx, provider error, our error): the
--            credit goes back, 'refunded', ledger scan_refund.
--   A request still 'charged' 15 minutes later (the function died before
--   settling) is refunded by the next ocr_gate call of that user.
--   A session created with a receipt (review's insert path, no session
--   before the scan) takes the host's latest unlinked kept scan of the last
--   2 hours: no credit needed for that insert, and the scan pays the session.
--
-- set_all_participants_paid(session, paid) — host only: every person in the
--   frozen split (split_user_ids) in one statement. Also after closing, like
--   set_participant_paid.
--
-- my_returnable_sessions() — R3 exception, one definition for the app: the
--   sessions the caller may scan back into at 0 credits — created in the last
--   24 hours, not closed, and either still in progress with the caller in
--   it (joined / selecting / items_picked, not yet awaiting_payment) or
--   already paid for by the caller who left (live consumption row).

-- ── ocr_requests: charge state ──────────────────────────────────────────────
ALTER TABLE public.ocr_requests
  ADD COLUMN status     text NOT NULL DEFAULT 'legacy'
                         CHECK (status IN ('legacy', 'charged', 'kept', 'refunded')),
  ADD COLUMN credits    integer NOT NULL DEFAULT 0 CHECK (credits IN (0, 1)),
  ADD COLUMN was_pro    boolean NOT NULL DEFAULT false,
  ADD COLUMN session_id uuid REFERENCES public.sessions(id) ON DELETE SET NULL,
  ADD COLUMN settled_at timestamptz;
CREATE INDEX ocr_requests_user_status_idx ON public.ocr_requests (user_id, status, created_at DESC);

-- ── ledger: scan entries (no session yet) ───────────────────────────────────
ALTER TABLE public.session_credit_ledger
  ALTER COLUMN session_id DROP NOT NULL,
  ADD COLUMN ocr_request_id uuid REFERENCES public.ocr_requests(id) ON DELETE SET NULL,
  DROP CONSTRAINT session_credit_ledger_kind_check,
  ADD CONSTRAINT session_credit_ledger_kind_check
    CHECK (kind IN ('charge', 'refund', 'scan_charge', 'scan_refund', 'scan_link'));
CREATE INDEX session_credit_ledger_user_idx ON public.session_credit_ledger (user_id, created_at DESC);

ALTER TABLE public.session_credit_consumptions
  ADD COLUMN ocr_request_id uuid REFERENCES public.ocr_requests(id) ON DELETE SET NULL;

-- ── refund of one charged scan (internal) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.ocr_refund_request(p_request_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_req public.ocr_requests%ROWTYPE;
BEGIN
  UPDATE public.ocr_requests
  SET status = 'refunded', settled_at = now()
  WHERE id = p_request_id AND status = 'charged'
  RETURNING * INTO v_req;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM set_config('app.credit_authorized', 'true', true);
  IF v_req.credits = 1 THEN
    UPDATE public.profiles SET bill_credits = coalesce(bill_credits, 0) + 1 WHERE id = v_req.user_id;
  END IF;
  INSERT INTO public.session_credit_ledger (session_id, user_id, kind, credits, was_pro, ocr_request_id)
  VALUES (NULL, v_req.user_id, 'scan_refund', v_req.credits, v_req.was_pro, v_req.id);
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.ocr_refund_request(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ocr_refund_request(uuid) TO service_role;

-- ── ocr_gate: check + charge in one step ────────────────────────────────────
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

-- ── links a kept scan to a session the scanner hosts (internal) ─────────────
CREATE OR REPLACE FUNCTION public.ocr_link_scan(p_request_id uuid, p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_req public.ocr_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM public.ocr_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_req.status <> 'kept' OR v_req.session_id IS NOT NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sessions WHERE id = p_session_id AND host_id = v_req.user_id AND status <> 'closed') THEN
    RETURN false;
  END IF;
  -- Already paid for this session (an earlier scan, or finalize): a re-scan
  -- is just spent — recorded against this session so it never pays another.
  IF public.has_session_consumption(p_session_id, v_req.user_id) THEN
    UPDATE public.ocr_requests SET session_id = p_session_id WHERE id = v_req.id;
    RETURN false;
  END IF;

  INSERT INTO public.session_credit_consumptions (session_id, user_id, credits, was_pro, ocr_request_id)
  VALUES (p_session_id, v_req.user_id, v_req.credits, v_req.was_pro, v_req.id)
  ON CONFLICT (session_id, user_id) DO UPDATE
    SET credits = EXCLUDED.credits, was_pro = EXCLUDED.was_pro, ocr_request_id = EXCLUDED.ocr_request_id,
        created_at = now(), refunded_at = NULL;
  UPDATE public.ocr_requests SET session_id = p_session_id WHERE id = v_req.id;
  INSERT INTO public.session_credit_ledger (session_id, user_id, kind, credits, was_pro, ocr_request_id)
  VALUES (p_session_id, v_req.user_id, 'scan_link', 0, v_req.was_pro, v_req.id);
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.ocr_link_scan(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ocr_link_scan(uuid, uuid) TO service_role;

-- ── ocr_scan_settle: called by parse-receipt after answering ────────────────
CREATE OR REPLACE FUNCTION public.ocr_scan_settle(p_request_id uuid, p_keep boolean, p_session_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  v_linked boolean := false;
BEGIN
  SELECT status INTO v_status FROM public.ocr_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Scan request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'charged' THEN
    RETURN jsonb_build_object('status', v_status, 'changed', false);   -- already settled
  END IF;

  IF NOT coalesce(p_keep, false) THEN
    PERFORM public.ocr_refund_request(p_request_id);
    RETURN jsonb_build_object('status', 'refunded', 'changed', true);
  END IF;

  UPDATE public.ocr_requests SET status = 'kept', settled_at = now() WHERE id = p_request_id;
  IF p_session_id IS NOT NULL THEN
    v_linked := public.ocr_link_scan(p_request_id, p_session_id);
  END IF;
  RETURN jsonb_build_object('status', 'kept', 'changed', true, 'linked', v_linked);
END;
$function$;
REVOKE ALL ON FUNCTION public.ocr_scan_settle(uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ocr_scan_settle(uuid, boolean, uuid) TO service_role;

-- The host's latest kept, unlinked scan of the last 2 hours (internal).
CREATE OR REPLACE FUNCTION public.ocr_unlinked_scan(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT id FROM public.ocr_requests
  WHERE user_id = p_user_id AND status = 'kept' AND session_id IS NULL
    AND created_at > now() - interval '2 hours'
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;
$function$;
REVOKE ALL ON FUNCTION public.ocr_unlinked_scan(uuid) FROM PUBLIC, anon, authenticated;

-- ── R3 / R1 trigger: a session created with a scanned receipt needs no credit ──
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
    -- C.3: a session created with its receipt already scanned is paid by
    -- that scan (linked in link_scan_on_session_insert).
    v_need := TG_OP = 'INSERT' AND NEW.host_id = v_uid
      AND NOT (NEW.receipt_data IS NOT NULL AND public.ocr_unlinked_scan(v_uid) IS NOT NULL);
  ELSIF TG_OP = 'INSERT' THEN
    v_need := NEW.user_id = v_uid AND NEW.role = 'participant';
  ELSIF NEW.user_id = v_uid THEN
    -- Own row: coming (back) into the session.
    v_need := NEW.status IS DISTINCT FROM OLD.status
      AND (
        (OLD.status IN ('cancelled', 'left') AND NEW.status IN ('pending', 'joined', 'selecting', 'items_picked'))
        OR (OLD.status = 'pending' AND NEW.status IN ('joined', 'selecting', 'items_picked'))
      )
      AND NOT public.has_session_consumption(NEW.session_id, NEW.user_id);
  ELSE
    -- Someone else's row (RLS only lets the host get here): status and
    -- selections only through the takeover transitions the app uses. Other
    -- columns (paid, covered_by) come from the host RPCs and stay allowed on
    -- any row — e.g. marking paid someone who left after awaiting_payment.
    IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.selections IS DISTINCT FROM OLD.selections)
       AND NOT (
         OLD.status IN ('joined', 'selecting', 'items_picked')
         AND (NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status IN ('selecting', 'items_picked'))
       ) THEN
      RAISE EXCEPTION 'The host cannot move another participant from % to %', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_need AND NOT public.has_session_credit(v_uid) THEN
    RAISE EXCEPTION 'NO_CREDITS' USING ERRCODE = 'PP402',
      HINT = 'A new session needs at least 1 credit.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.link_scan_on_session_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_scan uuid;
BEGIN
  IF auth.uid() IS NULL OR NEW.host_id <> auth.uid() OR NEW.receipt_data IS NULL THEN
    RETURN NULL;
  END IF;
  v_scan := public.ocr_unlinked_scan(NEW.host_id);
  IF v_scan IS NOT NULL THEN
    PERFORM public.ocr_link_scan(v_scan, NEW.id);
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.link_scan_on_session_insert() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER link_scan_on_session_insert
  AFTER INSERT ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.link_scan_on_session_insert();

-- ── mark everyone in the split as paid ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_all_participants_paid(p_session_id uuid, p_paid boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_split   uuid[];
  v_changed integer;
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN
    RAISE EXCEPTION 'Only the host can mark payments' USING ERRCODE = '42501';
  END IF;
  SELECT split_user_ids INTO v_split FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF v_split IS NULL OR cardinality(v_split) = 0 THEN
    RAISE EXCEPTION 'The split has not been finalized yet' USING ERRCODE = '22023';
  END IF;

  UPDATE public.session_participants
  SET paid = coalesce(p_paid, true)
  WHERE session_id = p_session_id AND user_id = ANY (v_split)
    AND paid IS DISTINCT FROM coalesce(p_paid, true);
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  RETURN jsonb_build_object('changed', v_changed, 'split', cardinality(v_split), 'user_ids', to_jsonb(v_split));
END;
$function$;
REVOKE ALL ON FUNCTION public.set_all_participants_paid(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_all_participants_paid(uuid, boolean) TO authenticated, service_role;

-- ── R3: where the caller may scan back in at 0 credits ──────────────────────
CREATE OR REPLACE FUNCTION public.my_returnable_sessions()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  SELECT coalesce(array_agg(DISTINCT sp.session_id), '{}')
  FROM public.session_participants sp
  JOIN public.sessions s ON s.id = sp.session_id
  WHERE sp.user_id = auth.uid()
    AND s.status <> 'closed'
    AND s.created_at > now() - interval '24 hours'
    AND (
      (sp.status IN ('joined', 'selecting', 'items_picked') AND s.status <> 'awaiting_payment')
      OR (sp.status = 'left' AND EXISTS (
            SELECT 1 FROM public.session_credit_consumptions c
            WHERE c.session_id = sp.session_id AND c.user_id = sp.user_id AND c.refunded_at IS NULL))
    );
$function$;
REVOKE ALL ON FUNCTION public.my_returnable_sessions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_returnable_sessions() TO authenticated;
