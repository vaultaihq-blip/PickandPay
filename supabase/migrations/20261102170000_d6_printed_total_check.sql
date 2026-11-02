-- Pick&Pay — D.6 (part): the server checks that the split adds up to the printed total
--
-- R2 (owner, 01-11-2026): the split always adds up to the printed total. The
-- app checks it in the review; this makes the server refuse to finalize a
-- receipt that does not, so no app (old version, web client, bug) can split
-- less or more than the bill. Measured on production before writing this
-- (2026-11-02): 154 saved receipts, 132 add up, 3 have no printed total, 19
-- do not — all closed, among them the Oligark sessions of 30/10 that split
-- 6.100 of 6.700. No open session would be refused.
--
-- The split divides items + charges (with the answered gap, R2) to the cent,
-- so when that base equals the printed total the shares do too. Checking each
-- person's total_owed needs the app to send it (the rest of D.6).
--
-- Applied in production on 2026-11-02 with the owner's approval; post-verify:
-- the rehearsal's 5 cases, 0 differences.

-- items + charges − printed total, to the cent; NULL without a printed total.
CREATE OR REPLACE FUNCTION public.receipt_printed_gap(r jsonb)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN coalesce((r->'validation'->>'receiptTotal')::numeric, 0) > 0 THEN
      round(
        coalesce((SELECT sum((i->>'totalPrice')::numeric)
                  FROM jsonb_each(CASE WHEN jsonb_typeof(r->'categories') = 'object' THEN r->'categories' ELSE '{}'::jsonb END) c(k, v),
                       jsonb_array_elements(CASE WHEN jsonb_typeof(c.v) = 'array' THEN c.v ELSE '[]'::jsonb END) i), 0)
        + coalesce((SELECT sum((g->>'amount')::numeric)
                    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r->'globalCosts') = 'array' THEN r->'globalCosts' ELSE '[]'::jsonb END) g), 0)
        - (r->'validation'->>'receiptTotal')::numeric, 2)
  END
$function$;
REVOKE ALL ON FUNCTION public.receipt_printed_gap(jsonb) FROM PUBLIC, anon, authenticated;

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
  v_pending  jsonb;
  v_reshared integer := 0;
  v_charged  integer := 0;
  v_refunded integer := 0;
  v_gap      numeric;
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
  PERFORM public.units_lock(p_session_id);

  -- D.6 (R2): the split must add up to the printed total. Refused with the
  -- numbers, before anyone is charged; the host fixes it in the review.
  v_gap := public.receipt_printed_gap(v_receipt);
  IF v_gap IS NOT NULL AND v_gap <> 0 THEN
    RETURN jsonb_build_object('status', 'total_mismatch',
      'printed_total', round((v_receipt->'validation'->>'receiptTotal')::numeric, 2),
      'gap', v_gap);
  END IF;

  SELECT coalesce(array_agg(user_id ORDER BY user_id), '{}') INTO v_present
  FROM public.session_participants
  WHERE session_id = p_session_id AND status IN ('joined', 'selecting', 'items_picked');

  IF cardinality(v_present) = 0 THEN
    RAISE EXCEPTION 'Nobody is present in this session' USING ERRCODE = '22023';
  END IF;

  -- R12: share requests still waiting for an answer.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'request_id', q.id, 'item_id', q.item_id,
           'name', (SELECT u.name FROM public.receipt_units(v_receipt) u WHERE u.item_id = q.item_id LIMIT 1),
           'from_user', q.from_user, 'from_name', coalesce(pf.name, ''),
           'to_user', q.to_user, 'to_name', coalesce(pt.name, '')
         ) ORDER BY q.id), '[]'::jsonb)
  INTO v_pending
  FROM public.session_share_requests q
  LEFT JOIN public.profiles pf ON pf.id = q.from_user
  LEFT JOIN public.profiles pt ON pt.id = q.to_user
  WHERE q.session_id = p_session_id AND q.status = 'pending';
  IF jsonb_array_length(v_pending) > 0 THEN
    RETURN jsonb_build_object('status', 'pending_shares', 'requests', v_pending);
  END IF;

  -- R12: an item is paid for only when every unit has a present holder.
  WITH units AS (
    SELECT u.*,
           EXISTS (SELECT 1 FROM public.session_unit_claims c
                   WHERE c.session_id = p_session_id AND c.item_id = u.item_id AND c.unit_no = u.unit_no
                     AND c.user_id = ANY (v_present)) AS held
    FROM public.receipt_units(v_receipt) u
  ), lines AS (
    SELECT item_id, min(name) AS name, min(line_ord) AS line_ord, max(line_amount) AS amount,
           count(*) AS units, count(*) FILTER (WHERE NOT held) AS free_units
    FROM units GROUP BY item_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'item_id', l.item_id,
           'name', l.name,
           'amount', round(l.amount, 2),
           'units', l.units,
           'free_units', l.free_units,
           'user_ids', '[]'::jsonb, 'names', '[]'::jsonb,
           'missing_user_ids', '[]'::jsonb, 'missing_names', '[]'::jsonb
         ) ORDER BY l.line_ord), '[]'::jsonb)
  INTO v_unowned
  FROM lines l
  WHERE l.amount > 0 AND l.free_units > 0;

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

  -- R12: the selections every device splits from, straight from the units.
  v_reshared := public.units_derive(p_session_id);

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

REVOKE ALL ON FUNCTION public.finalize_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_session(uuid) TO authenticated, service_role;
