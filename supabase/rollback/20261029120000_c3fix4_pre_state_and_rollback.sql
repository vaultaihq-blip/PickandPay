-- Rollback for 20261029120000_c3fix4_host_need_join_preview.sql
--
-- Pre-state (read from production before applying, 2026-10-29; the function
-- bodies below are pg_get_functiondef output saved then):
--   * assign_participant_color(): C3-fix3 version (NULL colour past the 26th).
--   * enforce_session_credit(): C.3 version (pending → joined needs a credit;
--     no exemption for the original host).
--   * host_away_tolerance_ms() = 10000; host_snapshot(sessions) without the
--     transfer check; transfer_host(uuid, uuid): only after finalize.
--   * my_returnable_sessions(): EXECUTE to authenticated, service_role.
--   * No picked_at, session_host_transfers.reason, session_max_people,
--     host_idle_tolerance_ms, host_waiting, host_transfer_check,
--     next_host_candidate, leave_as_host, is_part_of_session, join_preview,
--     my_rejoinable_session, set_participant_picked_at.
--
-- Data notes:
--   * Host changes made under R6b stay (they are who is host now); the reason
--     of each recorded transfer is dropped with its column.
--   * picked_at is dropped (it is only read by the R6b check).
--
-- Clients: roll the app back first — a C3-fix4 build calls join_preview,
-- my_rejoinable_session and leave_as_host.

BEGIN;

CREATE OR REPLACE FUNCTION public.assign_participant_color()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_palette text[] := public.session_color_palette();
  v_pairs   text[] := public.session_color_pairs();
  v_host uuid;
BEGIN
  NEW.color2 := NULL;
  SELECT coalesce(original_host_id, host_id) INTO v_host FROM public.sessions WHERE id = NEW.session_id;
  IF NEW.user_id = v_host THEN
    NEW.color := v_palette[1];
    RETURN NEW;
  END IF;
  -- Serialises colour picks within one session (released at commit).
  PERFORM pg_advisory_xact_lock(hashtextextended('session_color:' || NEW.session_id::text, 0));
  SELECT c INTO NEW.color
  FROM unnest(v_palette[2:]) WITH ORDINALITY AS p(c, i)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.session_participants sp
    WHERE sp.session_id = NEW.session_id AND sp.color = p.c AND sp.color2 IS NULL
  )
  ORDER BY i
  LIMIT 1;
  IF NEW.color IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- Solid colours used up: the first free pair.
  SELECT v_pairs[i][1], v_pairs[i][2] INTO NEW.color, NEW.color2
  FROM generate_subscripts(v_pairs, 1) AS i
  WHERE NOT EXISTS (
    SELECT 1 FROM public.session_participants sp
    WHERE sp.session_id = NEW.session_id AND sp.color = v_pairs[i][1] AND sp.color2 = v_pairs[i][2]
  )
  ORDER BY i
  LIMIT 1;   -- both NULL past the 26th person
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.assign_participant_color() FROM PUBLIC, anon, authenticated;

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
    -- Own row: coming (back) into the session.
    v_need := NEW.status IS DISTINCT FROM OLD.status
      AND (
        (OLD.status IN ('cancelled', 'left') AND NEW.status IN ('pending', 'joined', 'selecting', 'items_picked'))
        OR (OLD.status = 'pending' AND NEW.status IN ('joined', 'selecting', 'items_picked'))
      )
      AND NOT public.has_session_consumption(NEW.session_id, NEW.user_id);
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
REVOKE ALL ON FUNCTION public.enforce_session_credit() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.host_away_tolerance_ms()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT 10000 $function$;

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
    'last_transfer', (SELECT jsonb_build_object('from_user_id', t.from_user_id, 'to_user_id', t.to_user_id, 'at', t.transferred_at)
                      FROM public.session_host_transfers t
                      WHERE t.session_id = s.id ORDER BY t.transferred_at DESC, t.id DESC LIMIT 1))
$function$;
REVOKE ALL ON FUNCTION public.host_snapshot(public.sessions) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.transfer_host(p_session_id uuid, p_expected_host_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  s      public.sessions;
  v_seen timestamptz;
  v_new  uuid;
  v_set  uuid;
BEGIN
  -- One transfer at a time per session: everyone else waits here, then finds
  -- host_id already changed.
  SELECT * INTO s FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_uid IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.session_participants
       WHERE session_id = p_session_id AND user_id = v_uid AND public.is_present_status(status)) THEN
    RAISE EXCEPTION 'Only someone in the session can ask for a new host' USING ERRCODE = '42501';
  END IF;
  -- Whoever asks is here right now.
  INSERT INTO public.session_presence (session_id, user_id, last_seen_at)
  VALUES (p_session_id, v_uid, now())
  ON CONFLICT (session_id, user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at;

  IF s.host_id IS DISTINCT FROM p_expected_host_id THEN
    RETURN jsonb_build_object('result', 'already_transferred') || public.host_snapshot(s);
  END IF;
  IF s.status <> 'awaiting_payment' THEN
    RETURN jsonb_build_object('result', 'not_finalized') || public.host_snapshot(s);
  END IF;
  SELECT last_seen_at INTO v_seen FROM public.session_presence WHERE session_id = s.id AND user_id = s.host_id;
  IF v_seen IS NULL THEN
    -- No heartbeat ever (a build without R6): never treated as gone.
    RETURN jsonb_build_object('result', 'host_unknown') || public.host_snapshot(s);
  END IF;
  IF v_seen > now() - make_interval(secs => public.host_away_tolerance_ms() / 1000.0) THEN
    RETURN jsonb_build_object('result', 'host_present') || public.host_snapshot(s);
  END IF;

  SELECT sp.user_id INTO v_new
  FROM public.session_participants sp
  JOIN public.session_presence pr ON pr.session_id = sp.session_id AND pr.user_id = sp.user_id
  WHERE sp.session_id = s.id
    AND sp.user_id <> s.host_id
    AND sp.user_id = ANY (coalesce(s.split_user_ids, '{}'))
    AND public.is_present_status(sp.status)
    AND pr.last_seen_at > now() - make_interval(secs => public.host_away_tolerance_ms() / 1000.0)
  ORDER BY sp.created_at, sp.user_id
  LIMIT 1;
  IF v_new IS NULL THEN
    RETURN jsonb_build_object('result', 'no_one_present') || public.host_snapshot(s);
  END IF;

  UPDATE public.sessions SET host_id = v_new
  WHERE id = s.id AND host_id = s.host_id
  RETURNING host_id INTO v_set;
  IF v_set IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'Host transfer did not apply' USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.session_host_transfers (session_id, from_user_id, to_user_id, requested_by, from_last_seen_at)
  VALUES (s.id, s.host_id, v_new, v_uid, v_seen);

  SELECT * INTO s FROM public.sessions WHERE id = p_session_id;
  RETURN jsonb_build_object('result', 'transferred', 'from_user_id', p_expected_host_id, 'to_user_id', v_new)
         || public.host_snapshot(s);
END;
$function$;
REVOKE ALL ON FUNCTION public.transfer_host(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_host(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.my_returnable_sessions()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(array_agg(DISTINCT sp.session_id), '{}')
  FROM public.session_participants sp
  JOIN public.sessions s ON s.id = sp.session_id
  WHERE sp.user_id = auth.uid()
    AND sp.role <> 'host'
    AND s.host_id <> auth.uid()
    AND s.status <> 'closed'
    AND s.created_at > now() - interval '24 hours'
    AND (
      (sp.status IN ('joined', 'selecting', 'items_picked') AND s.status <> 'awaiting_payment')
      OR (sp.status = 'left' AND EXISTS (
            SELECT 1 FROM public.session_credit_consumptions c
            WHERE c.session_id = sp.session_id AND c.user_id = sp.user_id AND c.refunded_at IS NULL))
    );
$function$;
REVOKE ALL ON FUNCTION public.my_returnable_sessions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_returnable_sessions() TO authenticated;

DROP FUNCTION IF EXISTS public.leave_as_host(uuid);
DROP FUNCTION IF EXISTS public.join_preview(uuid);
DROP FUNCTION IF EXISTS public.my_rejoinable_session();
DROP FUNCTION IF EXISTS public.is_part_of_session(uuid, uuid);
DROP FUNCTION IF EXISTS public.next_host_candidate(public.sessions, boolean);
DROP FUNCTION IF EXISTS public.host_transfer_check(public.sessions);
DROP FUNCTION IF EXISTS public.host_waiting(public.sessions);
DROP FUNCTION IF EXISTS public.host_idle_tolerance_ms();
DROP FUNCTION IF EXISTS public.session_max_people();

DROP TRIGGER IF EXISTS set_participant_picked_at ON public.session_participants;
DROP FUNCTION IF EXISTS public.set_participant_picked_at();
ALTER TABLE public.session_participants DROP COLUMN IF EXISTS picked_at;
ALTER TABLE public.session_host_transfers DROP COLUMN IF EXISTS reason;

-- Remove the migration's row so `supabase db push` would apply it again.
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261029120000';

COMMIT;
