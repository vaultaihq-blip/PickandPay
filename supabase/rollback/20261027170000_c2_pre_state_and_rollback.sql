-- C.2 pre-state snapshot and rollback, taken from production 2026-10-27T20:55:20.577Z
-- Source: pg_proc / pg_trigger / pg_policies read via `supabase db query --linked`
-- before applying supabase/migrations/20261027170000_c2_r1_credits_on_finalize.sql.
--
-- Pre-C.2 state:
--   enforce_session_credit()  (C.1 version)        acl {postgres=X/postgres,service_role=X/postgres}
--   set_participant_covered_by(uuid,uuid,uuid)  (B)  acl {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   deduct_credit()                                 acl {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   trigger: CREATE TRIGGER enforce_participant_credit BEFORE INSERT OR UPDATE OF status ON public.session_participants FOR EACH ROW EXECUTE FUNCTION enforce_session_credit()
--   no realtime.messages policies; no session_credit_consumptions; no
--   sessions.finalized_at / split_user_ids; no finalize_session,
--   guard_session_finalize, can_use_session_channel, has_session_consumption.
--
-- WARNING: running this drops session_credit_consumptions (the record of who
-- spent a credit on which session) and sessions.finalized_at / split_user_ids.
-- Credits already spent stay spent. The app build with C.2 calls
-- finalize_session and uses private channels; roll back the app too.

BEGIN;

DROP POLICY IF EXISTS "Session members receive on session channels" ON realtime.messages;
DROP POLICY IF EXISTS "Session members send on session channels" ON realtime.messages;
DROP FUNCTION IF EXISTS public.can_use_session_channel(text);

DROP TRIGGER IF EXISTS guard_session_finalize ON public.sessions;
DROP FUNCTION IF EXISTS public.guard_session_finalize();
DROP FUNCTION IF EXISTS public.finalize_session(uuid);

GRANT EXECUTE ON FUNCTION public.deduct_credit() TO authenticated;

-- set_participant_covered_by, B version
CREATE OR REPLACE FUNCTION public.set_participant_covered_by(p_session_id uuid, p_user_id uuid, p_covered_by uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN
    RAISE EXCEPTION 'Only the host can set who covers a share' USING ERRCODE = '42501';
  END IF;
  IF p_covered_by IS NOT NULL THEN
    IF p_covered_by = p_user_id THEN
      RAISE EXCEPTION 'A participant cannot cover themselves' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.session_participants
      WHERE session_id = p_session_id AND user_id = p_covered_by
        AND status NOT IN ('pending', 'cancelled', 'left')
    ) THEN
      RAISE EXCEPTION 'User % is not an active participant of this session', p_covered_by USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.session_participants
  SET covered_by_user_id = p_covered_by
  WHERE session_id = p_session_id AND user_id = p_user_id
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Participant not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_id;
END;
$function$;

-- enforce_session_credit, C.1 version, and its trigger as it was
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
    v_need := TG_OP = 'INSERT' AND NEW.host_id = v_uid;
  ELSIF TG_OP = 'INSERT' THEN
    v_need := NEW.user_id = v_uid AND NEW.role = 'participant';
  ELSE
    v_need := NEW.user_id = v_uid
      AND OLD.status IN ('cancelled', 'left')
      AND NEW.status IN ('pending', 'joined', 'selecting', 'items_picked');
  END IF;

  IF v_need AND NOT public.has_session_credit(v_uid) THEN
    RAISE EXCEPTION 'NO_CREDITS' USING ERRCODE = 'PP402',
      HINT = 'A new session needs at least 1 credit.';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS enforce_participant_credit ON public.session_participants;
CREATE TRIGGER enforce_participant_credit BEFORE INSERT OR UPDATE OF status ON public.session_participants FOR EACH ROW EXECUTE FUNCTION enforce_session_credit();

DROP FUNCTION IF EXISTS public.has_session_consumption(uuid, uuid);
DROP TABLE IF EXISTS public.session_credit_consumptions;
ALTER TABLE public.sessions DROP COLUMN IF EXISTS finalized_at, DROP COLUMN IF EXISTS split_user_ids;

COMMIT;
