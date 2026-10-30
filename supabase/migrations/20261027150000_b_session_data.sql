-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — B: session data the server can vouch for
-- ─────────────────────────────────────────────────────────────────────────────
--
-- B.1  Join "Cancel" sets the participant's own pending row to 'cancelled'
--      (an UPDATE the existing policy already allows) instead of deleting it:
--      Realtime does not deliver DELETE to a subscription filtered by
--      session_id, so the host never saw the cancel (tested: the filtered
--      DELETE never arrived; an unfiltered one arrives with only the row id).
--      No DELETE policy is needed, and clients get no DELETE privilege. A
--      cancelled row is not an active participant anywhere below.
-- B.2  The rounding adjustment (who pays the leftover cents, how many, chosen
--      how) is stored on the session, so every device computes the same split.
--      Until now it lived only in the host's in-memory store.
-- B.3  Column-level grants: clients may only write the columns the app writes.
--      paid / covered_by_user_id go through host-only RPCs; total_owed,
--      confirmed_by_creator, role changes and the other money columns are no
--      longer client-writable at all. A table-level grant covers every column,
--      so the table grant is revoked first and only the listed columns granted.
--      anon loses every write privilege on both tables (it had all of them,
--      TRUNCATE included).
-- B.4  Sign-up credits are granted by handle_new_user when the account is
--      created (the web participant skips profile-setup). The amount is now
--      defined once, inside grant_signup_credits. initialize-user-credits still
--      calls it as a redundant, idempotent path and fills in the HIBP audit.
--
-- Deploy order: this migration, then `supabase functions deploy
-- initialize-user-credits` (it calls the new grant_signup_credits signature).

-- ── B.2 ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.sessions
  ADD COLUMN cent_adjustment_cents   integer,
  ADD COLUMN cent_adjustment_user_id uuid REFERENCES public.profiles(id),
  ADD COLUMN cent_adjustment_method  text
    CHECK (cent_adjustment_method IN ('creator', 'highest', 'roulette'));

-- Host-only. The client computes the leftover (bill total minus the sum of the
-- rounded shares) and picks who pays it; the server checks it is the host, the
-- session is still open, the amount is a rounding leftover (1–10 cents either
-- way, same bound the dashboard uses) and the payer is an active participant.
CREATE OR REPLACE FUNCTION public.set_cent_adjustment(
  p_session_id uuid,
  p_user_id    uuid,
  p_cents      integer,
  p_method     text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN
    RAISE EXCEPTION 'Only the host can assign the rounding difference' USING ERRCODE = '42501';
  END IF;
  IF p_cents IS NULL OR p_cents = 0 OR abs(p_cents) > 10 THEN
    RAISE EXCEPTION 'Rounding difference must be 1–10 cents, got %', p_cents USING ERRCODE = '22023';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('creator', 'highest', 'roulette') THEN
    RAISE EXCEPTION 'Unknown method: %', p_method USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.session_participants
    WHERE session_id = p_session_id AND user_id = p_user_id
      AND status NOT IN ('pending', 'cancelled', 'left')
  ) THEN
    RAISE EXCEPTION 'User % is not an active participant of this session', p_user_id USING ERRCODE = '22023';
  END IF;

  UPDATE public.sessions
  SET cent_adjustment_cents   = p_cents,
      cent_adjustment_user_id = p_user_id,
      cent_adjustment_method  = p_method
  WHERE id = p_session_id AND status <> 'closed'
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Session not found or already closed' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_id;
END;
$function$;

-- ── B.3: sessions ───────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.sessions FROM anon, authenticated;
GRANT INSERT (host_id, receipt_data, status)  ON public.sessions TO authenticated;
GRANT UPDATE (host_id, receipt_data, status)  ON public.sessions TO authenticated;

-- ── B.3: session_participants ───────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.session_participants FROM anon, authenticated;
GRANT INSERT (session_id, user_id, role, status) ON public.session_participants TO authenticated;
GRANT UPDATE (status, selections)                ON public.session_participants TO authenticated;

-- A participant joins as pending; only the session's host inserts a host row.
DROP POLICY IF EXISTS "Users can join sessions" ON public.session_participants;
CREATE POLICY "Users can join sessions"
  ON public.session_participants
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND (
      (role = 'participant' AND status = 'pending')
      OR (role = 'host' AND status = 'joined' AND public.is_session_host(session_id))
    )
  );

-- Host-only writes of the money columns. Both return the participant row id,
-- so the client's expectRows sees one affected row.
CREATE OR REPLACE FUNCTION public.set_participant_paid(
  p_session_id uuid,
  p_user_id    uuid,
  p_paid       boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_session_host(p_session_id) THEN
    RAISE EXCEPTION 'Only the host can mark payments' USING ERRCODE = '42501';
  END IF;

  UPDATE public.session_participants
  SET paid = coalesce(p_paid, false)
  WHERE session_id = p_session_id AND user_id = p_user_id
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Participant not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_id;
END;
$function$;

-- The R1 rule "the covered person must have credits" is added in C, with the
-- server-side credit checks; this only enforces who may write and with what.
CREATE OR REPLACE FUNCTION public.set_participant_covered_by(
  p_session_id uuid,
  p_user_id    uuid,
  p_covered_by uuid
)
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

REVOKE ALL ON FUNCTION public.set_cent_adjustment(uuid, uuid, integer, text)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_participant_paid(uuid, uuid, boolean)             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_participant_covered_by(uuid, uuid, uuid)          FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_cent_adjustment(uuid, uuid, integer, text)     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_participant_paid(uuid, uuid, boolean)          TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_participant_covered_by(uuid, uuid, uuid)       TO authenticated, service_role;

-- ── B.4: sign-up credits at account creation ────────────────────────────────
-- The amount lives here and nowhere else. The HIBP fields are NULL when the
-- trigger grants (no network access from the database); the edge function
-- fills them on its later, redundant call.
DROP FUNCTION IF EXISTS public.grant_signup_credits(uuid, integer, text, boolean, boolean, integer);

CREATE OR REPLACE FUNCTION public.grant_signup_credits(
  p_user_id        uuid,
  p_email          text,
  p_in_breaches    boolean,
  p_is_established boolean,
  p_hibp_status    integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c_signup_credits CONSTANT integer := 3;  -- the sign-up amount: change it here only
  v_balance integer;
  v_granted integer;
BEGIN
  INSERT INTO public.email_signup_audit (user_id, email, in_breaches, is_established, free_credits_granted, hibp_status)
  VALUES (p_user_id, coalesce(p_email, ''), p_in_breaches, coalesce(p_is_established, false), c_signup_credits, p_hibp_status)
  ON CONFLICT (user_id) DO NOTHING;

  IF NOT FOUND THEN
    -- Already granted. Fill in the HIBP result once, if this call brings it.
    IF p_hibp_status IS NOT NULL THEN
      UPDATE public.email_signup_audit
      SET in_breaches = p_in_breaches,
          is_established = coalesce(p_is_established, is_established),
          hibp_status = p_hibp_status
      WHERE user_id = p_user_id AND hibp_status IS NULL;
    END IF;
    SELECT free_credits_granted INTO v_granted FROM public.email_signup_audit WHERE user_id = p_user_id;
    SELECT bill_credits INTO v_balance FROM public.profiles WHERE id = p_user_id;
    RETURN jsonb_build_object('status', 'already_granted', 'credits_granted', v_granted, 'balance', v_balance);
  END IF;

  PERFORM set_config('app.credit_authorized', 'true', true);

  UPDATE public.profiles
  SET bill_credits = bill_credits + c_signup_credits
  WHERE id = p_user_id
  RETURNING bill_credits INTO v_balance;

  PERFORM set_config('app.credit_authorized', 'false', true);

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'User not found: %', p_user_id USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object('status', 'granted', 'credits_granted', c_signup_credits, 'balance', v_balance);
END;
$function$;

REVOKE ALL ON FUNCTION public.grant_signup_credits(uuid, text, boolean, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_signup_credits(uuid, text, boolean, boolean, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, name, email, bill_credits)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email, 'User'),
    NEW.email,
    0
  )
  ON CONFLICT (id) DO NOTHING;

  -- Sign-up credits. A failure here must not block account creation:
  -- initialize-user-credits (called from profile-setup) retries idempotently.
  BEGIN
    PERFORM public.grant_signup_credits(NEW.id, NEW.email, NULL, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_user: sign-up credits not granted for %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;
