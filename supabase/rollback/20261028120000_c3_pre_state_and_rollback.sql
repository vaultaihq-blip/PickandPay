-- C.3 pre-state snapshot and rollback, taken from production 2026-10-28T11:02:43.422Z
-- Source: pg_get_functiondef via `supabase db query --linked`, before applying
-- supabase/migrations/20261028120000_c3_scan_charge_paid_all.sql.
--
-- Pre-state:
--   ocr_gate(uuid,integer,integer)  acl {postgres=X/postgres,service_role=X/postgres}  md5 e05f65e43973374be79bc5a2acd02772  (C.1: checks, does not charge)
--   enforce_session_credit()  acl {postgres=X/postgres,service_role=X/postgres}  md5 cde0b13e005670469493e9e4e5602188  (C.2)
--   no ocr_scan_settle / ocr_refund_request / ocr_link_scan / ocr_unlinked_scan /
--   link_scan_on_session_insert / set_all_participants_paid / my_returnable_sessions.
--
-- Running this puts back the behaviour (the scan only checks for a credit
-- again, nothing is linked, no mark-all) but KEEPS the data: the new
-- ocr_requests / ledger / consumption columns and every scan_charge,
-- scan_refund and scan_link ledger row stay (financial record; the old
-- functions ignore them). Credits already spent on scans stay spent; a scan
-- left 'charged' is not refunded any more — refund those first if needed:
--   select public.ocr_refund_request(id) from public.ocr_requests where status = 'charged';
-- Deploy parse-receipt v57 → the previous version too (supabase/functions/parse-receipt
-- at git 3959ad1, deployed as v56): the new one calls ocr_scan_settle.

BEGIN;

DROP TRIGGER IF EXISTS link_scan_on_session_insert ON public.sessions;
DROP FUNCTION IF EXISTS public.link_scan_on_session_insert();

CREATE OR REPLACE FUNCTION public.ocr_gate(p_user_id uuid, p_max integer, p_window_seconds integer)
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
CREATE OR REPLACE FUNCTION public.enforce_session_credit()
 RETURNS trigger
 LANGUAGE plpgsql
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

DROP FUNCTION IF EXISTS public.ocr_scan_settle(uuid, boolean, uuid);
DROP FUNCTION IF EXISTS public.ocr_link_scan(uuid, uuid);
DROP FUNCTION IF EXISTS public.ocr_unlinked_scan(uuid);
DROP FUNCTION IF EXISTS public.ocr_refund_request(uuid);
DROP FUNCTION IF EXISTS public.set_all_participants_paid(uuid, boolean);
DROP FUNCTION IF EXISTS public.my_returnable_sessions();

COMMIT;
