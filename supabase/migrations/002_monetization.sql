-- Add monetization columns to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS bill_credits  INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS referred_by   UUID    REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_pro        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pro_expires_at TIMESTAMPTZ;

-- RPC: increment referrer's credits and referral_count when a new user signs up via referral
CREATE OR REPLACE FUNCTION increment_referral_credits(referrer_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles
  SET
    bill_credits   = bill_credits + 1,
    referral_count = referral_count + 1
  WHERE id = referrer_id;
END;
$$;
