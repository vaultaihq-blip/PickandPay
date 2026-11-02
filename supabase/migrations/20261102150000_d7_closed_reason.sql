-- Pick&Pay — D.7 (this case): why a session ended, for the people who were in it
--
-- A phone that comes back to a session that has meanwhile ended has to say
-- why and go home (owner, 02-11-2026, test 1). session_closures is server
-- only, so join_preview's 'closed' answer now carries 'closed_reason':
--   host      — the host ended it (end_session)
--   inactive  — it expired (any rule, also read-time before the job closes it)
--               or was closed by the clean-up of old sessions
--   ended     — any other close
-- Only someone who has a row in the session, or is its host or original host,
-- gets the reason; everyone else gets 'closed' as before (privacy, R3/R7).
-- Nothing else in join_preview changes.

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
