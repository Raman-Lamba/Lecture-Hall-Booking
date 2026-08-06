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
