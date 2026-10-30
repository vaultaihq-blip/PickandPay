-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — C.3 follow-up: the host's own sessions are not "returnable"
-- ─────────────────────────────────────────────────────────────────────────────
--
-- my_returnable_sessions() (R3 exception: where the caller may scan back in
-- at 0 credits) counted the caller's own sessions as host. A host never comes
-- back through the QR, so an open session they host no longer lets the QR
-- scanner open at 0 credits. Everything else unchanged.

CREATE OR REPLACE FUNCTION public.my_returnable_sessions()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  SELECT coalesce(array_agg(DISTINCT sp.session_id), '{}')
  FROM public.session_participants sp
  JOIN public.sessions s ON s.id = sp.session_id
  WHERE sp.user_id = auth.uid()
    AND sp.role <> 'host'
    AND s.host_id <> auth.uid()
    AND s.status <> 'closed'
    AND s.created_at > now() - interval '24 hours'
    AND (
      (sp.status IN ('joined', 'selecting', 'items_picked') AND s.status <> 'awaiting_payment')
      OR (sp.status = 'left' AND EXISTS (
            SELECT 1 FROM public.session_credit_consumptions c
            WHERE c.session_id = sp.session_id AND c.user_id = sp.user_id AND c.refunded_at IS NULL))
    );
$function$;
