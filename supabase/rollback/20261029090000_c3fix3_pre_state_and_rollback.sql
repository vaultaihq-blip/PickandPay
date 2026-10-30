-- Rollback for 20261029090000_c3fix3_pairs_host_transfer.sql
--
-- Pre-state (read from production before applying, 2026-10-29):
--   * assign_participant_color(): the C3-fix2 version (host_id gets green,
--     others the first free solid colour, NULL past the 8th) — restored below.
--   * index session_participants_session_color_key
--       ON session_participants (session_id, color) WHERE color IS NOT NULL
--   * expire_countdown_cancel(uuid): EXECUTE to authenticated, service_role.
--   * sessions.host_id: UPDATE granted to authenticated (column grant).
--   * No color2, original_host_id, session_presence, session_host_transfers,
--     session_color_pairs, host_snapshot, session_heartbeat, transfer_host,
--     host_away_tolerance_ms, is_present_status, set_session_original_host.
--
-- Data notes:
--   * host_id changes made by transfer_host stay (they are who is host now);
--     session_host_transfers, the record of them, is dropped. Copy it first if
--     it is wanted.
--   * People with a two-colour circle lose it: their colour goes back to NULL
--     (grey), as before R4b, because the left half of a pair repeats a solid
--     colour and the old index allows each colour once per session.
--
-- Clients: roll the app back first — a build with R6 calls session_heartbeat /
-- transfer_host and reads color2 / original_host_id.

BEGIN;

DROP FUNCTION IF EXISTS public.transfer_host(uuid, uuid);
DROP FUNCTION IF EXISTS public.session_heartbeat(uuid);
DROP FUNCTION IF EXISTS public.host_snapshot(public.sessions);
DROP FUNCTION IF EXISTS public.is_present_status(text);
DROP FUNCTION IF EXISTS public.host_away_tolerance_ms();
DROP TABLE IF EXISTS public.session_host_transfers;
DROP TABLE IF EXISTS public.session_presence;

GRANT UPDATE (host_id) ON public.sessions TO authenticated;

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
REVOKE ALL ON FUNCTION public.expire_countdown_cancel(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expire_countdown_cancel(uuid) TO authenticated;

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

ALTER TABLE public.session_participants DROP CONSTRAINT IF EXISTS session_participants_color_pair_check;
DROP INDEX IF EXISTS public.session_participants_session_colors_key;
ALTER TABLE public.session_participants DISABLE TRIGGER update_participants_updated_at;
UPDATE public.session_participants SET color = NULL WHERE color2 IS NOT NULL;
ALTER TABLE public.session_participants ENABLE TRIGGER update_participants_updated_at;
ALTER TABLE public.session_participants DROP COLUMN IF EXISTS color2;
CREATE UNIQUE INDEX IF NOT EXISTS session_participants_session_color_key
  ON public.session_participants (session_id, color) WHERE color IS NOT NULL;
DROP FUNCTION IF EXISTS public.session_color_pairs();

DROP TRIGGER IF EXISTS set_session_original_host ON public.sessions;
DROP FUNCTION IF EXISTS public.set_session_original_host();
ALTER TABLE public.sessions DROP COLUMN IF EXISTS original_host_id;

-- Remove the migration's row so `supabase db push` would apply it again.
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261029090000';

COMMIT;
