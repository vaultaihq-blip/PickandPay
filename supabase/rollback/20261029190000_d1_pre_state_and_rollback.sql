-- Rollback for 20261029190000_d1_session_lifecycle.sql
--
-- Pre-state (read from production before applying, 2026-10-29; bodies are
-- pg_get_functiondef output saved then):
--   * join_preview(uuid), my_rejoinable_session(): C3-fix4 versions, EXECUTE
--     to authenticated, service_role.
--   * No session_closures, session_last_activity, session_expiry_*,
--     record_session_closure, end_session, expire_abandoned_sessions.
--
-- Data notes:
--   * Sessions closed while D.1 was in place stay closed; session_closures,
--     the record of why, is dropped. Copy it first if it is wanted.
--   * Drop the pg_cron job first if the D.1b migration was applied
--     (its own rollback file does that).
--
-- Clients: a D.5 build calls end_session; roll the app back first.

BEGIN;

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
  IF s.status = 'closed' THEN
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
  ORDER BY s.created_at DESC
  LIMIT 1
$function$;
REVOKE ALL ON FUNCTION public.my_rejoinable_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_rejoinable_session() TO authenticated;

DROP FUNCTION IF EXISTS public.expire_abandoned_sessions();
DROP FUNCTION IF EXISTS public.end_session(uuid);
DROP TRIGGER IF EXISTS record_session_closure ON public.sessions;
DROP FUNCTION IF EXISTS public.record_session_closure();
DROP FUNCTION IF EXISTS public.session_expiry_reason(public.sessions);
DROP FUNCTION IF EXISTS public.session_expiry_hours_payment();
DROP FUNCTION IF EXISTS public.session_expiry_hours_before_finalize();
DROP FUNCTION IF EXISTS public.session_expiry_hours_no_receipt();
DROP FUNCTION IF EXISTS public.session_last_activity(public.sessions);
DROP TABLE IF EXISTS public.session_closures;

-- Remove the migration's row so `supabase db push` would apply it again.
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261029190000';

COMMIT;
