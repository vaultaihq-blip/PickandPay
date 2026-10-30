-- C3-fix2 — R4 (session colours set by the server) + R5 (participants ask to
-- cancel the countdown) + a balance log for bill_credits.
--
-- R4
--   * session_participants.color: given by the server when the row is
--     created, never by a client (no column grant). The session host
--     (sessions.host_id) always gets green; everyone else the first free colour
--     of the palette, under a per-session advisory lock, so two people joining
--     at once never get the same one. unique (session_id, color).
--   * The palette has 8 colours (host + 7). From the 9th person on the colour
--     is NULL; the app then shows a neutral grey (initials/photo tell people
--     apart). A row keeps its colour for good: cancel / leave / come back
--     reuse the same row.
--   * Backfill: host green, the others by created_at.
--
-- R5
--   * The countdown runs after finalize_session (status awaiting_payment). Its
--     state lives on sessions: countdown_started_at (set when the status
--     becomes awaiting_payment), countdown_paused_at / countdown_remaining_ms
--     (a pause), cancel_request_user_id / cancel_request_at (the one active
--     request) and cancel_last_* (the last decision: declined / expired /
--     accepted, for "the host declined" on the requester's device).
--   * request_countdown_cancel: someone in the split (not the host) while the
--     countdown is running. Pauses it for everyone. Only one request at a time.
--   * decide_countdown_cancel: host only. Accept → status selecting (everyone
--     back to selection; finalize_session charges nobody again). Decline → the
--     countdown resumes with the time it had left.
--   * expire_countdown_cancel: anyone in the session, once a request is older
--     than 60 s with no decision (host offline) → resumes, decision 'expired'.
--   * Leaving awaiting_payment (host cancel, accept, close) clears all of it.
--
-- Balance log: every change of profiles.bill_credits (old → new, when, by
-- which JWT user / DB role), so "how many credits did X have at 17:20" can be
-- answered later. Server-only table.

-- ── R4 ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.session_participants ADD COLUMN IF NOT EXISTS color text;

CREATE OR REPLACE FUNCTION public.session_color_palette()
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  -- [1] is the host's. Checked for contrast on the dark surfaces (≥ 5.4:1)
  -- and separation under deuteranopia/protanopia/tritanopia (min ΔE ≥ 11).
  SELECT ARRAY['#22C55E', '#56B4E9', '#E69F00', '#F0E442', '#E879C9', '#F1F5F9', '#A1887F', '#8C7CFF']
$$;

CREATE OR REPLACE FUNCTION public.assign_participant_color()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_palette text[] := public.session_color_palette();
  v_host uuid;
BEGIN
  SELECT host_id INTO v_host FROM public.sessions WHERE id = NEW.session_id;
  IF NEW.user_id = v_host THEN
    NEW.color := v_palette[1];
    RETURN NEW;
  END IF;
  -- Serialises colour picks within one session (released at commit).
  PERFORM pg_advisory_xact_lock(hashtextextended('session_color:' || NEW.session_id::text, 0));
  SELECT c INTO NEW.color
  FROM unnest(v_palette[2:]) WITH ORDINALITY AS p(c, i)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.session_participants sp WHERE sp.session_id = NEW.session_id AND sp.color = p.c
  )
  ORDER BY i
  LIMIT 1;   -- NULL when the palette is used up
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_participant_color() FROM PUBLIC, anon, authenticated;

-- Backfill before the index: host green, the rest by order of arrival.
-- updated_at is left alone: this is not a change anyone made to the row.
ALTER TABLE public.session_participants DISABLE TRIGGER update_participants_updated_at;
WITH ranked AS (
  SELECT sp.id,
         CASE WHEN sp.user_id = s.host_id THEN 1
              ELSE 1 + row_number() OVER (
                PARTITION BY sp.session_id, (sp.user_id = s.host_id)
                ORDER BY sp.created_at, sp.user_id)
         END AS slot
  FROM public.session_participants sp
  JOIN public.sessions s ON s.id = sp.session_id
)
UPDATE public.session_participants sp
SET color = (public.session_color_palette())[r.slot]   -- NULL past the end
FROM ranked r
WHERE r.id = sp.id AND sp.color IS NULL;
ALTER TABLE public.session_participants ENABLE TRIGGER update_participants_updated_at;

CREATE UNIQUE INDEX IF NOT EXISTS session_participants_session_color_key
  ON public.session_participants (session_id, color) WHERE color IS NOT NULL;

DROP TRIGGER IF EXISTS assign_participant_color ON public.session_participants;
CREATE TRIGGER assign_participant_color
  BEFORE INSERT ON public.session_participants
  FOR EACH ROW EXECUTE FUNCTION public.assign_participant_color();

GRANT SELECT (color) ON public.session_participants TO authenticated;

-- ── R5 ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS countdown_started_at   timestamptz,
  ADD COLUMN IF NOT EXISTS countdown_paused_at    timestamptz,
  ADD COLUMN IF NOT EXISTS countdown_remaining_ms integer,
  ADD COLUMN IF NOT EXISTS cancel_request_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_request_at      timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_last_decision   text CHECK (cancel_last_decision IN ('declined', 'expired', 'accepted')),
  ADD COLUMN IF NOT EXISTS cancel_last_user_id    uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_last_at         timestamptz;

GRANT SELECT (countdown_started_at, countdown_paused_at, countdown_remaining_ms,
              cancel_request_user_id, cancel_request_at,
              cancel_last_decision, cancel_last_user_id, cancel_last_at)
  ON public.sessions TO authenticated;

-- Seconds of the countdown the app shows (FINAL_COUNTDOWN in the lobby).
CREATE OR REPLACE FUNCTION public.countdown_length_ms()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 5000 $$;

CREATE OR REPLACE FUNCTION public.session_countdown_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'awaiting_payment' THEN
    NEW.countdown_started_at := now();
  ELSE
    NEW.countdown_started_at := NULL;
  END IF;
  -- A new countdown, or none at all: no pause, no open request.
  NEW.countdown_paused_at := NULL;
  NEW.countdown_remaining_ms := NULL;
  NEW.cancel_request_user_id := NULL;
  NEW.cancel_request_at := NULL;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS session_countdown_state ON public.sessions;
CREATE TRIGGER session_countdown_state
  BEFORE UPDATE OF status ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.session_countdown_state();

-- What every device needs to draw the countdown, read in one place.
CREATE OR REPLACE FUNCTION public.countdown_snapshot(s public.sessions)
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT jsonb_build_object(
    'status', s.status,
    'paused', s.countdown_paused_at IS NOT NULL,
    'remaining_ms', CASE
      WHEN s.countdown_started_at IS NULL THEN NULL
      WHEN s.countdown_paused_at IS NOT NULL THEN s.countdown_remaining_ms
      ELSE greatest(0, public.countdown_length_ms()
                       - (extract(epoch FROM (now() - s.countdown_started_at)) * 1000)::int)
    END,
    'request_user_id', s.cancel_request_user_id,
    'request_at', s.cancel_request_at,
    'last_decision', s.cancel_last_decision,
    'last_user_id', s.cancel_last_user_id,
    'last_at', s.cancel_last_at)
$$;

CREATE OR REPLACE FUNCTION public.request_countdown_cancel(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  s public.sessions;
  v_left integer;
BEGIN
  SELECT * INTO s FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_uid IS NULL OR v_uid = s.host_id OR NOT (v_uid = ANY (coalesce(s.split_user_ids, '{}'))) THEN
    RAISE EXCEPTION 'Only someone in the split (not the host) can ask to cancel' USING ERRCODE = '42501';
  END IF;
  IF s.status <> 'awaiting_payment' OR s.countdown_started_at IS NULL THEN
    RETURN jsonb_build_object('result', 'no_countdown') || public.countdown_snapshot(s);
  END IF;
  IF s.cancel_request_user_id IS NOT NULL THEN
    RETURN jsonb_build_object('result', CASE WHEN s.cancel_request_user_id = v_uid THEN 'requested' ELSE 'already_requested' END)
           || public.countdown_snapshot(s);
  END IF;
  v_left := public.countdown_length_ms() - (extract(epoch FROM (now() - s.countdown_started_at)) * 1000)::int;
  IF v_left <= 0 THEN
    RETURN jsonb_build_object('result', 'countdown_over') || public.countdown_snapshot(s);
  END IF;
  UPDATE public.sessions
  SET countdown_paused_at = now(), countdown_remaining_ms = v_left,
      cancel_request_user_id = v_uid, cancel_request_at = now()
  WHERE id = p_session_id
  RETURNING * INTO s;
  RETURN jsonb_build_object('result', 'requested') || public.countdown_snapshot(s);
END;
$function$;

-- Resumes a paused countdown with the time it had left (decline / expiry).
CREATE OR REPLACE FUNCTION public.resume_countdown(p_session_id uuid, p_decision text)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  s public.sessions;
BEGIN
  UPDATE public.sessions
  SET countdown_started_at = now() - make_interval(secs => (public.countdown_length_ms() - countdown_remaining_ms) / 1000.0),
      countdown_paused_at = NULL, countdown_remaining_ms = NULL,
      cancel_last_decision = p_decision, cancel_last_user_id = cancel_request_user_id, cancel_last_at = now(),
      cancel_request_user_id = NULL, cancel_request_at = NULL
  WHERE id = p_session_id
  RETURNING * INTO s;
  RETURN s;
END;
$function$;

REVOKE ALL ON FUNCTION public.resume_countdown(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.decide_countdown_cancel(p_session_id uuid, p_accept boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  s public.sessions;
  v_requester uuid;
BEGIN
  SELECT * INTO s FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_uid IS NULL OR v_uid <> s.host_id THEN
    RAISE EXCEPTION 'Only the host decides' USING ERRCODE = '42501';
  END IF;
  IF s.status <> 'awaiting_payment' OR s.cancel_request_user_id IS NULL THEN
    RETURN jsonb_build_object('result', 'no_request') || public.countdown_snapshot(s);
  END IF;
  v_requester := s.cancel_request_user_id;
  IF p_accept THEN
    -- session_countdown_state clears the countdown; selections stay as they are.
    UPDATE public.sessions
    SET status = 'selecting',
        cancel_last_decision = 'accepted', cancel_last_user_id = v_requester, cancel_last_at = now()
    WHERE id = p_session_id
    RETURNING * INTO s;
    RETURN jsonb_build_object('result', 'accepted') || public.countdown_snapshot(s);
  END IF;
  s := public.resume_countdown(p_session_id, 'declined');
  RETURN jsonb_build_object('result', 'declined') || public.countdown_snapshot(s);
END;
$function$;

CREATE OR REPLACE FUNCTION public.expire_countdown_cancel(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  s public.sessions;
BEGIN
  SELECT * INTO s FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND OR NOT (auth.uid() = s.host_id OR public.is_session_member(p_session_id)) THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002';
  END IF;
  IF s.status = 'awaiting_payment' AND s.cancel_request_user_id IS NOT NULL
     AND s.cancel_request_at <= now() - interval '60 seconds' THEN
    s := public.resume_countdown(p_session_id, 'expired');
    RETURN jsonb_build_object('result', 'expired') || public.countdown_snapshot(s);
  END IF;
  RETURN jsonb_build_object('result', 'not_due') || public.countdown_snapshot(s);
END;
$function$;

REVOKE ALL ON FUNCTION public.request_countdown_cancel(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decide_countdown_cancel(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.expire_countdown_cancel(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_countdown_cancel(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_countdown_cancel(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_countdown_cancel(uuid) TO authenticated;

-- ── Balance log ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.credit_balance_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL,          -- no FK: the log outlives the profile (E)
  old_credits integer,
  new_credits integer,
  jwt_user_id uuid,                   -- auth.uid() of the change (NULL = SQL / service)
  db_role     text NOT NULL DEFAULT current_user,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.credit_balance_log ENABLE ROW LEVEL SECURITY;   -- no policies: server only
REVOKE ALL ON public.credit_balance_log FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS credit_balance_log_user_idx ON public.credit_balance_log (user_id, changed_at);

CREATE OR REPLACE FUNCTION public.log_credit_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.credit_balance_log (user_id, old_credits, new_credits, jwt_user_id, db_role)
  VALUES (NEW.id, OLD.bill_credits, NEW.bill_credits, auth.uid(), session_user);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.log_credit_balance() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS log_credit_balance ON public.profiles;
CREATE TRIGGER log_credit_balance
  AFTER UPDATE OF bill_credits ON public.profiles
  FOR EACH ROW WHEN (OLD.bill_credits IS DISTINCT FROM NEW.bill_credits)
  EXECUTE FUNCTION public.log_credit_balance();
