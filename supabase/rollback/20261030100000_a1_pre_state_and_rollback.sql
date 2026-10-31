-- Rollback for 20261030100000_a1_left_only_on_purpose.sql.
-- Pre-state (production, 2026-10-30): no session_participant_status_log table,
-- no leave_session / guard_participant_left / log_participant_status /
-- participant_status_via functions, triggers on session_participants:
-- assign_participant_color, enforce_participant_credit,
-- set_participant_picked_at, update_participants_updated_at.
-- leave_as_host below is the production definition read before the migration.
-- Dropping the log table discards what it recorded.
BEGIN;
DROP TRIGGER IF EXISTS guard_participant_left ON public.session_participants;
DROP TRIGGER IF EXISTS log_participant_status ON public.session_participants;
DROP FUNCTION IF EXISTS public.leave_session(uuid);
DROP FUNCTION IF EXISTS public.guard_participant_left();
DROP FUNCTION IF EXISTS public.log_participant_status();
DROP FUNCTION IF EXISTS public.participant_status_via();
DROP TABLE IF EXISTS public.session_participant_status_log;

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
  UPDATE public.session_participants SET status = 'left'
  WHERE session_id = s.id AND user_id = v_uid AND status IN ('pending', 'joined', 'selecting', 'items_picked');
  DELETE FROM public.session_presence WHERE session_id = s.id AND user_id = v_uid;
  INSERT INTO public.session_host_transfers (session_id, from_user_id, to_user_id, requested_by, from_last_seen_at, reason)
  VALUES (s.id, v_uid, v_new, v_uid, now(), 'host_left');

  SELECT * INTO s FROM public.sessions WHERE id = p_session_id;
  RETURN jsonb_build_object('result', 'transferred', 'from_user_id', v_uid, 'to_user_id', v_new, 'reason', 'host_left')
         || public.host_snapshot(s);
END;
$function$;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261030100000';
COMMIT;
