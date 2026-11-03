-- Pick&Pay — R11 (owner, 02-11-2026, 22h): "Retirar" in the lobby, for someone
-- disconnected for more than 3 minutes
--
--   * remove_participant takes a reason: 'no_credits' (the finalize-refused
--     dialog, as before) or 'absent' (the lobby). 'absent' is allowed only
--     when the person's heartbeat (session_presence.last_seen_at, the R6b
--     signal) is older than 3 minutes — never for someone connected. These
--     3 minutes are independent of R6b's 5 minutes for the host transfer.
--   * removed_reason is kept on the row (server only, no client grant) and
--     goes back to NULL when the person comes back. join_preview returns it to
--     the person themself, so the app shows the right notice.
--   * Coming back after 'absent': with any balance if they already paid for
--     this session; otherwise with at least 1 credit. After 'no_credits':
--     always 1 credit (R11).
--
-- Applied in production on 2026-11-03 with the owner's approval (after the
-- tests of 03-11); post-verify: the rehearsal's cases, 0 differences.

ALTER TABLE public.session_participants
  ADD COLUMN IF NOT EXISTS removed_reason text
  CHECK (removed_reason IS NULL OR removed_reason IN ('no_credits', 'absent'));

CREATE OR REPLACE FUNCTION public.session_absent_minutes() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;

-- ever_joined (R11) + removed_reason is cleared once the person is back.
CREATE OR REPLACE FUNCTION public.set_participant_ever_joined()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.ever_joined := (TG_OP = 'UPDATE' AND OLD.ever_joined)
                     OR public.is_present_status(NEW.status);
  IF NEW.status IS DISTINCT FROM 'removed' THEN
    NEW.removed_reason := NULL;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.set_participant_ever_joined() FROM PUBLIC, anon, authenticated;

-- Removed for being away, having paid: still part of the session (any balance).
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
                 AND ((sp.status <> 'removed'   -- R11: removed comes back only with a credit
                       AND (sp.status IN ('pending', 'joined', 'selecting', 'items_picked')
                            OR sp.ever_joined       -- R11: has been part, any balance
                            OR (sp.status IN ('left', 'cancelled') AND public.has_session_consumption(p_session_id, p_user_id))))
                      -- R11 (lobby): removed for being away, already paid → any balance
                      OR (sp.status = 'removed' AND sp.removed_reason = 'absent'
                          AND public.has_session_consumption(p_session_id, p_user_id)))))
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
    -- Own row: coming back after cancelling, leaving or being removed.
    -- R7/R11: no credit for someone who already paid for this session, is
    -- its (original) host, or has been part of it (ever_joined). Someone
    -- removed needs one — unless removed for being away and already paid
    -- (R11, lobby). pending → joined needs none (checked at the insert).
    v_need := NEW.status IS DISTINCT FROM OLD.status
      AND OLD.status IN ('cancelled', 'left', 'removed')
      AND NEW.status IN ('pending', 'joined', 'selecting', 'items_picked')
      AND CASE WHEN OLD.status = 'removed' THEN
            NOT (OLD.removed_reason = 'absent' AND public.has_session_consumption(NEW.session_id, NEW.user_id))
          ELSE
            NOT public.has_session_consumption(NEW.session_id, NEW.user_id)
            AND NOT OLD.ever_joined
            AND NOT EXISTS (SELECT 1 FROM public.sessions
                            WHERE id = NEW.session_id AND v_uid IN (host_id, original_host_id))
          END;
  ELSIF public.participant_status_via() = 'remove_participant' THEN
    -- R11: the current host removing someone (checked in remove_participant).
    NULL;
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

DROP FUNCTION IF EXISTS public.remove_participant(uuid, uuid);
CREATE OR REPLACE FUNCTION public.remove_participant(p_session_id uuid, p_user_id uuid, p_reason text DEFAULT 'no_credits')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  s      public.sessions;
  v_old  text;
  v_new  text;
  v_seen timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('no_credits', 'absent') THEN
    RAISE EXCEPTION 'Unknown reason %', p_reason USING ERRCODE = '22023';
  END IF;
  SELECT * INTO s FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_uid IS DISTINCT FROM s.host_id THEN
    RAISE EXCEPTION 'Only the current host can remove someone from the split' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = s.host_id THEN
    RAISE EXCEPTION 'The host cannot be removed' USING ERRCODE = '22023';
  END IF;
  IF s.status IN ('awaiting_payment', 'paid', 'closed') THEN
    RAISE EXCEPTION 'SESSION_FINALIZED' USING ERRCODE = '22023';
  END IF;
  SELECT status INTO v_old FROM public.session_participants
  WHERE session_id = s.id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_present_status(v_old) THEN
    RAISE EXCEPTION 'NOT_IN_SESSION' USING ERRCODE = '42501';
  END IF;
  -- R11 (lobby): only someone whose heartbeat stopped more than 3 minutes ago.
  IF p_reason = 'absent' THEN
    SELECT last_seen_at INTO v_seen FROM public.session_presence
    WHERE session_id = s.id AND user_id = p_user_id;
    IF v_seen IS NULL OR v_seen > now() - make_interval(mins => public.session_absent_minutes()) THEN
      RAISE EXCEPTION 'STILL_CONNECTED' USING ERRCODE = '22023',
        HINT = 'Only someone disconnected for more than 3 minutes can be removed from the lobby.';
    END IF;
  END IF;

  PERFORM set_config('app.status_via', 'remove_participant', true);
  UPDATE public.session_participants SET status = 'removed', removed_reason = p_reason
  WHERE session_id = s.id AND user_id = p_user_id
  RETURNING status INTO v_new;
  PERFORM set_config('app.status_via', '', true);
  DELETE FROM public.session_presence WHERE session_id = s.id AND user_id = p_user_id;
  IF v_new IS DISTINCT FROM 'removed' THEN
    RAISE EXCEPTION 'remove_participant: status is %, not removed', v_new;
  END IF;
  RETURN jsonb_build_object('result', 'removed', 'user_id', p_user_id, 'previous', v_old,
                            'status', v_new, 'reason', p_reason);
END;
$function$;
REVOKE ALL ON FUNCTION public.remove_participant(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_participant(uuid, uuid, text) TO authenticated;

-- join_preview (production) + removed_reason for one's own removed row.
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
    'is_original_host', v_uid = s.original_host_id,
    -- R11 (lobby): why this person was removed, for their own notice.
    'removed_reason', CASE WHEN v_mine = 'removed' THEN
      (SELECT removed_reason FROM public.session_participants WHERE session_id = s.id AND user_id = v_uid) END);
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
    -- R11: comes back with any balance; at 0 credits, not having paid for
    -- this session, the app says a credit is needed before the finalize.
    RETURN jsonb_build_object('result', 'rejoin',
      'needs_credit', NOT public.has_session_credit(v_uid)
                      AND NOT public.has_session_consumption(s.id, v_uid)
                      AND v_uid IS DISTINCT FROM s.host_id
                      AND v_uid IS DISTINCT FROM s.original_host_id) || v_base;
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
