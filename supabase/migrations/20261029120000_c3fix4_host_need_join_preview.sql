-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — C3-fix4: session cap of 26, R6b (the host role moves only when
-- someone needs the host), R7 (the QR is always read; the entry screen asks
-- the server what to show)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Cap
--   * assign_participant_color refuses the 27th row of a session
--     (SESSION_FULL, PP409) instead of leaving it without a colour. Rows keep
--     their colour for good, so the cap counts every row of the session.
--
-- R6b (replaces R6)
--   * The role can move at any point before the session is closed, not only
--     after finalize.
--   * host_waiting(s): what is waiting for the host, read from the session
--     itself — a pending cancel request, or every present participant (not the
--     host) has pressed Done before finalize (picked_at, new, set by trigger).
--   * host_transfer_check(s): due when the host is silent for 15 s counted
--     from max(host's last heartbeat, start of the wait), or silent for 5 min
--     with nothing waiting. Never due without any heartbeat from the host.
--   * transfer_host uses that check; the candidate is the first present
--     person by arrival (in the frozen split after finalize) with a heartbeat
--     in the last 15 s. The reason is stored with the transfer.
--   * leave_as_host: the host leaving on purpose hands the role over straight
--     away (or answers "alone" when nobody else is in the session).
--   * The check runs on the server whenever any present device sends its
--     heartbeat; no job needed (a transfer needs someone present anyway).
--
-- R7
--   * is_part_of_session(session, user): current or original host; or a row
--     pending / joined / selecting / items_picked; or a row that left after
--     paying for this session.
--   * join_preview(session): closed / rejoin / full / join / no_credits /
--     not_found, with only the host's name and the number of people.
--   * enforce_session_credit: coming back needs no credit for someone who is
--     part of the session (pending → joined included; the original host too).
--   * my_rejoinable_session() for the home banner; my_returnable_sessions
--     (24 h rule) is dropped.

-- ── Cap: 26 people ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.session_max_people()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(public.session_color_palette()) + array_length(public.session_color_pairs(), 1)
$$;

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
  LIMIT 1;
  IF NEW.color IS NULL THEN
    RAISE EXCEPTION 'SESSION_FULL' USING ERRCODE = 'PP409',
      HINT = format('A session holds at most %s people.', public.session_max_people());
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.assign_participant_color() FROM PUBLIC, anon, authenticated;

-- ── R6b: when the last Done happened ────────────────────────────────────────
ALTER TABLE public.session_participants ADD COLUMN IF NOT EXISTS picked_at timestamptz;

CREATE OR REPLACE FUNCTION public.set_participant_picked_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.picked_at := CASE WHEN NEW.status = 'items_picked' THEN now() END;
  ELSE
    NEW.picked_at := OLD.picked_at;   -- server-owned
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.set_participant_picked_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS set_participant_picked_at ON public.session_participants;
CREATE TRIGGER set_participant_picked_at
  BEFORE INSERT OR UPDATE ON public.session_participants
  FOR EACH ROW EXECUTE FUNCTION public.set_participant_picked_at();

ALTER TABLE public.session_participants DISABLE TRIGGER update_participants_updated_at;
ALTER TABLE public.session_participants DISABLE TRIGGER set_participant_picked_at;
UPDATE public.session_participants SET picked_at = updated_at WHERE status = 'items_picked' AND picked_at IS NULL;
ALTER TABLE public.session_participants ENABLE TRIGGER set_participant_picked_at;
ALTER TABLE public.session_participants ENABLE TRIGGER update_participants_updated_at;

ALTER TABLE public.session_host_transfers ADD COLUMN IF NOT EXISTS reason text;

-- ── R6b: tolerances ─────────────────────────────────────────────────────────
-- Something waits for the host: 15 s of silence. Also how recent a heartbeat
-- must be for someone to receive the role.
CREATE OR REPLACE FUNCTION public.host_away_tolerance_ms()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 15000 $$;

-- Nothing waits for the host: they may lock the phone or switch apps.
CREATE OR REPLACE FUNCTION public.host_idle_tolerance_ms()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 300000 $$;

-- What is waiting for the host right now, and since when (no rows = nothing).
CREATE OR REPLACE FUNCTION public.host_waiting(s public.sessions)
RETURNS TABLE (kind text, since timestamptz)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT 'cancel_request'::text, s.cancel_request_at
  WHERE s.status = 'awaiting_payment' AND s.cancel_request_user_id IS NOT NULL
  UNION ALL
  SELECT 'all_picked'::text, max(sp.picked_at)
  FROM public.session_participants sp
  WHERE s.status NOT IN ('awaiting_payment', 'paid', 'closed')
    AND sp.session_id = s.id AND sp.user_id <> s.host_id AND public.is_present_status(sp.status)
  HAVING count(*) > 0 AND bool_and(sp.status = 'items_picked')
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.host_waiting(public.sessions) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.host_transfer_check(s public.sessions)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION public.host_snapshot(s public.sessions)
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
$$;
REVOKE ALL ON FUNCTION public.host_snapshot(public.sessions) FROM PUBLIC, anon, authenticated;

-- The first present person by arrival who may receive the role (in the frozen
-- split after finalize). p_fresh_only: only someone with a recent heartbeat.
CREATE OR REPLACE FUNCTION public.next_host_candidate(s public.sessions, p_fresh_only boolean)
RETURNS uuid
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
$$;
REVOKE ALL ON FUNCTION public.next_host_candidate(public.sessions, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.transfer_host(p_session_id uuid, p_expected_host_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  s       public.sessions;
  v_check jsonb;
  v_seen  timestamptz;
  v_new   uuid;
  v_set   uuid;
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
  v_check := public.host_transfer_check(s);
  IF NOT (v_check->>'transfer_due')::boolean THEN
    RETURN jsonb_build_object('result', v_check->>'transfer_reason') || public.host_snapshot(s);
  END IF;

  v_new := public.next_host_candidate(s, true);
  IF v_new IS NULL THEN
    RETURN jsonb_build_object('result', 'no_one_present') || public.host_snapshot(s);
  END IF;
  SELECT last_seen_at INTO v_seen FROM public.session_presence WHERE session_id = s.id AND user_id = s.host_id;

  UPDATE public.sessions SET host_id = v_new
  WHERE id = s.id AND host_id = s.host_id
  RETURNING host_id INTO v_set;
  IF v_set IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'Host transfer did not apply' USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.session_host_transfers (session_id, from_user_id, to_user_id, requested_by, from_last_seen_at, reason)
  VALUES (s.id, s.host_id, v_new, v_uid, v_seen, v_check->>'transfer_reason');

  SELECT * INTO s FROM public.sessions WHERE id = p_session_id;
  RETURN jsonb_build_object('result', 'transferred', 'from_user_id', p_expected_host_id, 'to_user_id', v_new,
                            'reason', v_check->>'transfer_reason')
         || public.host_snapshot(s);
END;
$function$;

-- R6b rule 3: the host leaves on purpose — the role moves now.
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

REVOKE ALL ON FUNCTION public.transfer_host(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leave_as_host(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_host(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_as_host(uuid) TO authenticated;

-- ── R7: who is already part of a session ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_part_of_session(p_session_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p_user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.sessions s
            WHERE s.id = p_session_id AND p_user_id IN (s.host_id, s.original_host_id))
    OR EXISTS (SELECT 1 FROM public.session_participants sp
               WHERE sp.session_id = p_session_id AND sp.user_id = p_user_id
                 AND (sp.status IN ('pending', 'joined', 'selecting', 'items_picked')
                      OR (sp.status IN ('left', 'cancelled') AND public.has_session_consumption(p_session_id, p_user_id)))))
$$;
REVOKE ALL ON FUNCTION public.is_part_of_session(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.join_preview(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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

-- Home banner: the most recent open session this user is part of.
CREATE OR REPLACE FUNCTION public.my_rejoinable_session()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
$$;
REVOKE ALL ON FUNCTION public.my_rejoinable_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_rejoinable_session() TO authenticated;

DROP FUNCTION IF EXISTS public.my_returnable_sessions();

-- ── R7: the server still decides (a modified app cannot skip the screen) ────
CREATE OR REPLACE FUNCTION public.enforce_session_credit()
RETURNS trigger
LANGUAGE plpgsql
-- DEFINER so it can call has_session_credit(), which clients cannot execute
-- (it would tell anyone whether any user id has credits). auth.uid() still
-- reads the caller's JWT.
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
    -- Own row: coming back after cancelling or leaving. R7: no credit for
    -- someone who already paid for this session or is its (original) host;
    -- pending → joined needs none (the credit was checked at the insert).
    v_need := NEW.status IS DISTINCT FROM OLD.status
      AND OLD.status IN ('cancelled', 'left')
      AND NEW.status IN ('pending', 'joined', 'selecting', 'items_picked')
      AND NOT public.has_session_consumption(NEW.session_id, NEW.user_id)
      AND NOT EXISTS (SELECT 1 FROM public.sessions
                      WHERE id = NEW.session_id AND v_uid IN (host_id, original_host_id));
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
