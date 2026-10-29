-- Rollback for 20261029150000_c3fix5_foreground_heartbeat.sql
--
-- Pre-state (read from production before applying, 2026-10-29; the function
-- bodies below are pg_get_functiondef output saved then):
--   * session_heartbeat(uuid): EXECUTE to authenticated, service_role.
--   * host_transfer_check, host_snapshot, next_host_candidate: the C3-fix4
--     versions (any heartbeat counts as present), not callable by clients.
--   * session_presence without last_foreground_at.
--
-- Clients: roll the app back first — a C3-fix5 build calls
-- session_heartbeat(p_session_id, p_foreground), which this removes.

BEGIN;

DROP FUNCTION IF EXISTS public.session_heartbeat(uuid, boolean);
CREATE OR REPLACE FUNCTION public.session_heartbeat(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  s public.sessions;
  v_here boolean;
BEGIN
  SELECT * INTO s FROM public.sessions WHERE id = p_session_id;
  IF NOT FOUND OR v_uid IS NULL OR NOT (v_uid = s.host_id OR public.is_session_member(p_session_id)) THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002';
  END IF;
  -- Someone who left (or never got in) reads the state but is not "here".
  v_here := v_uid = s.host_id OR EXISTS (
    SELECT 1 FROM public.session_participants
    WHERE session_id = p_session_id AND user_id = v_uid AND public.is_present_status(status));
  IF v_here AND s.status <> 'closed' THEN
    INSERT INTO public.session_presence (session_id, user_id, last_seen_at)
    VALUES (p_session_id, v_uid, now())
    ON CONFLICT (session_id, user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at;
  END IF;
  RETURN jsonb_build_object('present', v_here) || public.host_snapshot(s);
END;
$function$;
REVOKE ALL ON FUNCTION public.session_heartbeat(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_heartbeat(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.host_transfer_check(s sessions)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_seen  timestamptz;
  v_kind  text;
  v_since timestamptz;
  v_reason text;
BEGIN
  SELECT last_seen_at INTO v_seen FROM public.session_presence WHERE session_id = s.id AND user_id = s.host_id;
  SELECT w.kind, w.since INTO v_kind, v_since FROM public.host_waiting(s) w;
  v_reason := CASE
    WHEN s.status = 'closed' THEN 'closed'
    -- No heartbeat ever (a build without R6): never treated as gone.
    WHEN v_seen IS NULL THEN 'host_unknown'
    WHEN v_kind IS NOT NULL
         AND greatest(v_seen, coalesce(v_since, v_seen)) <= now() - make_interval(secs => public.host_away_tolerance_ms() / 1000.0)
      THEN 'host_needed'
    WHEN v_seen <= now() - make_interval(secs => public.host_idle_tolerance_ms() / 1000.0) THEN 'host_idle'
    ELSE 'host_present'
  END;
  RETURN jsonb_build_object(
    'transfer_due', v_reason IN ('host_needed', 'host_idle'),
    'transfer_reason', v_reason,
    'waiting', v_kind,
    'waiting_since', v_since);
END;
$function$;
REVOKE ALL ON FUNCTION public.host_transfer_check(public.sessions) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.host_snapshot(s sessions)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'status', s.status,
    'host_id', s.host_id,
    'original_host_id', s.original_host_id,
    'host_away_ms', (SELECT (extract(epoch FROM (now() - pr.last_seen_at)) * 1000)::int
                     FROM public.session_presence pr
                     WHERE pr.session_id = s.id AND pr.user_id = s.host_id),
    'tolerance_ms', public.host_away_tolerance_ms(),
    'idle_tolerance_ms', public.host_idle_tolerance_ms(),
    'last_transfer', (SELECT jsonb_build_object('from_user_id', t.from_user_id, 'to_user_id', t.to_user_id,
                                                'at', t.transferred_at, 'reason', t.reason)
                      FROM public.session_host_transfers t
                      WHERE t.session_id = s.id ORDER BY t.transferred_at DESC, t.id DESC LIMIT 1))
  || public.host_transfer_check(s)
$function$;
REVOKE ALL ON FUNCTION public.host_snapshot(public.sessions) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.next_host_candidate(s sessions, p_fresh_only boolean)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT sp.user_id
  FROM public.session_participants sp
  LEFT JOIN public.session_presence pr ON pr.session_id = sp.session_id AND pr.user_id = sp.user_id
  WHERE sp.session_id = s.id
    AND sp.user_id <> s.host_id
    AND public.is_present_status(sp.status)
    AND (s.status <> 'awaiting_payment' OR sp.user_id = ANY (coalesce(s.split_user_ids, '{}')))
    AND (NOT p_fresh_only
         OR pr.last_seen_at > now() - make_interval(secs => public.host_away_tolerance_ms() / 1000.0))
  ORDER BY (pr.last_seen_at > now() - make_interval(secs => public.host_away_tolerance_ms() / 1000.0)) IS TRUE DESC,
           sp.created_at, sp.user_id
  LIMIT 1
$function$;
REVOKE ALL ON FUNCTION public.next_host_candidate(public.sessions, boolean) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.session_presence DROP COLUMN IF EXISTS last_foreground_at;

-- Remove the migration's row so `supabase db push` would apply it again.
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261029150000';

COMMIT;
