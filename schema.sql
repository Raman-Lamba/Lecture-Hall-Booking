-- ============================================
-- Lecture Hall & Classroom Booking System
-- Database Schema (Supabase / Postgres)
-- ============================================

-- Required for overlap exclusion constraint on time ranges
create extension if not exists btree_gist;

-- ============================================
-- 1. ROOMS TABLE
-- ============================================
create table rooms (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,          -- 'LT1', 'CR2', etc.
  type         text not null check (type in ('LT', 'CR')),
  floor        int not null,                  -- 0 = ground, 1 = first, 2 = second
  pos_x        int not null,                  -- left-to-right slot on that floor (for 3D placement)
  capacity     int not null default 60,
  created_at   timestamptz not null default now()
);

-- Seed the 11 rooms exactly per the floor plan:
-- Ground floor: LT1, LT2, LT3, CR1, CR2
-- 1st floor:    LT4, LT5, LT6 (directly above LT1-3)
-- 2nd floor:    LT7, LT8, LT9 (directly above LT4-6)
insert into rooms (name, type, floor, pos_x, capacity) values
  ('LT1', 'LT', 0, 0, 80),
  ('LT2', 'LT', 0, 1, 80),
  ('LT3', 'LT', 0, 2, 80),
  ('CR1', 'CR', 0, 3, 40),
  ('CR2', 'CR', 0, 3, 40),   -- same pos_x as CR1, stacked visually like the sketch
  ('LT4', 'LT', 1, 0, 80),
  ('LT5', 'LT', 1, 1, 80),
  ('LT6', 'LT', 1, 2, 80),
  ('LT7', 'LT', 2, 0, 80),
  ('LT8', 'LT', 2, 1, 80),
  ('LT9', 'LT', 2, 2, 80);

-- ============================================
-- 2. BOOKINGS TABLE
-- ============================================
create table bookings (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references rooms(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  title        text not null,                 -- e.g. "Data Structures Lecture"
  start_time   timestamptz not null,
  end_time     timestamptz not null,
  created_at   timestamptz not null default now(),

  constraint valid_time_range check (end_time > start_time)
);

-- ============================================
-- 3. THE CRITICAL PART: overlap prevention
-- ============================================
-- This constraint makes it IMPOSSIBLE for two bookings on the same room
-- to have overlapping time ranges. The database rejects the second
-- conflicting insert automatically and atomically — no application-level
-- locking or "check then insert" race condition possible.
alter table bookings
  add constraint no_overlapping_bookings
  exclude using gist (
    room_id with =,
    tstzrange(start_time, end_time) with &&
  );

-- ============================================
-- 4. ROW LEVEL SECURITY
-- ============================================
alter table rooms enable row level security;
alter table bookings enable row level security;

-- Anyone logged in can view all rooms
create policy "rooms are viewable by everyone"
  on rooms for select
  to authenticated
  using (true);

-- Anyone logged in can view all bookings (so they see what's taken)
create policy "bookings are viewable by everyone"
  on bookings for select
  to authenticated
  using (true);

-- Users can only create bookings under their own user_id
create policy "users can insert their own bookings"
  on bookings for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Users can only cancel/delete their own bookings
create policy "users can delete their own bookings"
  on bookings for delete
  to authenticated
  using (auth.uid() = user_id);

-- ============================================
-- 5. HELPFUL INDEX for fast availability lookups
-- ============================================
create index idx_bookings_room_time on bookings (room_id, start_time, end_time);

-- ============================================
-- 6. RESTRICT SIGNUP TO THE COLLEGE EMAIL DOMAIN
-- ============================================
-- This is the real enforcement point: the client-side email check in the
-- app can be bypassed by calling the Supabase auth API directly, but this
-- runs as a "Before User Created" Auth Hook, so GoTrue rejects the signup
-- before the auth.users row is even created, regardless of caller.
--
-- After running this, wire it up in the Supabase dashboard:
--   Authentication -> Hooks -> "Before User Created" -> enable ->
--   select Postgres function "public.restrict_signup_domain".
create or replace function public.restrict_signup_domain(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_email text := event->'user'->>'email';
begin
  if user_email is null or user_email !~* '^[^@]+@imthyderabad\.edu\.in$' then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'Only @imthyderabad.edu.in email addresses may register.'
    );
  end if;

  return jsonb_build_object('decision', 'continue');
end;
$$;

grant execute on function public.restrict_signup_domain to supabase_auth_admin;
revoke execute on function public.restrict_signup_domain from authenticated, anon, public;

-- ============================================
-- 7. BOOKER NAME, STAMPED SERVER-SIDE
-- ============================================
-- Signup now collects a full name into auth.users' user_metadata (see
-- app/signup). Rather than trust whatever name the client sends with a
-- booking (easy to spoof from devtools), a trigger looks up the real name
-- from auth.users and overwrites it on every insert.
alter table bookings add column if not exists user_name text not null default '';

create or replace function public.set_booking_user_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select coalesce(nullif(raw_user_meta_data->>'full_name', ''), email)
    into new.user_name
    from auth.users
    where id = new.user_id;
  return new;
end;
$$;

drop trigger if exists trg_set_booking_user_name on bookings;
create trigger trg_set_booking_user_name
  before insert on bookings
  for each row
  execute function public.set_booking_user_name();

-- ============================================
-- 8. REALTIME: broadcast booking changes to every connected client
-- ============================================
-- Without this, the bookings table's INSERT/UPDATE/DELETE events never
-- reach the frontend's postgres_changes subscription, so room colors and
-- the current-bookings list only ever update for the user who made the
-- change (after their own refetch) -- never for anyone else's browser tab.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'bookings'
  ) then
    alter publication supabase_realtime add table bookings;
  end if;
end $$;

-- ============================================
-- 9. SERVER-CLOCK-BASED TIME, NOT THE DEVICE'S CLOCK
-- ============================================
-- A user's laptop clock can be wrong (wrong timezone, drifted, manually
-- set). Filtering "current bookings" or validating "not in the past" with
-- the browser's `new Date()` inherits whatever is wrong with their clock.
-- These two RPCs let the frontend ask Postgres what time it actually is,
-- so both checks are anchored to the server, not the device.
create or replace function public.get_server_time()
returns timestamptz
language sql
stable
as $$
  select now();
$$;

grant execute on function public.get_server_time to authenticated, anon;

create or replace function public.get_current_bookings()
returns setof bookings
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.bookings
  where end_time > now()
  order by start_time asc;
$$;

grant execute on function public.get_current_bookings to authenticated;

-- ============================================
-- 10. PROFILES TABLE + ROLE-BASED ADMIN ACCESS
-- ============================================
-- Every signed-in user gets a profile row with role='member' by default.
-- Regular users have NO write access to this table at all (no insert/
-- update/delete policy is granted to `authenticated`), so becoming an
-- admin is never something a client can trigger -- only a direct SQL
-- statement run by whoever has database access (see README) can do it.
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'member' check (role in ('member', 'admin')),
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

drop policy if exists "users can view their own profile" on profiles;
create policy "users can view their own profile"
  on profiles for select
  to authenticated
  using (auth.uid() = id);

-- Auto-create a profile row for every new signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, role) values (new.id, 'member');
  return new;
end;
$$;

drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- Backfill: anyone who signed up before this migration ran doesn't have a
-- profiles row yet (the trigger above only fires on new inserts). Without
-- this, promoting an existing user to admin later would silently update
-- zero rows.
insert into public.profiles (id, role)
select id, 'member' from auth.users
on conflict (id) do nothing;

-- ============================================
-- 11. ADMIN OVERRIDE SUPPORT ON BOOKINGS
-- ============================================
alter table bookings add column if not exists status text not null default 'active'
  check (status in ('active', 'cancelled'));
alter table bookings add column if not exists last_edited_by uuid references auth.users(id);
alter table bookings add column if not exists last_edited_reason text;
alter table bookings add column if not exists last_edited_at timestamptz;

-- Overlap prevention only applies to still-active bookings, so a
-- soft-cancelled (admin-bumped) booking frees its slot immediately.
alter table bookings drop constraint if exists no_overlapping_bookings;
alter table bookings
  add constraint no_overlapping_bookings
  exclude using gist (
    room_id with =,
    tstzrange(start_time, end_time) with &&
  )
  where (status = 'active');

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select role = 'admin' from public.profiles where id = auth.uid()),
    false
  );
$$;

grant execute on function public.is_admin to authenticated;

drop policy if exists "admins can update any booking" on bookings;
create policy "admins can update any booking"
  on bookings for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================
-- 12. ADMIN EDIT / BUMP RPC
-- ============================================
create or replace function public.admin_edit_booking(
  p_booking_id uuid,
  p_room_id uuid,
  p_title text,
  p_start_time timestamptz,
  p_end_time timestamptz,
  p_reason text,
  p_confirm_bump boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conflicts jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit other bookings';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required';
  end if;

  if p_end_time <= p_start_time then
    raise exception 'End time must be after start time';
  end if;

  select jsonb_agg(jsonb_build_object(
           'id', b.id,
           'title', b.title,
           'user_name', b.user_name,
           'start_time', b.start_time,
           'end_time', b.end_time
         ))
    into v_conflicts
    from public.bookings b
    where b.room_id = p_room_id
      and b.status = 'active'
      and b.id <> p_booking_id
      and tstzrange(b.start_time, b.end_time) && tstzrange(p_start_time, p_end_time);

  if v_conflicts is not null and not p_confirm_bump then
    return jsonb_build_object('status', 'conflict', 'conflicts', v_conflicts);
  end if;

  if v_conflicts is not null then
    update public.bookings
      set status = 'cancelled',
          last_edited_by = auth.uid(),
          last_edited_reason = p_reason,
          last_edited_at = now()
      where room_id = p_room_id
        and status = 'active'
        and id <> p_booking_id
        and tstzrange(start_time, end_time) && tstzrange(p_start_time, p_end_time);
  end if;

  update public.bookings
    set room_id = p_room_id,
        title = p_title,
        start_time = p_start_time,
        end_time = p_end_time,
        last_edited_by = auth.uid(),
        last_edited_reason = p_reason,
        last_edited_at = now()
    where id = p_booking_id;

  if not found then
    raise exception 'Booking not found';
  end if;

  return jsonb_build_object('status', 'ok');
end;
$$;

grant execute on function public.admin_edit_booking to authenticated;

-- ============================================
-- 13. FINAL-REVIEW FIXES
-- ============================================
-- Two follow-ups from the whole-branch review, on top of what sections 11
-- and 12 already set up. Both statements below are idempotent and safe to
-- re-run in the SQL Editor even though sections 11/12 have already been
-- applied to the live database -- nothing here drops a column or table.

-- --------------------------------------------
-- 13a. Close the direct-REST-API bypass around admin_edit_booking's
-- mandatory-reason check.
-- --------------------------------------------
-- The policy added in section 11 let any admin session run a plain
-- `supabase.from("bookings").update(...)` and change a booking (including
-- its status/room/time) without ever going through admin_edit_booking --
-- so the "a reason is required" rule was only enforced by the RPC, not by
-- the database. Tightening `with check` here makes the reason requirement
-- a genuine row-level invariant: ANY update by an admin, through ANY path,
-- must leave a non-empty last_edited_reason, or Postgres rejects it.
-- admin_edit_booking itself is unaffected -- it's `security definer`, so
-- it bypasses RLS (and therefore this policy) entirely either way.
drop policy if exists "admins can update any booking" on bookings;
create policy "admins can update any booking"
  on bookings for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin() and coalesce(btrim(last_edited_reason), '') <> '');

-- --------------------------------------------
-- 13b. admin_edit_booking: verify the confirmed bump set still matches
-- reality before bumping.
-- --------------------------------------------
-- Previously, confirming a bump re-ran the RPC's conflict query from
-- scratch and bumped whatever it found *at that moment* -- not
-- necessarily the same bookings the confirm dialog showed the admin. If a
-- new conflicting booking appeared in the gap between the confirm dialog
-- rendering and the admin clicking "confirm", it would get silently swept
-- into the bump without ever being shown. The whole call is one
-- transaction, so this was never a data-corruption risk, but it broke the
-- confirm dialog's promise to only cancel the bookings it named.
--
-- p_confirmed_conflict_ids is the new, optional parameter: the frontend
-- now passes back the exact set of booking ids it displayed on the
-- confirm step. When that's provided alongside p_confirm_bump = true, the
-- function re-checks that the currently-conflicting active bookings are
-- EXACTLY that set (as sets -- order/duplicates don't matter) before
-- bumping. Any mismatch (a new conflict appeared, or a previously-shown
-- one stopped conflicting) returns a fresh 'conflict' response with the
-- up-to-date list, so the frontend re-shows the confirm step instead of
-- bumping a different set than what was approved.
--
-- When p_confirmed_conflict_ids is null (its default -- used by the
-- initial, non-confirming call, which has no confirmed set to pass yet),
-- behavior is byte-for-byte identical to before: no set comparison, just
-- bump whatever is currently conflicting.
--
-- `create or replace function` cannot add a parameter to an existing
-- function in place -- Postgres identifies functions by their full
-- argument-type signature, so appending p_confirmed_conflict_ids would
-- otherwise create a second, overloaded 8-argument function alongside the
-- original 7-argument one rather than truly replacing it, leaving both
-- installed and risking "function is not unique" errors on calls that
-- omit the new parameter. Dropping the old signature first avoids that.
drop function if exists public.admin_edit_booking(
  uuid, uuid, text, timestamptz, timestamptz, text, boolean
);

create or replace function public.admin_edit_booking(
  p_booking_id uuid,
  p_room_id uuid,
  p_title text,
  p_start_time timestamptz,
  p_end_time timestamptz,
  p_reason text,
  p_confirm_bump boolean default false,
  p_confirmed_conflict_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conflicts jsonb;
  v_conflict_ids uuid[];
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit other bookings';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required';
  end if;

  if p_end_time <= p_start_time then
    raise exception 'End time must be after start time';
  end if;

  select jsonb_agg(jsonb_build_object(
           'id', b.id,
           'title', b.title,
           'user_name', b.user_name,
           'start_time', b.start_time,
           'end_time', b.end_time
         )),
         array_agg(b.id)
    into v_conflicts, v_conflict_ids
    from public.bookings b
    where b.room_id = p_room_id
      and b.status = 'active'
      and b.id <> p_booking_id
      and tstzrange(b.start_time, b.end_time) && tstzrange(p_start_time, p_end_time);

  if v_conflicts is not null and not p_confirm_bump then
    return jsonb_build_object('status', 'conflict', 'conflicts', v_conflicts);
  end if;

  -- Only compare sets when the caller actually supplied a confirmed set
  -- (the initial, non-confirming call never has one to pass yet -- see
  -- comment above).
  if v_conflicts is not null and p_confirm_bump and p_confirmed_conflict_ids is not null then
    if not (
      v_conflict_ids <@ p_confirmed_conflict_ids
      and p_confirmed_conflict_ids <@ v_conflict_ids
    ) then
      return jsonb_build_object('status', 'conflict', 'conflicts', v_conflicts);
    end if;
  end if;

  if v_conflicts is not null then
    update public.bookings
      set status = 'cancelled',
          last_edited_by = auth.uid(),
          last_edited_reason = p_reason,
          last_edited_at = now()
      where room_id = p_room_id
        and status = 'active'
        and id <> p_booking_id
        and tstzrange(start_time, end_time) && tstzrange(p_start_time, p_end_time);
  end if;

  update public.bookings
    set room_id = p_room_id,
        title = p_title,
        start_time = p_start_time,
        end_time = p_end_time,
        last_edited_by = auth.uid(),
        last_edited_reason = p_reason,
        last_edited_at = now()
    where id = p_booking_id;

  if not found then
    raise exception 'Booking not found';
  end if;

  return jsonb_build_object('status', 'ok');
end;
$$;

grant execute on function public.admin_edit_booking(
  uuid, uuid, text, timestamptz, timestamptz, text, boolean, uuid[]
) to authenticated;

-- ============================================
-- 14. ADMIN DIRECT CANCEL + USER-CANCEL LOCK
-- ============================================

-- --------------------------------------------
-- 14a. Lock a user's self-cancel once an admin has touched the booking.
-- --------------------------------------------
-- last_edited_by is set only by admin_edit_booking and (below)
-- admin_cancel_booking -- never by anything else. Once an admin has
-- edited or cancelled a booking, the original owner can no longer
-- hard-delete it themselves, through ANY path (UI, direct REST call,
-- etc.), because this is enforced in the policy's `using` clause, not
-- just by hiding the Cancel button client-side.
drop policy if exists "users can delete their own bookings" on bookings;
create policy "users can delete their own bookings"
  on bookings for delete
  to authenticated
  using (auth.uid() = user_id and last_edited_by is null);
