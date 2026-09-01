-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — OCR Corrections Log
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Records every manual correction a user makes to an OCR result.
-- Accumulates training data for GPT-4o fine-tuning.
--
-- correction_type[]  : set of tags describing what was wrong
--   price_wrong      - item price was changed
--   qty_wrong        - item quantity was changed
--   item_name_typo   - item name was edited
--   item_missing     - an OCR item was deleted by the user
--   item_added       - user added an item not detected by OCR
--
-- corrected_items[]  : per-field audit trail
--   { item_id, field, before, after }
--
-- Access pattern:
--   authenticated role  → INSERT own rows only (via RLS)
--   service_role        → full SELECT for fine-tuning export
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ocr_corrections (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           UUID        REFERENCES public.sessions(id) ON DELETE SET NULL,
  user_id              UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  receipt_image_path   TEXT,
  original_ocr_json    JSONB       NOT NULL,
  user_corrected_json  JSONB       NOT NULL,
  correction_type      TEXT[]      NOT NULL DEFAULT '{}',
  corrected_items      JSONB       NOT NULL DEFAULT '[]',
  ocr_passes           INT         NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for per-user queries and time-range exports
CREATE INDEX IF NOT EXISTS ocr_corrections_user_created_idx
  ON public.ocr_corrections (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ocr_corrections_session_idx
  ON public.ocr_corrections (session_id)
  WHERE session_id IS NOT NULL;

-- GIN index lets Postgres search inside correction_type arrays efficiently
CREATE INDEX IF NOT EXISTS ocr_corrections_type_idx
  ON public.ocr_corrections USING GIN (correction_type);

ALTER TABLE public.ocr_corrections ENABLE ROW LEVEL SECURITY;

-- Authenticated users may INSERT only their own rows
CREATE POLICY "Users can log their own corrections"
  ON public.ocr_corrections
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- No SELECT policy for authenticated / anon: only service_role can read all rows
-- (service_role bypasses RLS by default)
