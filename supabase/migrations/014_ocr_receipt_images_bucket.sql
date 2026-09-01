-- ─────────────────────────────────────────────────────────────────────────────
-- Pick&Pay — OCR Receipt Images Storage Bucket
-- ─────────────────────────────────────────────────────────────────────────────
-- Private bucket that stores the receipt photos attached to OCR corrections.
-- Authenticated users can upload their own images; service_role reads all
-- (bypasses RLS) for fine-tuning export.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'ocr-receipt-images',
  'ocr-receipt-images',
  false,
  10485760,  -- 10 MB max
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Authenticated users may INSERT under their own uid folder only
CREATE POLICY "Users can upload their own receipt images"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'ocr-receipt-images'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

-- Authenticated users may read their own images (optional — for UI preview)
CREATE POLICY "Users can read their own receipt images"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'ocr-receipt-images'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );
