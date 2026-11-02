-- Pick&Pay — R11: production state before 20261102190000, and its rollback
--
-- Read from production on 2026-11-02 (pg_get_functiondef), before the change.
-- Running this file puts the functions back, removes remove_participant and
-- the ever_joined trigger, and drops the column. Rows already 'removed' stay
-- 'removed' (the old code treats them as not present and not part of the
-- session); set them back by hand if needed.

DROP FUNCTION IF EXISTS public.remove_participant(uuid, uuid);
DROP TRIGGER IF EXISTS set_participant_ever_joined ON public.session_participants;
DROP FUNCTION IF EXISTS public.set_participant_ever_joined();

CREATE OR REPLACE FUNCTION public.is_part_of_session(p_session_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.sessions s
            WHERE s.id = p_session_id AND p_user_id IN (s.host_id, s.original_host_id))
    OR EXISTS (SELECT 1 FROM public.session_participants sp
               WHERE sp.session_id = p_session_id AND sp.user_id = p_user_id
                 AND (sp.status IN ('pending', 'joined', 'selecting', 'items_picked')
                      OR (sp.status IN ('left', 'cancelled') AND public.has_session_consumption(p_session_id, p_user_id)))))
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
    -- C.3: a session created with its receipt already scanned is paid by
    -- that scan (linked in link_scan_on_session_insert).
    v_need := TG_OP = 'INSERT' AND NEW.host_id = v_uid
      AND NOT (NEW.receipt_data IS NOT NULL AND public.ocr_unlinked_scan(v_uid) IS NOT NULL);
  ELSIF TG_OP = 'INSERT' THEN
    v_need := NEW.user_id = v_uid AND NEW.role = 'participant';
  ELSIF NEW.user_id = v_uid THEN
    -- Own row: coming back after cancelling or leaving. R7: no credit for
    -- someone who already paid for this session or is its (original) host;
    -- pending → joined needs none (the credit was checked at the insert).
    v_need := NEW.status IS DISTINCT FROM OLD.status
      AND OLD.status IN ('cancelled', 'left')
      AND NEW.status IN ('pending', 'joined', 'selecting', 'items_picked')
      AND NOT public.has_session_consumption(NEW.session_id, NEW.user_id)
      AND NOT EXISTS (SELECT 1 FROM public.sessions
                      WHERE id = NEW.session_id AND v_uid IN (host_id, original_host_id));
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

CREATE OR REPLACE FUNCTION public.guard_participant_left()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'left' AND OLD.status IS DISTINCT FROM 'left'
     AND auth.uid() IS NOT NULL
     AND public.participant_status_via() NOT IN ('leave_session', 'leave_as_host') THEN
    RAISE EXCEPTION 'LEAVE_VIA_RPC' USING ERRCODE = '42501',
      HINT = 'Leaving a session goes through leave_session (or leave_as_host for the host).';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.join_preview(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  s     public.sessions;
  v_base jsonb;
  v_rows integer;
  v_mine text;
  v_why  text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to join a session' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public.sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found', 'session_id', p_session_id);
  END IF;
  SELECT status INTO v_mine FROM public.session_participants WHERE session_id = s.id AND user_id = v_uid;
  -- Before joining: the host's name and how many people are in. Nothing else.
  v_base := jsonb_build_object(
    'session_id', s.id,
    'host_name', (SELECT name FROM public.profiles WHERE id = s.host_id),
    'people', (SELECT count(*) FROM public.session_participants
               WHERE session_id = s.id AND public.is_present_status(status)),
    'max_people', public.session_max_people(),
    'my_status', v_mine,
    'is_host', v_uid = s.host_id,
    'is_original_host', v_uid = s.original_host_id);
  -- D.1: a session past its expiry reads as ended even before the job closes it.
  IF s.status = 'closed' OR public.session_expiry_reason(s) IS NOT NULL THEN
    IF v_mine IS NOT NULL OR v_uid = s.host_id OR v_uid = s.original_host_id THEN
      IF s.status <> 'closed' THEN
        v_why := 'inactive';
      ELSE
        SELECT CASE
                 WHEN c.reason = 'host_ended' THEN 'host'
                 WHEN c.reason LIKE 'expired_%' OR c.reason = 'cleanup' THEN 'inactive'
                 ELSE 'ended'
               END
          INTO v_why
          FROM public.session_closures c
         WHERE c.session_id = s.id
         ORDER BY c.closed_at DESC, c.id DESC
         LIMIT 1;
        v_why := coalesce(v_why, 'ended');
      END IF;
      RETURN jsonb_build_object('result', 'closed', 'closed_reason', v_why) || v_base;
    END IF;
    RETURN jsonb_build_object('result', 'closed') || v_base;
  END IF;
  IF public.is_part_of_session(s.id, v_uid) THEN
    RETURN jsonb_build_object('result', 'rejoin') || v_base;
  END IF;
  SELECT count(*) INTO v_rows FROM public.session_participants WHERE session_id = s.id;
  IF v_mine IS NULL AND v_rows >= public.session_max_people() THEN
    RETURN jsonb_build_object('result', 'full') || v_base;
  END IF;
  IF public.has_session_credit(v_uid) THEN
    RETURN jsonb_build_object('result', 'join') || v_base;
  END IF;
  RETURN jsonb_build_object('result', 'no_credits') || v_base;
END;
$function$;
REVOKE ALL ON FUNCTION public.join_preview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_preview(uuid) TO authenticated;

ALTER TABLE public.session_participants DROP COLUMN IF EXISTS ever_joined;
