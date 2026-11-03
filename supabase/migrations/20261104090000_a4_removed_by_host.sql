-- Pick&Pay — A4 (owner, 04-11-2026): the host can remove anyone from the session
--
--   * remove_participant takes a third reason, 'removed_by_host': the current
--     host (checked, as before) removes any present participant who is not
--     the host, at any time before the finalize — no 3-minute wait. 'absent'
--     keeps its heartbeat check; 'no_credits' is unchanged.
--   * Coming back after 'removed_by_host': as after 'absent' (R11) — with any
--     balance if already paid for this session, otherwise with 1 credit.
--   * After a host transfer (R6b) only the new host passes the check.
--
-- Applied in production on 2026-11-04 with the owner's approval; post-verify:
-- the rehearsal's cases, 0 differences.

ALTER TABLE public.session_participants DROP CONSTRAINT IF EXISTS session_participants_removed_reason_check;
ALTER TABLE public.session_participants ADD CONSTRAINT session_participants_removed_reason_check
  CHECK (removed_reason IS NULL OR removed_reason IN ('no_credits', 'absent', 'removed_by_host'));

CREATE OR REPLACE FUNCTION public.remove_participant(p_session_id uuid, p_user_id uuid, p_reason text DEFAULT 'no_credits'::text)
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
  IF p_reason IS NULL OR p_reason NOT IN ('no_credits', 'absent', 'removed_by_host') THEN
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
                      OR (sp.status = 'removed' AND sp.removed_reason IN ('absent', 'removed_by_host')
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
            NOT (OLD.removed_reason IN ('absent', 'removed_by_host') AND public.has_session_consumption(NEW.session_id, NEW.user_id))
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
