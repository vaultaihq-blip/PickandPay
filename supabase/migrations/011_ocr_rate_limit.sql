-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — OCR Request Rate-Limit Log
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Tracks every OCR request so the parse-receipt Edge Function can enforce a
-- per-user limit of 20 requests per hour before touching OpenAI.
--
-- The Edge Function runs as service_role and manages this table directly.
-- No RLS SELECT policy → authenticated users cannot read or write it.

CREATE TABLE IF NOT EXISTS public.ocr_requests (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index optimized for the rate-limit query: WHERE user_id = $1 AND created_at >= $2
CREATE INDEX IF NOT EXISTS ocr_requests_user_created_idx
  ON public.ocr_requests (user_id, created_at DESC);

ALTER TABLE public.ocr_requests ENABLE ROW LEVEL SECURITY;
-- No policies: managed exclusively by the Edge Function via service_role.
-- RLS blocks all INSERT / SELECT from authenticated / anon roles without an explicit policy.
