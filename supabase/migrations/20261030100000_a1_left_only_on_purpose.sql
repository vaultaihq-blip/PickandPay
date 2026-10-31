-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — v2 fixes, A1: "left" only when someone presses Sair
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Closing the app, losing the network or going to the background is
-- "disconnected", never "left". Only the Sair button (leave_session) and
-- "Sair e passar" (leave_as_host) may write status = 'left'; any other write
-- of 'left' by a signed-in user is refused with LEAVE_VIA_RPC.
--
-- Every change of a participant's status is recorded in
-- session_participant_status_log: old → new, who wrote it, and through what
-- (leave_session, leave_as_host, or 'direct' for a plain table write). No
-- client can read it; it is for us, to see where a status came from.
--
-- leave_as_host is the production definition with only the two set_config
-- lines around its UPDATE added.

-- ── The status log ──────────────────────────────────────────────────────────
-- No foreign keys: the record outlives the session row.
CREATE TABLE IF NOT EXISTS public.session_participant_status_log (
  id          bigserial PRIMARY KEY,
  session_id  uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  old_status  text,
  new_status  text        NOT NULL,
  changed_by  uuid,
  via         text        NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_participant_status_log_session_at
  ON public.session_participant_status_log (session_id, at);
ALTER TABLE public.session_participant_status_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.session_participant_status_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.session_participant_status_log_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.participant_status_via()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.status_via', true), ''), 'direct')
$$;
REVOKE ALL ON FUNCTION public.participant_status_via() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.log_participant_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.session_participant_status_log (session_id, user_id, old_status, new_status, changed_by, via)
    VALUES (NEW.session_id, NEW.user_id,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
            NEW.status, auth.uid(), public.participant_status_via());
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.log_participant_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS log_participant_status ON public.session_participants;
CREATE TRIGGER log_participant_status
  AFTER INSERT OR UPDATE OF status ON public.session_participants
  FOR EACH ROW EXECUTE FUNCTION public.log_participant_status();

-- ── 'left' only through the two leave functions ─────────────────────────────
-- Server jobs (no signed-in user) are not limited. DEFINER so it can read
-- participant_status_via(), which clients cannot execute; auth.uid() still
-- reads the caller's JWT.
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
REVOKE ALL ON FUNCTION public.guard_participant_left() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_participant_left ON public.session_participants;
CREATE TRIGGER guard_participant_left
  BEFORE UPDATE OF status ON public.session_participants
  FOR EACH ROW EXECUTE FUNCTION public.guard_participant_left();

-- ── leave_session: the Sair button ──────────────────────────────────────────
-- The caller leaves; the host uses leave_as_host or end_session instead.
-- Results: left | already_left | not_in_session | closed.
CREATE OR REPLACE FUNCTION public.leave_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  s     public.sessions;
  v_old text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to leave a session' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_uid = s.host_id THEN
    RAISE EXCEPTION 'The host leaves with leave_as_host or ends the session' USING ERRCODE = '42501';
  END IF;
  SELECT status INTO v_old FROM public.session_participants
  WHERE session_id = s.id AND user_id = v_uid FOR UPDATE;
  IF NOT FOUND OR v_old NOT IN ('pending', 'joined', 'selecting', 'items_picked', 'left') THEN
    RETURN jsonb_build_object('result', 'not_in_session', 'status', v_old);
  END IF;
  IF v_old = 'left' THEN
    RETURN jsonb_build_object('result', 'already_left', 'status', v_old);
  END IF;
  IF s.status = 'closed' THEN
    RETURN jsonb_build_object('result', 'closed', 'status', v_old);
  END IF;

  PERFORM set_config('app.status_via', 'leave_session', true);
  UPDATE public.session_participants SET status = 'left'
  WHERE session_id = s.id AND user_id = v_uid;
  PERFORM set_config('app.status_via', '', true);
  DELETE FROM public.session_presence WHERE session_id = s.id AND user_id = v_uid;
  RETURN jsonb_build_object('result', 'left', 'previous', v_old, 'status', 'left');
END;
$function$;
REVOKE ALL ON FUNCTION public.leave_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leave_session(uuid) TO authenticated;

-- ── leave_as_host (production definition + the two set_config lines) ────────
CREATE OR REPLACE FUNCTION public.leave_as_host(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  s     public.sessions;
  v_new uuid;
  v_set uuid;
BEGIN
  SELECT * INTO s FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_uid IS NULL OR v_uid <> s.host_id THEN
    RAISE EXCEPTION 'Only the host can hand the session over' USING ERRCODE = '42501';
  END IF;
  IF s.status = 'closed' THEN
    RETURN jsonb_build_object('result', 'closed') || public.host_snapshot(s);
  END IF;
  -- Someone online first; otherwise the first present person by arrival.
  v_new := public.next_host_candidate(s, false);
  IF v_new IS NULL THEN
    RETURN jsonb_build_object('result', 'alone') || public.host_snapshot(s);
  END IF;

  UPDATE public.sessions SET host_id = v_new
  WHERE id = s.id AND host_id = v_uid
  RETURNING host_id INTO v_set;
  IF v_set IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'Host transfer did not apply' USING ERRCODE = '40001';
  END IF;
  PERFORM set_config('app.status_via', 'leave_as_host', true);
  UPDATE public.session_participants SET status = 'left'
  WHERE session_id = s.id AND user_id = v_uid AND status IN ('pending', 'joined', 'selecting', 'items_picked');
  PERFORM set_config('app.status_via', '', true);
  DELETE FROM public.session_presence WHERE session_id = s.id AND user_id = v_uid;
  INSERT INTO public.session_host_transfers (session_id, from_user_id, to_user_id, requested_by, from_last_seen_at, reason)
  VALUES (s.id, v_uid, v_new, v_uid, now(), 'host_left');

  SELECT * INTO s FROM public.sessions WHERE id = p_session_id;
  RETURN jsonb_build_object('result', 'transferred', 'from_user_id', v_uid, 'to_user_id', v_new, 'reason', 'host_left')
         || public.host_snapshot(s);
END;
$function$;
