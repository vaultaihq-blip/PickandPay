-- C3-fix3 — R4b (two-colour circles from the 9th person on) + R6 (the host
-- role moves to someone present when the host drops off after finalizing).
--
-- R4b
--   * session_participants.color2: the right half of a two-colour circle
--     (color is the left half). Set by the server with color, never by a
--     client (no column grant), and kept for good like color.
--   * Order: the 7 solid colours after the host's green, then the 18 pairs of
--     session_color_pairs(). Green is in no pair (the original host's only).
--     Pairs whose two halves are too close for someone with colour blindness
--     (worst ΔE under deutan/protan/tritan < 20) are left out: orange/yellow,
--     orange/pink, blue/pink. So 1 + 7 + 18 = 26 people get a unique mark;
--     past that color stays NULL (neutral grey) — see the report for a cap.
--   * unique (session_id, color, color2): no two people share a solid colour
--     or a pair. A check keeps a pair's halves different and green-free.
--
-- R6
--   * sessions.original_host_id: who created the session (set on insert,
--     never changed). Keeps green and the "original host" label; host_id is
--     who is host now, and every host check (is_session_host, RLS, the RPCs)
--     already follows host_id.
--   * session_presence: one heartbeat row per (session, user), written by
--     session_heartbeat() every few seconds from the lobby and the dashboard.
--     Realtime presence lives in the app, out of the database's sight; this is
--     how the server itself knows who is still here.
--   * transfer_host(session, expected host): only while awaiting_payment (after
--     finalize: countdown, pause, payment), only when the host's last heartbeat
--     is older than host_away_tolerance_ms() (10 s), to the first person of the
--     split still sending heartbeats, by order of arrival. The session row is
--     locked and host_id must still be the expected one, so however many
--     devices ask at once, one transfer happens. Logged in session_host_transfers.
--     A host who never sent a heartbeat (an older build) is never replaced.
--   * Nobody can write host_id directly any more (the old client takeover).
--   * expire_countdown_cancel (60 s, host offline) is dropped: R6 replaces it.

-- ── R4b ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.session_participants ADD COLUMN IF NOT EXISTS color2 text;

CREATE OR REPLACE FUNCTION public.session_color_pairs()
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  -- [i][1] left half, [i][2] right half. Ranked so each next pair is the one
  -- that stays farthest (under colour blindness) from those before it.
  SELECT ARRAY[
    ['#56B4E9','#E69F00'], ['#E69F00','#8C7CFF'], ['#56B4E9','#8C7CFF'], ['#A1887F','#E69F00'],
    ['#E69F00','#F1F5F9'], ['#8C7CFF','#F1F5F9'], ['#F1F5F9','#A1887F'], ['#F1F5F9','#56B4E9'],
    ['#A1887F','#56B4E9'], ['#8C7CFF','#A1887F'], ['#E879C9','#A1887F'], ['#F1F5F9','#F0E442'],
    ['#8C7CFF','#E879C9'], ['#F0E442','#56B4E9'], ['#8C7CFF','#F0E442'], ['#F0E442','#A1887F'],
    ['#E879C9','#F0E442'], ['#E879C9','#F1F5F9']]
$$;

-- ── R6: who created the session ────────────────────────────────────────────
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS original_host_id uuid REFERENCES auth.users (id) ON DELETE SET NULL;

ALTER TABLE public.sessions DISABLE TRIGGER update_sessions_updated_at;
UPDATE public.sessions SET original_host_id = host_id WHERE original_host_id IS NULL;
ALTER TABLE public.sessions ENABLE TRIGGER update_sessions_updated_at;

CREATE OR REPLACE FUNCTION public.set_session_original_host()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  NEW.original_host_id := NEW.host_id;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS set_session_original_host ON public.sessions;
CREATE TRIGGER set_session_original_host
  BEFORE INSERT ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_session_original_host();

GRANT SELECT (original_host_id) ON public.sessions TO authenticated;

-- ── R4b: colour assignment ─────────────────────────────────────────────────
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

-- Backfill: anyone left without a colour (9th person on) gets a pair, by
-- order of arrival. updated_at is left alone, as in C3-fix2.
ALTER TABLE public.session_participants DISABLE TRIGGER update_participants_updated_at;
WITH ranked AS (
  SELECT sp.id, row_number() OVER (PARTITION BY sp.session_id ORDER BY sp.created_at, sp.user_id) AS slot
  FROM public.session_participants sp
  WHERE sp.color IS NULL
)
UPDATE public.session_participants sp
SET color = (public.session_color_pairs())[r.slot][1],
    color2 = (public.session_color_pairs())[r.slot][2]
FROM ranked r
WHERE r.id = sp.id;
ALTER TABLE public.session_participants ENABLE TRIGGER update_participants_updated_at;

DROP INDEX IF EXISTS public.session_participants_session_color_key;
CREATE UNIQUE INDEX IF NOT EXISTS session_participants_session_colors_key
  ON public.session_participants (session_id, color, coalesce(color2, '')) WHERE color IS NOT NULL;

ALTER TABLE public.session_participants DROP CONSTRAINT IF EXISTS session_participants_color_pair_check;
ALTER TABLE public.session_participants ADD CONSTRAINT session_participants_color_pair_check
  CHECK (color2 IS NULL OR (color IS NOT NULL AND color2 <> color
                            AND color <> '#22C55E' AND color2 <> '#22C55E'));

GRANT SELECT (color2) ON public.session_participants TO authenticated;

-- ── R6: presence and transfer ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.session_presence (
  session_id   uuid NOT NULL REFERENCES public.sessions (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);
ALTER TABLE public.session_presence ENABLE ROW LEVEL SECURITY;   -- no policies: server only
REVOKE ALL ON public.session_presence FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.session_host_transfers (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id        uuid NOT NULL REFERENCES public.sessions (id) ON DELETE CASCADE,
  from_user_id      uuid NOT NULL,
  to_user_id        uuid NOT NULL,
  requested_by      uuid NOT NULL,
  from_last_seen_at timestamptz,
  transferred_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.session_host_transfers ENABLE ROW LEVEL SECURITY;   -- no policies: server only
REVOKE ALL ON public.session_host_transfers FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS session_host_transfers_session_idx ON public.session_host_transfers (session_id, transferred_at);

-- How long the host may be silent before the role moves (a few seconds of
-- bad network must not cost them the role). The app sends a heartbeat every 3 s.
CREATE OR REPLACE FUNCTION public.host_away_tolerance_ms()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 10000 $$;

-- People who count as present in a session (not pending / cancelled / left).
CREATE OR REPLACE FUNCTION public.is_present_status(p_status text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT p_status IN ('joined', 'selecting', 'items_picked') $$;

-- What every device needs to know about the host, read in one place.
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
    'last_transfer', (SELECT jsonb_build_object('from_user_id', t.from_user_id, 'to_user_id', t.to_user_id, 'at', t.transferred_at)
                      FROM public.session_host_transfers t
                      WHERE t.session_id = s.id ORDER BY t.transferred_at DESC, t.id DESC LIMIT 1))
$$;

REVOKE ALL ON FUNCTION public.host_snapshot(public.sessions) FROM PUBLIC, anon, authenticated;

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

REVOKE ALL ON FUNCTION public.session_heartbeat(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transfer_host(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_heartbeat(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_host(uuid, uuid) TO authenticated;

-- The host role only moves through transfer_host.
REVOKE UPDATE (host_id) ON public.sessions FROM authenticated;

-- R6 replaces the 60 s expiry of a cancel request.
DROP FUNCTION IF EXISTS public.expire_countdown_cancel(uuid);
