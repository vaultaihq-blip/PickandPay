-- Rollback for 20261102090000_r12_units_and_shares.sql.
-- Pre-state (production, 2026-11-02): no session_unit_claims or
-- session_share_requests tables; no receipt_units, units_*, pick_units,
-- share_unit, request_share, answer_share or manage_share_request functions;
-- triggers on session_participants: assign_participant_color,
-- enforce_participant_credit, guard_participant_left, log_participant_status,
-- set_participant_picked_at, update_participants_updated_at.
-- finalize_session below is the production definition read before the migration.
-- No session was open with a receipt when this was written, so the backfill
-- rewrote no selections; selections written after the migration keep their
-- format (itemId, quantity, isShared, sharedWith) plus unitSplits, which the
-- old code ignores. Dropping the two tables discards who holds which unit and
-- the share requests.
BEGIN;
DROP TRIGGER IF EXISTS units_guard_selections ON public.session_participants;
DROP TRIGGER IF EXISTS units_release_on_leave ON public.session_participants;
DROP FUNCTION IF EXISTS public.units_guard_selections();
DROP FUNCTION IF EXISTS public.units_release_on_leave();
DROP FUNCTION IF EXISTS public.pick_units(uuid, text, integer);
DROP FUNCTION IF EXISTS public.share_unit(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.request_share(uuid, text, uuid[]);
DROP FUNCTION IF EXISTS public.answer_share(uuid, bigint[], boolean);
DROP FUNCTION IF EXISTS public.manage_share_request(bigint, text);
DROP FUNCTION IF EXISTS public.units_group_of(jsonb, text);
DROP FUNCTION IF EXISTS public.units_open_session(uuid, uuid);
DROP FUNCTION IF EXISTS public.units_apply_pick(uuid, uuid, jsonb, text, integer, text);
DROP FUNCTION IF EXISTS public.units_holders(uuid, jsonb, text, uuid);
DROP FUNCTION IF EXISTS public.units_derive(uuid, uuid);
DROP FUNCTION IF EXISTS public.units_selections(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.units_is_present(uuid, uuid);
DROP FUNCTION IF EXISTS public.units_lock(uuid);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication_tables
             WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'session_share_requests') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.session_share_requests;
  END IF;
END $$;
DROP TABLE IF EXISTS public.session_share_requests;
DROP TABLE IF EXISTS public.session_unit_claims;
DROP FUNCTION IF EXISTS public.receipt_units(jsonb);

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
  v_shareable text[];
  v_reshared integer := 0;
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

  SELECT coalesce(array_agg(it->>'id'), '{}') INTO v_shareable
  FROM jsonb_each(CASE WHEN jsonb_typeof(v_receipt->'categories') = 'object' THEN v_receipt->'categories' ELSE '{}'::jsonb END) c(k, v)
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.v) = 'array' THEN c.v ELSE '[]'::jsonb END) it
  WHERE it->>'type' = 'shareable';

  -- Items nobody in the split would pay for (the shares would not add up
  -- to the bill).
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
  ), raw_picks AS (
    SELECT sp.user_id, s->>'itemId' AS item_id,
           sp.user_id = ANY (v_present) AS present,
           CASE WHEN jsonb_typeof(s->'sharedWith') = 'array' THEN s->'sharedWith' ELSE '[]'::jsonb END AS shared,
           -- a shareable pick whose sharedWith names nobody still present
           (s->>'itemId') = ANY (v_shareable)
             AND jsonb_typeof(s->'sharedWith') = 'array'
             AND jsonb_array_length(s->'sharedWith') > 0
             AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(s->'sharedWith') w WHERE w = ANY (v_present::text[]))
             AS share_gone
    FROM public.session_participants sp
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(sp.selections) = 'array' THEN sp.selections ELSE '[]'::jsonb END) s
    WHERE sp.session_id = p_session_id
  ), picks AS (
    -- owns = this pick makes someone in the split pay a share of the item
    SELECT DISTINCT user_id, item_id, present AND NOT share_gone AS owns, present AND share_gone AS orphan_share
    FROM raw_picks
  ), missing AS (
    -- present people named in a present picker's sharedWith who did not
    -- pick the item themselves
    SELECT DISTINCT rp.item_id, w AS user_id
    FROM raw_picks rp
    CROSS JOIN LATERAL jsonb_array_elements_text(rp.shared) w
    WHERE rp.present AND rp.item_id = ANY (v_shareable) AND w = ANY (v_present::text[])
      AND NOT EXISTS (SELECT 1 FROM raw_picks o WHERE o.item_id = rp.item_id AND o.user_id::text = w)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'item_id', i.item_id,
           'name', i.name,
           'amount', round(i.amount, 2),
           'user_ids', coalesce((SELECT jsonb_agg(pk.user_id ORDER BY pk.user_id) FROM picks pk WHERE pk.item_id = i.item_id AND NOT pk.owns), '[]'::jsonb),
           -- the pickers may have left: the host's device no longer lists them
           'names', coalesce((SELECT jsonb_agg(coalesce(pf.name, '') ORDER BY pk.user_id)
                     FROM picks pk JOIN public.profiles pf ON pf.id = pk.user_id WHERE pk.item_id = i.item_id AND NOT pk.owns), '[]'::jsonb),
           'missing_user_ids', coalesce((SELECT jsonb_agg(ms.user_id ORDER BY ms.user_id) FROM missing ms WHERE ms.item_id = i.item_id), '[]'::jsonb),
           'missing_names', coalesce((SELECT jsonb_agg(coalesce(pf.name, '') ORDER BY ms.user_id)
                     FROM missing ms JOIN public.profiles pf ON pf.id::text = ms.user_id WHERE ms.item_id = i.item_id), '[]'::jsonb)
         ) ORDER BY i.name, i.item_id), '[]'::jsonb)
  INTO v_unowned
  FROM items i
  WHERE i.amount > 0
    AND (NOT EXISTS (SELECT 1 FROM picks pk WHERE pk.item_id = i.item_id AND pk.owns)
         OR EXISTS (SELECT 1 FROM picks pk WHERE pk.item_id = i.item_id AND pk.orphan_share)
         OR EXISTS (SELECT 1 FROM missing ms WHERE ms.item_id = i.item_id));

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

  -- Shareable items: people no longer present leave the sharedWith lists
  -- (never emptied — that case was refused above as unowned).
  UPDATE public.session_participants sp
  SET selections = (
    SELECT jsonb_agg(
             CASE WHEN (e.s->>'itemId') = ANY (v_shareable) AND jsonb_typeof(e.s->'sharedWith') = 'array'
                  THEN jsonb_set(e.s, '{sharedWith}', coalesce((
                         SELECT jsonb_agg(x.w ORDER BY x.o)
                         FROM jsonb_array_elements_text(e.s->'sharedWith') WITH ORDINALITY x(w, o)
                         WHERE x.w = ANY (v_present::text[])), '[]'::jsonb))
                  ELSE e.s END
             ORDER BY e.ord)
    FROM jsonb_array_elements(sp.selections) WITH ORDINALITY e(s, ord))
  WHERE sp.session_id = p_session_id
    AND sp.user_id = ANY (v_present)
    AND jsonb_typeof(sp.selections) = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(sp.selections) s
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(s->'sharedWith') = 'array' THEN s->'sharedWith' ELSE '[]'::jsonb END) w
      WHERE (s->>'itemId') = ANY (v_shareable) AND NOT w = ANY (v_present::text[])
    );
  GET DIAGNOSTICS v_reshared = ROW_COUNT;

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
    'refunded_user_ids', to_jsonb(v_gone),
    'reshared_selections', v_reshared
  );
END;
$function$;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261102090000';
COMMIT;
