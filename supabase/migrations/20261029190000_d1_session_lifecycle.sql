-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — D.1: ending and expiring sessions
-- ─────────────────────────────────────────────────────────────────────────────
--
--   * session_closures: every move to 'closed' is recorded (who or what,
--     why, the status it had, its last activity). Written by a trigger, so
--     closes from any path are kept. No FK: the record outlives the session.
--   * end_session(session): the host ends the session; returns the saved
--     status. Only the current host. (The app moves to it in D.5.)
--   * Expiry, by last activity (the latest of: the session row, any
--     participant row, any presence heartbeat):
--       no receipt                     → 2 h
--       receipt, before finalize       → 24 h
--       awaiting_payment / paid        → 7 days
--     expire_abandoned_sessions() closes them; the pg_cron job that runs it
--     is scheduled in a separate migration, after the clean-up is approved.
--     join_preview and my_rejoinable_session already treat an expired
--     session as ended (the read-time check), so nothing waits for the job.
--   * No scan refund (decided: a successful scan has been paid for).

CREATE TABLE IF NOT EXISTS public.session_closures (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id       uuid NOT NULL,
  closed_at        timestamptz NOT NULL DEFAULT now(),
  reason           text NOT NULL CHECK (reason IN ('host_ended', 'expired_no_receipt', 'expired_before_finalize',
                                                   'expired_payment', 'cleanup', 'status_update')),
  closed_by        uuid,
  previous_status  text,
  last_activity_at timestamptz
);
ALTER TABLE public.session_closures ENABLE ROW LEVEL SECURITY;   -- no policies: server only
REVOKE ALL ON public.session_closures FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS session_closures_session_idx ON public.session_closures (session_id);

-- The latest sign of life of a session.
CREATE OR REPLACE FUNCTION public.session_last_activity(s public.sessions)
RETURNS timestamptz
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT greatest(
    s.created_at, s.updated_at,
    (SELECT max(sp.updated_at) FROM public.session_participants sp WHERE sp.session_id = s.id),
    (SELECT max(pr.last_seen_at) FROM public.session_presence pr WHERE pr.session_id = s.id))
$$;
REVOKE ALL ON FUNCTION public.session_last_activity(public.sessions) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.session_expiry_hours_no_receipt()      RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 2 $$;
CREATE OR REPLACE FUNCTION public.session_expiry_hours_before_finalize() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 24 $$;
CREATE OR REPLACE FUNCTION public.session_expiry_hours_payment()         RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 168 $$;

-- Why this session has expired, or NULL if it has not (or is closed).
CREATE OR REPLACE FUNCTION public.session_expiry_reason(s public.sessions)
RETURNS text
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_last  timestamptz;
  v_rule  text;
  v_hours integer;
BEGIN
  IF s.status = 'closed' THEN
    RETURN NULL;
  END IF;
  IF s.status IN ('awaiting_payment', 'paid') THEN
    v_rule := 'expired_payment';         v_hours := public.session_expiry_hours_payment();
  ELSIF s.receipt_data IS NULL THEN
    v_rule := 'expired_no_receipt';      v_hours := public.session_expiry_hours_no_receipt();
  ELSE
    v_rule := 'expired_before_finalize'; v_hours := public.session_expiry_hours_before_finalize();
  END IF;
  v_last := public.session_last_activity(s);
  IF v_last < now() - make_interval(hours => v_hours) THEN
    RETURN v_rule;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.session_expiry_reason(public.sessions) FROM PUBLIC, anon, authenticated;

-- Every close is recorded, whichever path closed it.
CREATE OR REPLACE FUNCTION public.record_session_closure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := nullif(current_setting('app.close_reason', true), '');
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    INSERT INTO public.session_closures (session_id, reason, closed_by, previous_status, last_activity_at)
    VALUES (NEW.id, coalesce(v_reason, 'status_update'), auth.uid(), OLD.status, public.session_last_activity(OLD));
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_session_closure() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS record_session_closure ON public.sessions;
CREATE TRIGGER record_session_closure
  AFTER UPDATE OF status ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.record_session_closure();

-- The host ends the session.
CREATE OR REPLACE FUNCTION public.end_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  s     public.sessions;
BEGIN
  SELECT * INTO s FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_uid IS NULL OR v_uid <> s.host_id THEN
    RAISE EXCEPTION 'Only the host can end the session' USING ERRCODE = '42501';
  END IF;
  IF s.status = 'closed' THEN
    RETURN jsonb_build_object('result', 'already_closed', 'session_id', s.id, 'status', s.status);
  END IF;
  PERFORM set_config('app.close_reason', 'host_ended', true);
  UPDATE public.sessions SET status = 'closed' WHERE id = s.id RETURNING * INTO s;
  PERFORM set_config('app.close_reason', '', true);
  IF s.status IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'Session % did not close', p_session_id USING ERRCODE = '40001';
  END IF;
  RETURN jsonb_build_object('result', 'closed', 'session_id', s.id, 'status', s.status);
END;
$function$;
REVOKE ALL ON FUNCTION public.end_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_session(uuid) TO authenticated;

-- Closes every expired session; returns how many, by reason. Run by pg_cron.
CREATE OR REPLACE FUNCTION public.expire_abandoned_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  s        public.sessions;
  v_reason text;
  v_counts jsonb := '{}'::jsonb;
  v_total  integer := 0;
BEGIN
  FOR s IN SELECT * FROM public.sessions WHERE status <> 'closed' FOR UPDATE SKIP LOCKED LOOP
    v_reason := public.session_expiry_reason(s);
    CONTINUE WHEN v_reason IS NULL;
    PERFORM set_config('app.close_reason', v_reason, true);
    UPDATE public.sessions SET status = 'closed' WHERE id = s.id;
    v_counts := v_counts || jsonb_build_object(v_reason, coalesce((v_counts->>v_reason)::int, 0) + 1);
    v_total := v_total + 1;
  END LOOP;
  PERFORM set_config('app.close_reason', '', true);
  RETURN jsonb_build_object('closed', v_total, 'by_reason', v_counts);
END;
$function$;
REVOKE ALL ON FUNCTION public.expire_abandoned_sessions() FROM PUBLIC, anon, authenticated;

-- ── Read-time check (production definitions + the expiry line) ──────────────
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

CREATE OR REPLACE FUNCTION public.my_rejoinable_session()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'session_id', s.id,
    'host_name', (SELECT name FROM public.profiles WHERE id = s.host_id),
    'restaurant', s.receipt_data->>'restaurant',
    'my_status', (SELECT status FROM public.session_participants WHERE session_id = s.id AND user_id = auth.uid()))
  FROM public.sessions s
  WHERE s.status <> 'closed'
    AND (s.host_id = auth.uid() OR s.original_host_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.session_participants sp WHERE sp.session_id = s.id AND sp.user_id = auth.uid()))
    AND public.is_part_of_session(s.id, auth.uid())
    AND public.session_expiry_reason(s) IS NULL   -- D.1: not an expired one
  ORDER BY s.created_at DESC
  LIMIT 1
$function$;
REVOKE ALL ON FUNCTION public.my_rejoinable_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_rejoinable_session() TO authenticated;
