-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — C.2: R1 on the server (credits spent when the split moves on)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- finalize_session(session)  Host-only. The only way into awaiting_payment.
--     Under a row lock on the session:
--       * "present" = participant rows joined / selecting / items_picked
--         (pending, cancelled and left are not present);
--       * an item picked only by people outside the present set (left,
--         pending…) would have no owner and the shares would no longer add
--         up to the bill — nothing changes and the call returns
--         {status: unowned_items, items: [{item_id, name, amount, user_ids, names}]};
--         the host picks them (or the person comes back) and tries again;
--       * every present person without a live consumption row for this
--         session needs ≥ 1 credit or pro — if anyone lacks it nothing
--         changes and the call returns {status: insufficient_credits, user_ids};
--       * each of them spends 1 credit (pro: 0) and gets a live row in
--         session_credit_consumptions — unique (session_id, user_id), so a
--         restarted countdown (finalize → cancel → finalize) never charges
--         anyone twice;
--       * whoever has a live consumption row but is no longer present (left
--         before a re-finalize) gets that credit back: the row is marked
--         refunded_at, so a repeated finalize never refunds twice;
--       * every charge and refund is appended to session_credit_ledger;
--       * sessions.split_user_ids is frozen to the present set (n = its
--         length; every device splits over exactly these people),
--         finalized_at set, status awaiting_payment.
--     A direct client UPDATE of sessions.status to awaiting_payment is
--     refused (guard_session_finalize), so finalizing without paying is not
--     possible. Going back (countdown cancel → selecting) stays a direct write.
--
-- enforce_session_credit() — R3 (C.1) plus:
--     * pending → joined/selecting/items_picked needs a credit (R1: no join
--       at 0 credits);
--     * whoever already spent a credit on this session (live consumption row,
--       not refunded) can come back from left at 0 credits (decision: same
--       exception as R3);
--     * the host on SOMEONE ELSE's row may only do what the app does today
--       (the "select for a disconnected participant" takeover): from joined /
--       selecting / items_picked to selecting / items_picked, selections
--       included. Nothing else — in particular nobody is brought back from
--       pending / cancelled / left by the host.
--
-- set_participant_covered_by — the covered person must have spent their
--     credit on this session already, or have ≥ 1 credit (R1).
--
-- deduct_credit() — no longer called by the app (it charged from the
--     countdown on each device); EXECUTE revoked from authenticated so an old
--     build cannot charge on top of finalize_session.
--
-- Realtime — broadcast/presence topics lobby:<id>, selection:<id>,
--     session-participants:<id>, review-accept:<id> become private channels:
--     only the host or someone with a non-cancelled row in that session may
--     receive or send on them.

-- ── Tables / columns ─────────────────────────────────────────────────────────
CREATE TABLE public.session_credit_consumptions (
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  credits    integer NOT NULL CHECK (credits IN (0, 1)),
  was_pro    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- NULL = the credit is spent on this session; set when it was given back.
  refunded_at timestamptz,
  PRIMARY KEY (session_id, user_id)
);
ALTER TABLE public.session_credit_consumptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.session_credit_consumptions FROM anon, authenticated;
GRANT SELECT ON public.session_credit_consumptions TO authenticated;
CREATE POLICY "Members read the session's consumptions"
  ON public.session_credit_consumptions AS PERMISSIVE FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_session_host(session_id) OR public.is_session_member(session_id));

-- Append-only audit of every charge and refund finalize_session makes.
CREATE TABLE public.session_credit_ledger (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('charge', 'refund')),
  credits    integer NOT NULL CHECK (credits IN (0, 1)),
  was_pro    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_credit_ledger_session_idx ON public.session_credit_ledger (session_id, user_id);
ALTER TABLE public.session_credit_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.session_credit_ledger FROM anon, authenticated;
GRANT SELECT ON public.session_credit_ledger TO authenticated;
CREATE POLICY "Own and host read the credit ledger"
  ON public.session_credit_ledger AS PERMISSIVE FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_session_host(session_id));

-- Server-only columns (B.3's column grants do not include them).
ALTER TABLE public.sessions
  ADD COLUMN finalized_at   timestamptz,
  ADD COLUMN split_user_ids uuid[];

CREATE OR REPLACE FUNCTION public.has_session_consumption(p_session_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.session_credit_consumptions
    WHERE session_id = p_session_id AND user_id = p_user_id AND refunded_at IS NULL
  );
$function$;
REVOKE ALL ON FUNCTION public.has_session_consumption(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_session_consumption(uuid, uuid) TO service_role;

-- ── finalize_session ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finalize_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status   text;
  v_receipt  jsonb;
  v_present  uuid[];
  v_new      uuid[];
  v_gone     uuid[];
  v_lacking  uuid[];
  v_unowned  jsonb;
  v_charged  integer := 0;
  v_refunded integer := 0;
BEGIN
  SELECT status, receipt_data INTO v_status, v_receipt FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_session_host(p_session_id) THEN
    RAISE EXCEPTION 'Only the host can finalize the split' USING ERRCODE = '42501';
  END IF;
  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'Session already closed' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(array_agg(user_id ORDER BY user_id), '{}') INTO v_present
  FROM public.session_participants
  WHERE session_id = p_session_id AND status IN ('joined', 'selecting', 'items_picked');

  IF cardinality(v_present) = 0 THEN
    RAISE EXCEPTION 'Nobody is present in this session' USING ERRCODE = '22023';
  END IF;

  -- Items whose only pickers are outside the present set: nobody in the
  -- split would pay for them (the shares would not add up to the bill).
  WITH items AS (
    SELECT it->>'id' AS item_id,
           it->>'name' AS name,
           (CASE WHEN jsonb_typeof(it->'totalPrice') = 'number' THEN (it->>'totalPrice')::numeric ELSE 0 END)
           + coalesce((
               SELECT sum(CASE WHEN jsonb_typeof(a->'totalPrice') = 'number' THEN (a->>'totalPrice')::numeric ELSE 0 END)
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(it->'addOns') = 'array' THEN it->'addOns' ELSE '[]'::jsonb END) a
             ), 0) AS amount
    FROM jsonb_each(CASE WHEN jsonb_typeof(v_receipt->'categories') = 'object' THEN v_receipt->'categories' ELSE '{}'::jsonb END) c(k, v)
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.v) = 'array' THEN c.v ELSE '[]'::jsonb END) it
  ), picks AS (
    SELECT DISTINCT sp.user_id, s->>'itemId' AS item_id
    FROM public.session_participants sp
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(sp.selections) = 'array' THEN sp.selections ELSE '[]'::jsonb END) s
    WHERE sp.session_id = p_session_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'item_id', i.item_id,
           'name', i.name,
           'amount', round(i.amount, 2),
           'user_ids', (SELECT jsonb_agg(pk.user_id ORDER BY pk.user_id) FROM picks pk WHERE pk.item_id = i.item_id),
           -- the pickers may have left: the host's device no longer lists them
           'names', (SELECT jsonb_agg(coalesce(pf.name, '') ORDER BY pk.user_id)
                     FROM picks pk JOIN public.profiles pf ON pf.id = pk.user_id WHERE pk.item_id = i.item_id)
         ) ORDER BY i.name, i.item_id), '[]'::jsonb)
  INTO v_unowned
  FROM items i
  WHERE EXISTS (SELECT 1 FROM picks pk WHERE pk.item_id = i.item_id AND NOT pk.user_id = ANY (v_present))
    AND NOT EXISTS (SELECT 1 FROM picks pk WHERE pk.item_id = i.item_id AND pk.user_id = ANY (v_present));

  IF jsonb_array_length(v_unowned) > 0 THEN
    RETURN jsonb_build_object('status', 'unowned_items', 'items', v_unowned);
  END IF;

  -- Present people who have not paid for this session (or were refunded),
  -- and people who paid but are no longer present. Their profiles are
  -- locked so a parallel finalize elsewhere cannot spend the same credit.
  SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}') INTO v_new
  FROM public.profiles p
  WHERE p.id = ANY (v_present)
    AND NOT public.has_session_consumption(p_session_id, p.id);
  SELECT coalesce(array_agg(c.user_id ORDER BY c.user_id), '{}') INTO v_gone
  FROM public.session_credit_consumptions c
  WHERE c.session_id = p_session_id AND c.refunded_at IS NULL AND NOT c.user_id = ANY (v_present);
  PERFORM 1 FROM public.profiles WHERE id = ANY (v_new || v_gone) ORDER BY id FOR UPDATE;

  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_lacking
  FROM public.profiles
  WHERE id = ANY (v_new) AND NOT coalesce(is_pro, false) AND coalesce(bill_credits, 0) < 1;

  IF cardinality(v_lacking) > 0 THEN
    RETURN jsonb_build_object('status', 'insufficient_credits', 'user_ids', to_jsonb(v_lacking));
  END IF;

  PERFORM set_config('app.credit_authorized', 'true', true);

  -- Refunds: the credit spent on this session goes back (once — refunded_at).
  WITH refunded AS (
    UPDATE public.session_credit_consumptions
    SET refunded_at = now()
    WHERE session_id = p_session_id AND user_id = ANY (v_gone) AND refunded_at IS NULL
    RETURNING user_id, credits, was_pro
  ), logged AS (
    INSERT INTO public.session_credit_ledger (session_id, user_id, kind, credits, was_pro)
    SELECT p_session_id, user_id, 'refund', credits, was_pro FROM refunded
    RETURNING user_id, credits
  )
  UPDATE public.profiles p
  SET bill_credits = coalesce(p.bill_credits, 0) + 1
  FROM logged l
  WHERE p.id = l.user_id AND l.credits = 1;
  GET DIAGNOSTICS v_refunded = ROW_COUNT;

  -- Charges: 1 credit each (pro: 0), a live consumption row (a refunded one
  -- is reused) and a ledger entry.
  WITH charged AS (
    INSERT INTO public.session_credit_consumptions (session_id, user_id, credits, was_pro)
    SELECT p_session_id, p.id, CASE WHEN coalesce(p.is_pro, false) THEN 0 ELSE 1 END, coalesce(p.is_pro, false)
    FROM public.profiles p WHERE p.id = ANY (v_new)
    ON CONFLICT (session_id, user_id) DO UPDATE
      SET credits = EXCLUDED.credits, was_pro = EXCLUDED.was_pro, created_at = now(), refunded_at = NULL
    RETURNING user_id, credits, was_pro
  ), logged AS (
    INSERT INTO public.session_credit_ledger (session_id, user_id, kind, credits, was_pro)
    SELECT p_session_id, user_id, 'charge', credits, was_pro FROM charged
    RETURNING user_id, credits
  )
  UPDATE public.profiles p
  SET bill_credits = p.bill_credits - 1
  FROM logged l
  WHERE p.id = l.user_id AND l.credits = 1;
  GET DIAGNOSTICS v_charged = ROW_COUNT;

  PERFORM set_config('app.finalize_rpc', 'on', true);
  UPDATE public.sessions
  SET status = 'awaiting_payment', finalized_at = now(), split_user_ids = v_present
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'status', 'finalized',
    'split_user_ids', to_jsonb(v_present),
    'newly_charged', v_charged,
    'already_paid', cardinality(v_present) - cardinality(v_new),
    'refunded', v_refunded,
    'refunded_user_ids', to_jsonb(v_gone)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.finalize_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_session(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_session_finalize()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
     AND NEW.status = 'awaiting_payment'
     AND OLD.status IS DISTINCT FROM 'awaiting_payment'
     AND coalesce(current_setting('app.finalize_rpc', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Use finalize_session() to move a split to awaiting_payment' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_session_finalize() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_session_finalize
  BEFORE UPDATE OF status ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_session_finalize();

-- ── R3 + R1 join check + host transitions ───────────────────────────────────
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
    v_need := TG_OP = 'INSERT' AND NEW.host_id = v_uid;
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

-- Now also on selections-only updates (host writing a left/pending row's selections).
DROP TRIGGER IF EXISTS enforce_participant_credit ON public.session_participants;
CREATE TRIGGER enforce_participant_credit
  BEFORE INSERT OR UPDATE ON public.session_participants
  FOR EACH ROW EXECUTE FUNCTION public.enforce_session_credit();

-- ── covered_by (R1) ──────────────────────────────────────────────────────────
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
    -- R1: the covered person still spends their own credit.
    IF NOT (public.has_session_consumption(p_session_id, p_user_id) OR public.has_session_credit(p_user_id)) THEN
      RAISE EXCEPTION 'NO_CREDITS' USING ERRCODE = 'PP402',
        HINT = 'The covered person has no credit for this session.';
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

-- ── deduct_credit: no client path any more ──────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.deduct_credit() FROM authenticated;

-- ── Realtime authorization (private channels) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.can_use_session_channel(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prefix text := split_part(p_topic, ':', 1);
  v_rest   text := substr(p_topic, length(v_prefix) + 2);
  v_sid    uuid;
BEGIN
  IF auth.uid() IS NULL OR v_prefix NOT IN ('lobby', 'selection', 'session-participants', 'review-accept') THEN
    RETURN false;
  END IF;
  IF v_rest !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  v_sid := v_rest::uuid;
  RETURN public.is_session_host(v_sid) OR EXISTS (
    SELECT 1 FROM public.session_participants
    WHERE session_id = v_sid AND user_id = auth.uid() AND status <> 'cancelled'
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.can_use_session_channel(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_use_session_channel(text) TO authenticated;

CREATE POLICY "Session members receive on session channels"
  ON realtime.messages AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    realtime.messages.extension IN ('broadcast', 'presence')
    AND public.can_use_session_channel(realtime.topic())
  );

CREATE POLICY "Session members send on session channels"
  ON realtime.messages AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    realtime.messages.extension IN ('broadcast', 'presence')
    AND public.can_use_session_channel(realtime.topic())
  );
