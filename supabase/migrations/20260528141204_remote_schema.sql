drop extension if exists "pg_net";


  create table "public"."profiles" (
    "id" uuid not null,
    "name" text,
    "email" text,
    "phone" text,
    "avatar_url" text,
    "avatar_icon" text,
    "color" text default '#3B82F6'::text,
    "bill_credits" integer default 3,
    "referred_by" uuid,
    "referral_count" integer default 0,
    "is_pro" boolean default false,
    "pro_expires_at" timestamp without time zone,
    "created_at" timestamp without time zone default now(),
    "updated_at" timestamp without time zone default now(),
    "push_token" text
      );


alter table "public"."profiles" enable row level security;


  create table "public"."session_participants" (
    "id" uuid not null default extensions.uuid_generate_v4(),
    "session_id" uuid,
    "user_id" uuid,
    "role" text default 'participant'::text,
    "status" text default 'joined'::text,
    "has_accepted_receipt" boolean default false,
    "has_finalized" boolean default false,
    "selected_items" jsonb default '[]'::jsonb,
    "tip_percentage" numeric,
    "tip_amount" numeric default 0,
    "items_total" numeric default 0,
    "global_costs_share" numeric default 0,
    "total_owed" numeric default 0,
    "covered_by" uuid,
    "covering_users" uuid[],
    "paid" boolean default false,
    "last_active_at" timestamp without time zone default now(),
    "created_at" timestamp without time zone default now(),
    "updated_at" timestamp without time zone default now(),
    "selections" jsonb not null default '[]'::jsonb,
    "confirmed_by_creator" boolean not null default false,
    "joined_at" timestamp with time zone not null default now(),
    "covered_by_user_id" uuid
      );


alter table "public"."session_participants" enable row level security;


  create table "public"."sessions" (
    "id" uuid not null default extensions.uuid_generate_v4(),
    "host_id" uuid,
    "status" text default 'waiting_participants'::text,
    "receipt_data" jsonb,
    "tip_mode" text default 'equal'::text,
    "tip_percentage" numeric,
    "created_at" timestamp without time zone default now(),
    "updated_at" timestamp without time zone default now()
      );


alter table "public"."sessions" enable row level security;


  create table "public"."user_push_tokens" (
    "id" uuid not null default extensions.uuid_generate_v4(),
    "user_id" uuid not null,
    "token" text not null,
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."user_push_tokens" enable row level security;

CREATE INDEX idx_participants_session ON public.session_participants USING btree (session_id);

CREATE INDEX idx_participants_status ON public.session_participants USING btree (status);

CREATE INDEX idx_participants_user ON public.session_participants USING btree (user_id);

CREATE INDEX idx_sessions_host ON public.sessions USING btree (host_id);

CREATE INDEX idx_sessions_status ON public.sessions USING btree (status);

CREATE INDEX idx_user_push_tokens_user_id ON public.user_push_tokens USING btree (user_id);

CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id);

CREATE UNIQUE INDEX session_participants_pkey ON public.session_participants USING btree (id);

CREATE UNIQUE INDEX session_participants_session_user_unique ON public.session_participants USING btree (session_id, user_id);

CREATE UNIQUE INDEX sessions_pkey ON public.sessions USING btree (id);

CREATE UNIQUE INDEX user_push_tokens_pkey ON public.user_push_tokens USING btree (id);

CREATE UNIQUE INDEX user_push_tokens_token_key ON public.user_push_tokens USING btree (token);

alter table "public"."profiles" add constraint "profiles_pkey" PRIMARY KEY using index "profiles_pkey";

alter table "public"."session_participants" add constraint "session_participants_pkey" PRIMARY KEY using index "session_participants_pkey";

alter table "public"."sessions" add constraint "sessions_pkey" PRIMARY KEY using index "sessions_pkey";

alter table "public"."user_push_tokens" add constraint "user_push_tokens_pkey" PRIMARY KEY using index "user_push_tokens_pkey";

alter table "public"."profiles" add constraint "profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."profiles" validate constraint "profiles_id_fkey";

alter table "public"."profiles" add constraint "profiles_referred_by_fkey" FOREIGN KEY (referred_by) REFERENCES public.profiles(id) not valid;

alter table "public"."profiles" validate constraint "profiles_referred_by_fkey";

alter table "public"."session_participants" add constraint "session_participants_covered_by_fkey" FOREIGN KEY (covered_by) REFERENCES public.profiles(id) not valid;

alter table "public"."session_participants" validate constraint "session_participants_covered_by_fkey";

alter table "public"."session_participants" add constraint "session_participants_covered_by_user_id_fkey" FOREIGN KEY (covered_by_user_id) REFERENCES public.profiles(id) not valid;

alter table "public"."session_participants" validate constraint "session_participants_covered_by_user_id_fkey";

alter table "public"."session_participants" add constraint "session_participants_session_id_fkey" FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE not valid;

alter table "public"."session_participants" validate constraint "session_participants_session_id_fkey";

alter table "public"."session_participants" add constraint "session_participants_session_user_unique" UNIQUE using index "session_participants_session_user_unique";

alter table "public"."session_participants" add constraint "session_participants_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE not valid;

alter table "public"."session_participants" validate constraint "session_participants_user_id_fkey";

alter table "public"."sessions" add constraint "sessions_host_id_fkey" FOREIGN KEY (host_id) REFERENCES public.profiles(id) ON DELETE CASCADE not valid;

alter table "public"."sessions" validate constraint "sessions_host_id_fkey";

alter table "public"."user_push_tokens" add constraint "user_push_tokens_token_key" UNIQUE using index "user_push_tokens_token_key";

alter table "public"."user_push_tokens" add constraint "user_push_tokens_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE not valid;

alter table "public"."user_push_tokens" validate constraint "user_push_tokens_user_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.add_user_credits(amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_credits INTEGER;
BEGIN
  IF amount IS NULL OR amount <= 0 OR amount > 50 THEN
    RAISE EXCEPTION 'Invalid credit amount: must be between 1 and 50';
  END IF;

  -- Authorize the credit change for the trigger
  PERFORM set_config('app.credit_authorized', 'true', true);

  UPDATE public.profiles
  SET bill_credits = bill_credits + amount
  WHERE id = auth.uid()
  RETURNING bill_credits INTO v_new_credits;

  RETURN v_new_credits;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.decrement_credits(user_id uuid, amount integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  UPDATE profiles SET bill_credits = GREATEST(bill_credits - amount, 0) WHERE id = user_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.deduct_credit()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_credits    INTEGER;
  v_is_pro     BOOLEAN;
  v_provider   TEXT;
  v_confirmed  TIMESTAMPTZ;
BEGIN
  -- Email verification gate: block disposable/unverified accounts
  SELECT
    raw_app_meta_data->>'provider',
    email_confirmed_at
  INTO v_provider, v_confirmed
  FROM auth.users
  WHERE id = auth.uid();

  IF v_provider NOT IN ('google', 'apple', 'azure', 'facebook', 'twitter')
     AND v_confirmed IS NULL THEN
    RAISE EXCEPTION 'Email not verified' USING ERRCODE = 'P0001';
  END IF;

  SELECT bill_credits, COALESCE(is_pro, FALSE)
  INTO v_credits, v_is_pro
  FROM public.profiles
  WHERE id = auth.uid()
  FOR UPDATE;

  IF v_is_pro THEN RETURN TRUE; END IF;
  IF v_credits IS NULL OR v_credits <= 0 THEN RETURN FALSE; END IF;

  -- Authorize the credit change for the trigger
  PERFORM set_config('app.credit_authorized', 'true', true);

  UPDATE public.profiles
  SET bill_credits = bill_credits - 1
  WHERE id = auth.uid();

  RETURN TRUE;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  provider_name TEXT;
BEGIN
  provider_name := NEW.raw_app_meta_data->>'provider';

  INSERT INTO public.profiles (id, name, email, provider, bill_credits)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email, 'User'),
    NEW.email,
    provider_name,
    3  -- 3 free credits granted on signup
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.increment_credits(user_id uuid, amount integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  UPDATE profiles SET bill_credits = bill_credits + amount WHERE id = user_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_email_verified()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
DECLARE
  v_provider        TEXT;
  v_confirmed_at    TIMESTAMPTZ;
BEGIN
  SELECT
    raw_app_meta_data->>'provider',
    email_confirmed_at
  INTO v_provider, v_confirmed_at
  FROM auth.users
  WHERE id = auth.uid();

  -- Social providers are always pre-verified
  IF v_provider IN ('google', 'apple', 'azure', 'facebook', 'twitter') THEN
    RETURN TRUE;
  END IF;

  RETURN v_confirmed_at IS NOT NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_session_host(p_session_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$

    -- Verifica se o utilizador autenticado
    -- é o host da sessão indicada

    SELECT EXISTS (
      SELECT 1
      FROM sessions
      WHERE id = p_session_id
        AND host_id = auth.uid()
    );

  $function$
;

CREATE OR REPLACE FUNCTION public.is_session_member(p_session_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$

  -- Verifica se existe um registo
  -- na tabela session_participants
  -- onde:
  -- 1. a sessão corresponde ao ID recebido
  -- 2. o utilizador autenticado pertence à sessão

  SELECT EXISTS (
    SELECT 1
    FROM session_participants
    WHERE session_id = p_session_id
      AND user_id = auth.uid()
  );

$function$
;

CREATE OR REPLACE FUNCTION public.process_referral(referrer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_already_referred BOOLEAN;
BEGIN
  SELECT referred_by IS NOT NULL
  INTO v_already_referred
  FROM public.profiles
  WHERE id = auth.uid();

  IF v_already_referred OR auth.uid() = referrer_id THEN
    RETURN;
  END IF;

  -- Mark this user as referred
  UPDATE public.profiles
  SET referred_by = referrer_id
  WHERE id = auth.uid();

  -- Give referrer 1 bonus credit
  PERFORM set_config('app.credit_authorized', 'true', true);
  UPDATE public.profiles
  SET bill_credits     = bill_credits + 1,
      referral_count   = referral_count + 1
  WHERE id = referrer_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_bill_credits()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.bill_credits IS DISTINCT FROM OLD.bill_credits THEN
    -- Allow only if our SECURITY DEFINER function set the session var
    IF current_setting('app.credit_authorized', true) IS DISTINCT FROM 'true' THEN
      NEW.bill_credits := OLD.bill_credits;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;

grant delete on table "public"."profiles" to "anon";

grant insert on table "public"."profiles" to "anon";

grant references on table "public"."profiles" to "anon";

grant select on table "public"."profiles" to "anon";

grant trigger on table "public"."profiles" to "anon";

grant truncate on table "public"."profiles" to "anon";

grant update on table "public"."profiles" to "anon";

grant delete on table "public"."profiles" to "authenticated";

grant insert on table "public"."profiles" to "authenticated";

grant references on table "public"."profiles" to "authenticated";

grant select on table "public"."profiles" to "authenticated";

grant trigger on table "public"."profiles" to "authenticated";

grant truncate on table "public"."profiles" to "authenticated";

grant update on table "public"."profiles" to "authenticated";

grant delete on table "public"."profiles" to "service_role";

grant insert on table "public"."profiles" to "service_role";

grant references on table "public"."profiles" to "service_role";

grant select on table "public"."profiles" to "service_role";

grant trigger on table "public"."profiles" to "service_role";

grant truncate on table "public"."profiles" to "service_role";

grant update on table "public"."profiles" to "service_role";

grant delete on table "public"."session_participants" to "anon";

grant insert on table "public"."session_participants" to "anon";

grant references on table "public"."session_participants" to "anon";

grant select on table "public"."session_participants" to "anon";

grant trigger on table "public"."session_participants" to "anon";

grant truncate on table "public"."session_participants" to "anon";

grant update on table "public"."session_participants" to "anon";

grant delete on table "public"."session_participants" to "authenticated";

grant insert on table "public"."session_participants" to "authenticated";

grant references on table "public"."session_participants" to "authenticated";

grant select on table "public"."session_participants" to "authenticated";

grant trigger on table "public"."session_participants" to "authenticated";

grant truncate on table "public"."session_participants" to "authenticated";

grant update on table "public"."session_participants" to "authenticated";

grant delete on table "public"."session_participants" to "service_role";

grant insert on table "public"."session_participants" to "service_role";

grant references on table "public"."session_participants" to "service_role";

grant select on table "public"."session_participants" to "service_role";

grant trigger on table "public"."session_participants" to "service_role";

grant truncate on table "public"."session_participants" to "service_role";

grant update on table "public"."session_participants" to "service_role";

grant delete on table "public"."sessions" to "anon";

grant insert on table "public"."sessions" to "anon";

grant references on table "public"."sessions" to "anon";

grant select on table "public"."sessions" to "anon";

grant trigger on table "public"."sessions" to "anon";

grant truncate on table "public"."sessions" to "anon";

grant update on table "public"."sessions" to "anon";

grant delete on table "public"."sessions" to "authenticated";

grant insert on table "public"."sessions" to "authenticated";

grant references on table "public"."sessions" to "authenticated";

grant select on table "public"."sessions" to "authenticated";

grant trigger on table "public"."sessions" to "authenticated";

grant truncate on table "public"."sessions" to "authenticated";

grant update on table "public"."sessions" to "authenticated";

grant delete on table "public"."sessions" to "service_role";

grant insert on table "public"."sessions" to "service_role";

grant references on table "public"."sessions" to "service_role";

grant select on table "public"."sessions" to "service_role";

grant trigger on table "public"."sessions" to "service_role";

grant truncate on table "public"."sessions" to "service_role";

grant update on table "public"."sessions" to "service_role";

grant delete on table "public"."user_push_tokens" to "anon";

grant insert on table "public"."user_push_tokens" to "anon";

grant references on table "public"."user_push_tokens" to "anon";

grant select on table "public"."user_push_tokens" to "anon";

grant trigger on table "public"."user_push_tokens" to "anon";

grant truncate on table "public"."user_push_tokens" to "anon";

grant update on table "public"."user_push_tokens" to "anon";

grant delete on table "public"."user_push_tokens" to "authenticated";

grant insert on table "public"."user_push_tokens" to "authenticated";

grant references on table "public"."user_push_tokens" to "authenticated";

grant select on table "public"."user_push_tokens" to "authenticated";

grant trigger on table "public"."user_push_tokens" to "authenticated";

grant truncate on table "public"."user_push_tokens" to "authenticated";

grant update on table "public"."user_push_tokens" to "authenticated";

grant delete on table "public"."user_push_tokens" to "service_role";

grant insert on table "public"."user_push_tokens" to "service_role";

grant references on table "public"."user_push_tokens" to "service_role";

grant select on table "public"."user_push_tokens" to "service_role";

grant trigger on table "public"."user_push_tokens" to "service_role";

grant truncate on table "public"."user_push_tokens" to "service_role";

grant update on table "public"."user_push_tokens" to "service_role";


  create policy "Users can create their own profile"
  on "public"."profiles"
  as permissive
  for insert
  to authenticated
with check ((auth.uid() = id));



  create policy "Users can update own profile"
  on "public"."profiles"
  as permissive
  for update
  to authenticated
using ((auth.uid() = id))
with check ((auth.uid() = id));



  create policy "Users can view any profile"
  on "public"."profiles"
  as permissive
  for select
  to authenticated
using (true);



  create policy "Host can update participants"
  on "public"."session_participants"
  as permissive
  for update
  to authenticated
using (((EXISTS ( SELECT 1
   FROM public.sessions
  WHERE ((sessions.id = session_participants.session_id) AND (sessions.host_id = auth.uid())))) OR (auth.uid() = user_id)));



  create policy "Users can join sessions"
  on "public"."session_participants"
  as permissive
  for insert
  to authenticated
with check ((auth.uid() = user_id));



  create policy "Users can update their participation"
  on "public"."session_participants"
  as permissive
  for update
  to authenticated
using ((auth.uid() = user_id));



  create policy "session_participants_select"
  on "public"."session_participants"
  as permissive
  for select
  to authenticated
using ((public.is_session_member(session_id) OR public.is_session_host(session_id)));



  create policy "Host can update their session"
  on "public"."sessions"
  as permissive
  for update
  to authenticated
using ((auth.uid() = host_id));



  create policy "Users can create sessions"
  on "public"."sessions"
  as permissive
  for insert
  to authenticated
with check ((auth.uid() = host_id));



  create policy "sessions_select"
  on "public"."sessions"
  as permissive
  for select
  to authenticated
using (((host_id = auth.uid()) OR public.is_session_member(id)));


CREATE TRIGGER protect_bill_credits BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.protect_bill_credits();

CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_participants_updated_at BEFORE UPDATE ON public.session_participants FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_sessions_updated_at BEFORE UPDATE ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


  create policy "Public avatars are viewable 1oj01fe_0"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'avatars'::text));



  create policy "Users can delete own avatar 1oj01fe_0"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'avatars'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "Users can update own avatar 1oj01fe_0"
  on "storage"."objects"
  as permissive
  for update
  to authenticated
using (((bucket_id = 'avatars'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "Users can upload own avatar 1oj01fe_0"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check (((bucket_id = 'avatars'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



