-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — R12: units decided by the server, shares with confirmation
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Nobody pays what they did not pick; sharing is picking the same item.
--
-- The bug (01-11-2026, session f71add73): two Moskow Mule lines shown as one
-- row; A and B tapped at the same time, each phone took "the first free one"
-- from what the others had saved, both took b1 and b2 was left with no owner.
--
-- Units. Every receipt line has `quantity` units (a whole number ≥ 1, else 1).
-- Lines with the same category, name and unit price are one item ("group"),
-- the same rows the selection screen shows. Who holds which unit is
-- session_unit_claims, written only here, under a per-session lock:
--   * an item with one unit: everyone who picks it holds it (shared equally);
--   * an item with several units: a pick takes a free unit; with none free the
--     answer is "full" with who holds them — the person then shares one of
--     those units (share_unit) or asks someone to share (request_share);
--   * nobody is on the same unit as someone else except through a share.
-- session_participants.selections is derived from the claims after every
-- change (derive), so the split, the dashboard and the finalize read the
-- same thing on every device: per line {itemId, quantity (units held),
-- isShared, sharedWith (every holder of my shared units, me included),
-- unitSplits (for each unit I hold, how many hold it)}. A plain write of
-- selections by a client (older apps, the web before this change, the host
-- picking for someone) is turned into claims the same way, and refused with
-- UNITS_TAKEN when it asks for units someone else holds.
--
-- Leaving (left / cancelled / pending / removed) before the finalize releases
-- the person's units and drops the share requests to and from them. After the
-- finalize, whoever leaves stays in the split with their part.
--
-- Share requests (session_share_requests): A says B shared A's unit. Pending
-- until B accepts (B joins the unit) or rejects; the requester or the current
-- host can cancel; the host can remind (reminded_at). Resolved on its own when
-- B already holds that unit (no request at all) or picks it later. After two
-- rejections nobody can ask the same person for the same item again.
--
-- finalize_session (production definition, three changes):
--   * pending share requests → {status: pending_shares, requests: [...]};
--   * an item is unowned while any of its units has no present holder
--     (one line with quantity 2 or two lines of 1: "1 de 2 sem dono"), with
--     units / free_units added to each unowned item;
--   * the sharedWith clean-up is replaced by derive.
-- Sessions not yet finalized are backfilled from their selections.

-- ── Units of a receipt ──────────────────────────────────────────────────────
-- One row per unit; group_key is category | name | unit price.
CREATE OR REPLACE FUNCTION public.receipt_units(p_receipt jsonb)
RETURNS TABLE (item_id text, name text, line_ord bigint, line_units integer, unit_no integer,
               group_key text, line_amount numeric)
LANGUAGE sql IMMUTABLE AS $$
  WITH lines AS (
    SELECT it->>'id' AS item_id,
           coalesce(it->>'name', '') AS name,
           c.k AS cat,
           row_number() OVER (ORDER BY array_position(ARRAY['starters', 'mains', 'drinks', 'desserts', 'others'], c.k), c.k, e.o) AS line_ord,
           CASE WHEN jsonb_typeof(it->'quantity') = 'number'
                     AND (it->>'quantity')::numeric >= 1
                     AND (it->>'quantity')::numeric = trunc((it->>'quantity')::numeric)
                THEN least((it->>'quantity')::numeric, 99)::integer ELSE 1 END AS units,
           CASE WHEN jsonb_typeof(it->'totalPrice') = 'number' THEN (it->>'totalPrice')::numeric ELSE 0 END AS total,
           CASE WHEN jsonb_typeof(it->'unitPrice') = 'number' THEN (it->>'unitPrice')::numeric END AS unit_price,
           coalesce((
             SELECT sum(CASE WHEN jsonb_typeof(a->'totalPrice') = 'number' THEN (a->>'totalPrice')::numeric ELSE 0 END)
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(it->'addOns') = 'array' THEN it->'addOns' ELSE '[]'::jsonb END) a
           ), 0) AS addons
    FROM jsonb_each(CASE WHEN jsonb_typeof(p_receipt->'categories') = 'object' THEN p_receipt->'categories' ELSE '{}'::jsonb END) c(k, v)
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.v) = 'array' THEN c.v ELSE '[]'::jsonb END) WITH ORDINALITY e(it, o)
    WHERE jsonb_typeof(it) = 'object' AND coalesce(it->>'id', '') <> ''
  )
  SELECT l.item_id, l.name, l.line_ord, l.units, g.n,
         l.cat || '|' || lower(btrim(l.name)) || '|' || round(coalesce(l.unit_price, l.total / l.units), 2)::text,
         l.total + l.addons
  FROM lines l
  CROSS JOIN LATERAL generate_series(1, l.units) g(n)
$$;
REVOKE ALL ON FUNCTION public.receipt_units(jsonb) FROM PUBLIC, anon, authenticated;

-- ── Tables ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.session_unit_claims (
  session_id uuid        NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  item_id    text        NOT NULL,
  unit_no    integer     NOT NULL CHECK (unit_no >= 1),
  user_id    uuid        NOT NULL,
  via        text        NOT NULL,   -- pick | share | request | direct | backfill
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_id, item_id, unit_no, user_id)
);
CREATE INDEX IF NOT EXISTS session_unit_claims_user ON public.session_unit_claims (session_id, user_id);
ALTER TABLE public.session_unit_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.session_unit_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.session_unit_claims TO authenticated;
DROP POLICY IF EXISTS session_unit_claims_select ON public.session_unit_claims;
CREATE POLICY session_unit_claims_select ON public.session_unit_claims
  FOR SELECT TO authenticated
  USING (public.is_session_member(session_id) OR public.is_session_host(session_id));

CREATE TABLE IF NOT EXISTS public.session_share_requests (
  id           bigserial   PRIMARY KEY,
  session_id   uuid        NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  item_id      text        NOT NULL,
  unit_no      integer     NOT NULL,
  from_user    uuid        NOT NULL,
  to_user      uuid        NOT NULL,
  status       text        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'dropped')),
  resolved_by  uuid,
  resolved_via text,       -- answer | pick | share | from_cancel | host_cancel | released | left
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  reminded_at  timestamptz,
  dismissed_at timestamptz  -- the requester has seen the rejection (the X goes away)
);
CREATE UNIQUE INDEX IF NOT EXISTS session_share_requests_one_pending
  ON public.session_share_requests (session_id, item_id, unit_no, to_user) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS session_share_requests_session ON public.session_share_requests (session_id, status);
ALTER TABLE public.session_share_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.session_share_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.session_share_requests_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.session_share_requests TO authenticated;
DROP POLICY IF EXISTS session_share_requests_select ON public.session_share_requests;
CREATE POLICY session_share_requests_select ON public.session_share_requests
  FOR SELECT TO authenticated
  USING (public.is_session_member(session_id) OR public.is_session_host(session_id));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'session_share_requests') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.session_share_requests;
  END IF;
END $$;

-- ── Helpers (not callable by clients) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.units_lock(p_session_id uuid)
RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('session_units:' || p_session_id::text, 0))
$$;
REVOKE ALL ON FUNCTION public.units_lock(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.units_is_present(p_session_id uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.session_participants
                 WHERE session_id = p_session_id AND user_id = p_user
                   AND status IN ('joined', 'selecting', 'items_picked'))
$$;
REVOKE ALL ON FUNCTION public.units_is_present(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- One person's selections, derived from the claims.
CREATE OR REPLACE FUNCTION public.units_selections(p_session_id uuid, p_user uuid, p_receipt jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  WITH lines AS (
    SELECT DISTINCT u.item_id, u.line_ord FROM public.receipt_units(p_receipt) u
  ), mine AS (
    SELECT c.item_id, c.unit_no,
           (SELECT count(*) FROM public.session_unit_claims o
            WHERE o.session_id = c.session_id AND o.item_id = c.item_id AND o.unit_no = c.unit_no) AS holders
    FROM public.session_unit_claims c
    WHERE c.session_id = p_session_id AND c.user_id = p_user
  ), per_line AS (
    SELECT m.item_id, count(*) AS qty, bool_or(m.holders > 1) AS shared,
           jsonb_agg(m.holders ORDER BY m.unit_no) AS splits
    FROM mine m GROUP BY m.item_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'itemId', pl.item_id,
           'quantity', pl.qty,
           'isShared', pl.shared,
           'sharedWith', CASE WHEN pl.shared THEN coalesce((
               SELECT jsonb_agg(DISTINCT o.user_id::text ORDER BY o.user_id::text)
               FROM public.session_unit_claims o
               JOIN mine m ON m.item_id = o.item_id AND m.unit_no = o.unit_no AND m.holders > 1
               WHERE o.session_id = p_session_id AND o.item_id = pl.item_id), '[]'::jsonb)
             ELSE '[]'::jsonb END,
           'unitSplits', pl.splits
         ) ORDER BY l.line_ord), '[]'::jsonb)
  FROM per_line pl JOIN lines l ON l.item_id = pl.item_id
$$;
REVOKE ALL ON FUNCTION public.units_selections(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- Rewrites the selections of the present people (except p_skip, whose row
-- the caller is writing itself) wherever they changed.
CREATE OR REPLACE FUNCTION public.units_derive(p_session_id uuid, p_skip uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_receipt jsonb;
  v_n integer;
BEGIN
  SELECT receipt_data INTO v_receipt FROM public.sessions WHERE id = p_session_id;
  PERFORM set_config('app.units_rpc', 'on', true);
  UPDATE public.session_participants sp
  SET selections = x.sel
  FROM (SELECT p.id, public.units_selections(p_session_id, p.user_id, v_receipt) AS sel
        FROM public.session_participants p
        WHERE p.session_id = p_session_id
          AND p.status IN ('joined', 'selecting', 'items_picked')
          AND p.user_id IS DISTINCT FROM p_skip) x
  WHERE sp.id = x.id AND sp.selections IS DISTINCT FROM x.sel;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.units_rpc', '', true);
  RETURN v_n;
END;
$function$;
REVOKE ALL ON FUNCTION public.units_derive(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Who holds units of an item (group), with names, for the "full" answer.
CREATE OR REPLACE FUNCTION public.units_holders(p_session_id uuid, p_receipt jsonb, p_group text, p_except uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', h.user_id, 'name', coalesce(pf.name, ''), 'units', h.n)
                            ORDER BY h.first_at), '[]'::jsonb)
  FROM (SELECT c.user_id, count(*) AS n, min(c.claimed_at) AS first_at
        FROM public.session_unit_claims c
        JOIN public.receipt_units(p_receipt) u ON u.item_id = c.item_id AND u.unit_no = c.unit_no
        WHERE c.session_id = p_session_id AND u.group_key = p_group AND c.user_id IS DISTINCT FROM p_except
        GROUP BY c.user_id) h
  LEFT JOIN public.profiles pf ON pf.id = h.user_id
$$;
REVOKE ALL ON FUNCTION public.units_holders(uuid, jsonb, text, uuid) FROM PUBLIC, anon, authenticated;

-- Sets how many units of an item (group) p_user holds. Fewer: the most
-- recently claimed go first, and the user's pending requests on them are
-- cancelled. More: an item with one unit is joined (shared); otherwise free
-- units in receipt order, never one someone else holds. Touching the item
-- clears the user's seen-rejections on it. Caller holds units_lock.
CREATE OR REPLACE FUNCTION public.units_apply_pick(p_session_id uuid, p_user uuid, p_receipt jsonb,
                                                    p_group text, p_want integer, p_via text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_units  integer;
  v_have   integer;
  v_want   integer;
  v_got    integer := 0;
  v_single boolean;
  r        record;
BEGIN
  SELECT count(*) INTO v_units FROM public.receipt_units(p_receipt) u WHERE u.group_key = p_group;
  IF v_units = 0 THEN
    RAISE EXCEPTION 'ITEM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_single := v_units = 1;
  v_want := greatest(0, least(coalesce(p_want, 0), v_units));

  SELECT count(*) INTO v_have
  FROM public.session_unit_claims c
  JOIN public.receipt_units(p_receipt) u ON u.item_id = c.item_id AND u.unit_no = c.unit_no
  WHERE c.session_id = p_session_id AND c.user_id = p_user AND u.group_key = p_group;

  UPDATE public.session_share_requests q SET dismissed_at = now()
  FROM public.receipt_units(p_receipt) u
  WHERE q.session_id = p_session_id AND q.from_user = p_user AND q.status = 'rejected' AND q.dismissed_at IS NULL
    AND u.item_id = q.item_id AND u.unit_no = q.unit_no AND u.group_key = p_group;

  IF v_want < v_have THEN
    FOR r IN
      SELECT c.item_id, c.unit_no
      FROM public.session_unit_claims c
      JOIN public.receipt_units(p_receipt) u ON u.item_id = c.item_id AND u.unit_no = c.unit_no
      WHERE c.session_id = p_session_id AND c.user_id = p_user AND u.group_key = p_group
      ORDER BY c.claimed_at DESC, u.line_ord DESC, c.unit_no DESC
      LIMIT v_have - v_want
    LOOP
      DELETE FROM public.session_unit_claims
      WHERE session_id = p_session_id AND item_id = r.item_id AND unit_no = r.unit_no AND user_id = p_user;
      UPDATE public.session_share_requests
      SET status = 'cancelled', resolved_at = now(), resolved_by = p_user, resolved_via = 'released'
      WHERE session_id = p_session_id AND item_id = r.item_id AND unit_no = r.unit_no
        AND from_user = p_user AND status = 'pending';
    END LOOP;
  ELSIF v_want > v_have THEN
    FOR r IN
      SELECT u.item_id, u.unit_no
      FROM public.receipt_units(p_receipt) u
      WHERE u.group_key = p_group
        AND NOT EXISTS (SELECT 1 FROM public.session_unit_claims c
                        WHERE c.session_id = p_session_id AND c.item_id = u.item_id AND c.unit_no = u.unit_no
                          AND (NOT v_single OR c.user_id = p_user))
      ORDER BY u.line_ord, u.unit_no
      LIMIT v_want - v_have
    LOOP
      INSERT INTO public.session_unit_claims (session_id, item_id, unit_no, user_id, via)
      VALUES (p_session_id, r.item_id, r.unit_no, p_user, p_via);
      v_got := v_got + 1;
      -- a pending request for this very unit is now answered by the pick
      UPDATE public.session_share_requests
      SET status = 'accepted', resolved_at = now(), resolved_by = p_user, resolved_via = 'pick'
      WHERE session_id = p_session_id AND item_id = r.item_id AND unit_no = r.unit_no
        AND to_user = p_user AND status = 'pending';
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_want > v_have + v_got OR coalesce(p_want, 0) > v_units THEN 'full' ELSE 'ok' END,
    'units', least(v_have, v_want) + v_got,
    'item_units', v_units,
    'free_units', (SELECT count(*) FROM public.receipt_units(p_receipt) u
                   WHERE u.group_key = p_group
                     AND NOT EXISTS (SELECT 1 FROM public.session_unit_claims c
                                     WHERE c.session_id = p_session_id AND c.item_id = u.item_id AND c.unit_no = u.unit_no)),
    'holders', public.units_holders(p_session_id, p_receipt, p_group, p_user));
END;
$function$;
REVOKE ALL ON FUNCTION public.units_apply_pick(uuid, uuid, jsonb, text, integer, text) FROM PUBLIC, anon, authenticated;

-- Locks an open session for a unit change by p_user (who must be present).
CREATE OR REPLACE FUNCTION public.units_open_session(p_session_id uuid, p_user uuid)
RETURNS public.sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  s public.sessions;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'Sign in to pick items' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002';
  END IF;
  IF s.status IN ('awaiting_payment', 'paid', 'closed') THEN
    RAISE EXCEPTION 'SESSION_FINALIZED' USING ERRCODE = '22023',
      HINT = 'The split is already finalized; items can no longer change.';
  END IF;
  IF NOT public.units_is_present(p_session_id, p_user) THEN
    RAISE EXCEPTION 'NOT_IN_SESSION' USING ERRCODE = '42501';
  END IF;
  PERFORM public.units_lock(p_session_id);
  RETURN s;
END;
$function$;
REVOKE ALL ON FUNCTION public.units_open_session(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.units_group_of(p_receipt jsonb, p_item_id text)
RETURNS text LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $function$
DECLARE
  v_group text;
BEGIN
  SELECT u.group_key INTO v_group FROM public.receipt_units(p_receipt) u WHERE u.item_id = p_item_id LIMIT 1;
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'ITEM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_group;
END;
$function$;
REVOKE ALL ON FUNCTION public.units_group_of(jsonb, text) FROM PUBLIC, anon, authenticated;

-- ── pick_units: "I want N units of this item" ───────────────────────────────
-- p_item_id is any line of the item. Answer: {status ok|full, units,
-- item_units, free_units, holders: [{user_id, name, units}], selections}.
CREATE OR REPLACE FUNCTION public.pick_units(p_session_id uuid, p_item_id text, p_units integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid uuid := auth.uid();
  s     public.sessions;
  v_res jsonb;
BEGIN
  s := public.units_open_session(p_session_id, v_uid);
  v_res := public.units_apply_pick(s.id, v_uid, s.receipt_data, public.units_group_of(s.receipt_data, p_item_id),
                                   p_units, 'pick');
  PERFORM public.units_derive(s.id);
  RETURN v_res || jsonb_build_object('selections', public.units_selections(s.id, v_uid, s.receipt_data));
END;
$function$;
REVOKE ALL ON FUNCTION public.pick_units(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pick_units(uuid, text, integer) TO authenticated;

-- ── share_unit: "I shared <holder>'s one" ───────────────────────────────────
-- The caller joins one of p_holder's units of the item (the one with the
-- fewest holders). A pending request from p_holder for it is accepted.
-- Answer: {result shared|already|not_holder, unit, selections}.
CREATE OR REPLACE FUNCTION public.share_unit(p_session_id uuid, p_item_id text, p_holder uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  s       public.sessions;
  v_group text;
  r       record;
BEGIN
  s := public.units_open_session(p_session_id, v_uid);
  v_group := public.units_group_of(s.receipt_data, p_item_id);
  IF p_holder IS NULL OR p_holder = v_uid THEN
    RETURN jsonb_build_object('result', 'not_holder');
  END IF;
  SELECT c.item_id, c.unit_no,
         EXISTS (SELECT 1 FROM public.session_unit_claims m
                 WHERE m.session_id = c.session_id AND m.item_id = c.item_id AND m.unit_no = c.unit_no AND m.user_id = v_uid) AS mine
  INTO r
  FROM public.session_unit_claims c
  JOIN public.receipt_units(s.receipt_data) u ON u.item_id = c.item_id AND u.unit_no = c.unit_no
  WHERE c.session_id = s.id AND c.user_id = p_holder AND u.group_key = v_group
  ORDER BY 3 DESC,
           (SELECT count(*) FROM public.session_unit_claims o
            WHERE o.session_id = c.session_id AND o.item_id = c.item_id AND o.unit_no = c.unit_no),
           u.line_ord, c.unit_no
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_holder');
  END IF;
  IF r.mine THEN
    RETURN jsonb_build_object('result', 'already', 'item_id', r.item_id, 'unit', r.unit_no);
  END IF;
  INSERT INTO public.session_unit_claims (session_id, item_id, unit_no, user_id, via)
  VALUES (s.id, r.item_id, r.unit_no, v_uid, 'share');
  UPDATE public.session_share_requests
  SET status = 'accepted', resolved_at = now(), resolved_by = v_uid, resolved_via = 'share'
  WHERE session_id = s.id AND item_id = r.item_id AND unit_no = r.unit_no AND to_user = v_uid AND status = 'pending';
  PERFORM public.units_derive(s.id);
  RETURN jsonb_build_object('result', 'shared', 'item_id', r.item_id, 'unit', r.unit_no,
                            'selections', public.units_selections(s.id, v_uid, s.receipt_data));
END;
$function$;
REVOKE ALL ON FUNCTION public.share_unit(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.share_unit(uuid, text, uuid) TO authenticated;

-- ── request_share: "<them> shared this with me" ─────────────────────────────
-- The caller must hold a unit of the item (the app picks it first); the
-- request is for that unit. Per person: requested (with has_other_unit when
-- they hold another unit of the item), already (they hold this unit: confirmed,
-- no request), pending, limit (rejected twice for this item), not_present.
CREATE OR REPLACE FUNCTION public.request_share(p_session_id uuid, p_item_id text, p_to uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  s       public.sessions;
  v_group text;
  v_item  text;
  v_unit  integer;
  v_to    uuid;
  v_out   jsonb := '[]'::jsonb;
  v_res   text;
  v_other boolean;
  v_id    bigint;
BEGIN
  s := public.units_open_session(p_session_id, v_uid);
  v_group := public.units_group_of(s.receipt_data, p_item_id);
  SELECT c.item_id, c.unit_no INTO v_item, v_unit
  FROM public.session_unit_claims c
  JOIN public.receipt_units(s.receipt_data) u ON u.item_id = c.item_id AND u.unit_no = c.unit_no
  WHERE c.session_id = s.id AND c.user_id = v_uid AND u.group_key = v_group
  ORDER BY u.line_ord, c.unit_no
  LIMIT 1;
  IF v_item IS NULL THEN
    RAISE EXCEPTION 'PICK_FIRST' USING ERRCODE = '22023',
      HINT = 'Pick the item before asking someone to share it.';
  END IF;

  FOR v_to IN SELECT DISTINCT x FROM unnest(coalesce(p_to, '{}')) x WHERE x IS NOT NULL AND x <> v_uid LOOP
    v_id := NULL;
    v_other := EXISTS (
      SELECT 1 FROM public.session_unit_claims c
      JOIN public.receipt_units(s.receipt_data) u ON u.item_id = c.item_id AND u.unit_no = c.unit_no
      WHERE c.session_id = s.id AND c.user_id = v_to AND u.group_key = v_group
        AND NOT (c.item_id = v_item AND c.unit_no = v_unit));
    IF NOT public.units_is_present(s.id, v_to) THEN
      v_res := 'not_present';
    ELSIF EXISTS (SELECT 1 FROM public.session_unit_claims
                  WHERE session_id = s.id AND item_id = v_item AND unit_no = v_unit AND user_id = v_to) THEN
      v_res := 'already';
    ELSIF EXISTS (SELECT 1 FROM public.session_share_requests
                  WHERE session_id = s.id AND item_id = v_item AND unit_no = v_unit AND to_user = v_to AND status = 'pending') THEN
      v_res := 'pending';
    ELSIF (SELECT count(*) FROM public.session_share_requests q
           JOIN public.receipt_units(s.receipt_data) u ON u.item_id = q.item_id AND u.unit_no = q.unit_no
           WHERE q.session_id = s.id AND q.to_user = v_to AND q.status = 'rejected' AND u.group_key = v_group) >= 2 THEN
      v_res := 'limit';
    ELSE
      INSERT INTO public.session_share_requests (session_id, item_id, unit_no, from_user, to_user)
      VALUES (s.id, v_item, v_unit, v_uid, v_to)
      RETURNING id INTO v_id;
      v_res := 'requested';
    END IF;
    v_out := v_out || jsonb_build_object('user_id', v_to, 'result', v_res, 'request_id', v_id, 'has_other_unit', v_other);
  END LOOP;
  RETURN jsonb_build_object('item_id', v_item, 'unit', v_unit, 'results', v_out);
END;
$function$;
REVOKE ALL ON FUNCTION public.request_share(uuid, text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_share(uuid, text, uuid[]) TO authenticated;

-- ── answer_share: the person asked accepts or rejects ───────────────────────
-- Works after Done too (the status is kept). Accepting joins the requester's
-- unit; if the requester no longer holds it the request is dropped.
-- Answer: {results: [{request_id, result accepted|rejected|dropped|not_pending}]}.
CREATE OR REPLACE FUNCTION public.answer_share(p_session_id uuid, p_request_ids bigint[], p_accept boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid uuid := auth.uid();
  s     public.sessions;
  q     public.session_share_requests;
  v_out jsonb := '[]'::jsonb;
  v_res text;
BEGIN
  s := public.units_open_session(p_session_id, v_uid);
  FOR q IN SELECT * FROM public.session_share_requests
           WHERE session_id = s.id AND id = ANY (coalesce(p_request_ids, '{}')) ORDER BY id FOR UPDATE LOOP
    IF q.to_user <> v_uid OR q.status <> 'pending' THEN
      v_res := 'not_pending';
    ELSIF NOT coalesce(p_accept, false) THEN
      UPDATE public.session_share_requests
      SET status = 'rejected', resolved_at = now(), resolved_by = v_uid, resolved_via = 'answer'
      WHERE id = q.id;
      v_res := 'rejected';
    ELSIF NOT EXISTS (SELECT 1 FROM public.session_unit_claims
                      WHERE session_id = s.id AND item_id = q.item_id AND unit_no = q.unit_no AND user_id = q.from_user) THEN
      UPDATE public.session_share_requests
      SET status = 'dropped', resolved_at = now(), resolved_by = v_uid, resolved_via = 'released'
      WHERE id = q.id;
      v_res := 'dropped';
    ELSE
      INSERT INTO public.session_unit_claims (session_id, item_id, unit_no, user_id, via)
      VALUES (s.id, q.item_id, q.unit_no, v_uid, 'request')
      ON CONFLICT DO NOTHING;
      UPDATE public.session_share_requests
      SET status = 'accepted', resolved_at = now(), resolved_by = v_uid, resolved_via = 'answer'
      WHERE id = q.id;
      v_res := 'accepted';
    END IF;
    v_out := v_out || jsonb_build_object('request_id', q.id, 'result', v_res);
  END LOOP;
  PERFORM public.units_derive(s.id);
  RETURN jsonb_build_object('results', v_out,
                            'selections', public.units_selections(s.id, v_uid, s.receipt_data));
END;
$function$;
REVOKE ALL ON FUNCTION public.answer_share(uuid, bigint[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.answer_share(uuid, bigint[], boolean) TO authenticated;

-- ── The requester or the current host: cancel / remind / dismiss ────────────
-- p_action: cancel (requester or host, pending), remind (host, pending),
-- dismiss (requester, rejected: the X goes away).
-- Answer: {result done|not_allowed|not_pending}.
CREATE OR REPLACE FUNCTION public.manage_share_request(p_request_id bigint, p_action text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  q      public.session_share_requests;
  v_host boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO q FROM public.session_share_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Share request not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.sessions WHERE id = q.session_id FOR UPDATE;
  PERFORM public.units_lock(q.session_id);
  SELECT * INTO q FROM public.session_share_requests WHERE id = p_request_id;
  v_host := EXISTS (SELECT 1 FROM public.sessions WHERE id = q.session_id AND host_id = v_uid);

  IF p_action = 'cancel' THEN
    IF NOT (v_host OR q.from_user = v_uid) THEN RETURN jsonb_build_object('result', 'not_allowed'); END IF;
    IF q.status <> 'pending' THEN RETURN jsonb_build_object('result', 'not_pending', 'status', q.status); END IF;
    UPDATE public.session_share_requests
    SET status = 'cancelled', resolved_at = now(), resolved_by = v_uid,
        resolved_via = CASE WHEN q.from_user = v_uid THEN 'from_cancel' ELSE 'host_cancel' END
    WHERE id = q.id;
  ELSIF p_action = 'remind' THEN
    IF NOT v_host THEN RETURN jsonb_build_object('result', 'not_allowed'); END IF;
    IF q.status <> 'pending' THEN RETURN jsonb_build_object('result', 'not_pending', 'status', q.status); END IF;
    UPDATE public.session_share_requests SET reminded_at = now() WHERE id = q.id;
  ELSIF p_action = 'dismiss' THEN
    IF q.from_user <> v_uid THEN RETURN jsonb_build_object('result', 'not_allowed'); END IF;
    UPDATE public.session_share_requests SET dismissed_at = coalesce(dismissed_at, now()) WHERE id = q.id;
  ELSE
    RAISE EXCEPTION 'Unknown action %', p_action USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('result', 'done');
END;
$function$;
REVOKE ALL ON FUNCTION public.manage_share_request(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_share_request(bigint, text) TO authenticated;

-- ── A plain write of selections becomes claims ──────────────────────────────
-- Writes by the functions above (app.units_rpc = on) and by server jobs pass.
-- Otherwise the wanted units per item are applied as pick_units would, and
-- the row gets the derived selections. Asking for units someone else holds
-- is refused with UNITS_TAKEN (nothing changes).
CREATE OR REPLACE FUNCTION public.units_guard_selections()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_receipt jsonb;
  v_status  text;
  r         record;
  v_res     jsonb;
  v_taken   text[] := '{}';
BEGIN
  IF current_setting('app.units_rpc', true) = 'on' OR auth.uid() IS NULL
     OR NEW.selections IS NOT DISTINCT FROM OLD.selections THEN
    RETURN NEW;
  END IF;
  SELECT receipt_data, status INTO v_receipt, v_status FROM public.sessions WHERE id = NEW.session_id;
  IF v_status IN ('awaiting_payment', 'paid', 'closed') OR v_receipt IS NULL THEN
    RETURN NEW;   -- unchanged behaviour after the finalize (D.3 is separate)
  END IF;
  PERFORM public.units_lock(NEW.session_id);

  FOR r IN
    WITH wanted AS (
      SELECT u.group_key, sum(CASE WHEN jsonb_typeof(e->'quantity') = 'number' THEN greatest((e->>'quantity')::numeric, 1) ELSE 1 END)::integer AS want
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.selections) = 'array' THEN NEW.selections ELSE '[]'::jsonb END) e
      JOIN (SELECT DISTINCT item_id, group_key FROM public.receipt_units(v_receipt)) u ON u.item_id = e->>'itemId'
      GROUP BY u.group_key
    ), held AS (
      SELECT DISTINCT u.group_key
      FROM public.session_unit_claims c
      JOIN public.receipt_units(v_receipt) u ON u.item_id = c.item_id AND u.unit_no = c.unit_no
      WHERE c.session_id = NEW.session_id AND c.user_id = NEW.user_id
    )
    SELECT coalesce(w.group_key, h.group_key) AS group_key, coalesce(w.want, 0) AS want
    FROM wanted w FULL JOIN held h ON h.group_key = w.group_key
    ORDER BY coalesce(w.want, 0)   -- releases first, so a swap inside one write works
  LOOP
    v_res := public.units_apply_pick(NEW.session_id, NEW.user_id, v_receipt, r.group_key, r.want, 'direct');
    IF v_res->>'status' = 'full' THEN
      v_taken := v_taken || split_part(r.group_key, '|', 2);
    END IF;
  END LOOP;
  IF cardinality(v_taken) > 0 THEN
    RAISE EXCEPTION 'UNITS_TAKEN' USING ERRCODE = 'PP409',
      HINT = 'Already picked by someone else: ' || array_to_string(v_taken, ', ');
  END IF;

  NEW.selections := public.units_selections(NEW.session_id, NEW.user_id, v_receipt);
  PERFORM public.units_derive(NEW.session_id, NEW.user_id);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.units_guard_selections() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS units_guard_selections ON public.session_participants;
CREATE TRIGGER units_guard_selections
  BEFORE UPDATE OF selections ON public.session_participants
  FOR EACH ROW EXECUTE FUNCTION public.units_guard_selections();

-- ── Leaving releases the units and drops the requests ───────────────────────
-- Only before the finalize: after it, whoever leaves stays in the split with
-- their part, and their units are not freed.
CREATE OR REPLACE FUNCTION public.units_release_on_leave()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF OLD.status IN ('joined', 'selecting', 'items_picked')
     AND NEW.status NOT IN ('joined', 'selecting', 'items_picked')
     AND NOT EXISTS (SELECT 1 FROM public.sessions
                     WHERE id = NEW.session_id AND status IN ('awaiting_payment', 'paid', 'closed')) THEN
    PERFORM public.units_lock(NEW.session_id);
    DELETE FROM public.session_unit_claims WHERE session_id = NEW.session_id AND user_id = NEW.user_id;
    UPDATE public.session_share_requests
    SET status = 'dropped', resolved_at = now(), resolved_by = auth.uid(), resolved_via = 'left'
    WHERE session_id = NEW.session_id AND status = 'pending' AND NEW.user_id IN (from_user, to_user);
    PERFORM set_config('app.units_rpc', 'on', true);
    UPDATE public.session_participants SET selections = '[]'::jsonb
    WHERE id = NEW.id AND selections IS DISTINCT FROM '[]'::jsonb;
    PERFORM set_config('app.units_rpc', '', true);
    PERFORM public.units_derive(NEW.session_id);
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.units_release_on_leave() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS units_release_on_leave ON public.session_participants;
CREATE TRIGGER units_release_on_leave
  AFTER UPDATE OF status ON public.session_participants
  FOR EACH ROW EXECUTE FUNCTION public.units_release_on_leave();

-- ── finalize_session (production definition + R12) ─────────────────────────
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

-- ── Backfill: sessions not closed ───────────────────────────────────────────
-- Units from the selections already saved, the earliest Done first. A unit
-- asked twice (the 01-11 collision) goes to the next free one. Sessions not
-- yet finalized then get the derived selections on every row (people no
-- longer present: empty); finalized ones keep theirs untouched and only get
-- the units, for a re-finalize after an accepted cancel (R5).
DO $$
DECLARE
  s record;
  p record;
  g record;
  v_res jsonb;
  v_full integer := 0;
  v_sessions integer := 0;
  v_rows integer := 0;
  v_n integer;
BEGIN
  PERFORM set_config('app.units_rpc', 'on', true);
  FOR s IN SELECT id, status, receipt_data FROM public.sessions
           WHERE status <> 'closed' AND receipt_data IS NOT NULL LOOP
    v_sessions := v_sessions + 1;
    FOR p IN SELECT user_id, selections FROM public.session_participants
             WHERE session_id = s.id AND status IN ('joined', 'selecting', 'items_picked')
             ORDER BY picked_at NULLS LAST, joined_at, user_id LOOP
      FOR g IN
        SELECT u.group_key, sum(CASE WHEN jsonb_typeof(e->'quantity') = 'number' THEN greatest((e->>'quantity')::numeric, 1) ELSE 1 END)::integer AS want
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.selections) = 'array' THEN p.selections ELSE '[]'::jsonb END) e
        JOIN (SELECT DISTINCT item_id, group_key FROM public.receipt_units(s.receipt_data)) u ON u.item_id = e->>'itemId'
        GROUP BY u.group_key
      LOOP
        v_res := public.units_apply_pick(s.id, p.user_id, s.receipt_data, g.group_key, g.want, 'backfill');
        IF v_res->>'status' = 'full' THEN v_full := v_full + 1; END IF;
      END LOOP;
    END LOOP;
    IF s.status NOT IN ('awaiting_payment', 'paid') THEN
      UPDATE public.session_participants sp
      SET selections = x.sel
      FROM (SELECT p2.id, CASE WHEN p2.status IN ('joined', 'selecting', 'items_picked')
                               THEN public.units_selections(s.id, p2.user_id, s.receipt_data) ELSE '[]'::jsonb END AS sel
            FROM public.session_participants p2 WHERE p2.session_id = s.id) x
      WHERE sp.id = x.id AND sp.selections IS DISTINCT FROM x.sel;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_rows := v_rows + v_n;
    END IF;
  END LOOP;
  PERFORM set_config('app.units_rpc', '', true);
  RAISE NOTICE 'R12 backfill: % session(s), % selections rewritten, % pick(s) asked for more units than were free',
    v_sessions, v_rows, v_full;
END $$;
