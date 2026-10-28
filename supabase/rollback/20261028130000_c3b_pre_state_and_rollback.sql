-- C.3 follow-up pre-state snapshot and rollback, taken from production 2026-10-28T11:07:35.471Z
-- Pre-state: my_returnable_sessions()  acl {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}  md5 4e059c430bb94138785f6cb393bbd79f
-- (the version from 20261028120000_c3_scan_charge_paid_all.sql). Running this
-- counts the caller's own hosted sessions as returnable again.

BEGIN;

CREATE OR REPLACE FUNCTION public.my_returnable_sessions()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(array_agg(DISTINCT sp.session_id), '{}')
  FROM public.session_participants sp
  JOIN public.sessions s ON s.id = sp.session_id
  WHERE sp.user_id = auth.uid()
    AND s.status <> 'closed'
    AND s.created_at > now() - interval '24 hours'
    AND (
      (sp.status IN ('joined', 'selecting', 'items_picked') AND s.status <> 'awaiting_payment')
      OR (sp.status = 'left' AND EXISTS (
            SELECT 1 FROM public.session_credit_consumptions c
            WHERE c.session_id = sp.session_id AND c.user_id = sp.user_id AND c.refunded_at IS NULL))
    );
$function$;

COMMIT;
