-- ─────────────────────────────────────────────────────────────────────────────
-- SplitMate — Initial Database Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Profiles ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  avatar_url  TEXT,
  avatar_icon TEXT DEFAULT 'star',
  color       TEXT NOT NULL DEFAULT '#6366F1',
  provider    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-create profile row when new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, name, email, provider)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email, 'User'),
    NEW.email,
    NEW.raw_app_meta_data->>'provider'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ─── Sessions ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sessions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  creator_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  receipt_data JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','selecting','review','awaiting_payment','paid','closed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_creator_idx ON public.sessions(creator_id);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON public.sessions(status);
CREATE INDEX IF NOT EXISTS sessions_created_idx ON public.sessions(created_at DESC);

-- ─── Session Participants ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.session_participants (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id           UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL,
  selections           JSONB NOT NULL DEFAULT '[]',
  total_owed           NUMERIC(10,2) NOT NULL DEFAULT 0,
  paid                 BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_by_creator BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS participants_session_idx ON public.session_participants(session_id);
CREATE INDEX IF NOT EXISTS participants_user_idx ON public.session_participants(user_id);

-- ─── Receipts ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.receipts (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id     UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
  raw_image_url  TEXT,
  parsed_data    JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS receipts_session_idx ON public.receipts(session_id);

-- ─── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read all profiles, update only their own
CREATE POLICY "Profiles are viewable by all authenticated users"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can insert their own profile"
  ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);

-- Sessions: creators and participants can view, only creators can insert/update
CREATE POLICY "Sessions viewable by participants"
  ON public.sessions FOR SELECT
  TO authenticated
  USING (
    creator_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.session_participants
      WHERE session_id = sessions.id AND user_id = auth.uid()
    )
  );

CREATE POLICY "Authenticated users can create sessions"
  ON public.sessions FOR INSERT
  TO authenticated
  WITH CHECK (creator_id = auth.uid());

CREATE POLICY "Session creators can update their sessions"
  ON public.sessions FOR UPDATE
  TO authenticated
  USING (creator_id = auth.uid());

-- Session participants: viewable by session participants
CREATE POLICY "Participants viewable by session members"
  ON public.session_participants FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.sessions
      WHERE id = session_participants.session_id
        AND creator_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.session_participants sp2
      WHERE sp2.session_id = session_participants.session_id
        AND sp2.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can join sessions"
  ON public.session_participants FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own participation"
  ON public.session_participants FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.sessions
      WHERE id = session_participants.session_id
        AND creator_id = auth.uid()
    )
  );

-- Receipts: viewable by session participants
CREATE POLICY "Receipts viewable by session participants"
  ON public.receipts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = receipts.session_id
        AND (
          s.creator_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.session_participants sp
            WHERE sp.session_id = s.id AND sp.user_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY "Session creators can insert receipts"
  ON public.receipts FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sessions
      WHERE id = receipts.session_id AND creator_id = auth.uid()
    )
  );

-- ─── Realtime ─────────────────────────────────────────────────────────────────

-- Enable Realtime on key tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.session_participants;
