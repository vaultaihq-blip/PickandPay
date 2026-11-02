-- Pick&Pay — D.7 (closed_reason): production state before 20261102150000, and its rollback
--
-- Read from production on 2026-11-02 (pg_get_functiondef), before the change.
-- Grants then: authenticated, service_role, postgres EXECUTE; none for anon.
-- Running this file puts join_preview back exactly as it was. Nothing else
-- was changed by the migration, so nothing else needs undoing.

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
