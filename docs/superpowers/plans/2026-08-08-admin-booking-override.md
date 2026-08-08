# Admin Booking Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a small set of admin users (identified via a `profiles.role` column) edit or bump-and-reschedule any member's booking, with a mandatory reason that stays visible on the Current Bookings list.

**Architecture:** A `profiles` table (auto-populated per signup via trigger, read-only to regular users via RLS) drives an `is_admin()` Postgres function. A single `security definer` RPC, `admin_edit_booking`, atomically edits a booking and — if the new room/time overlaps another active booking — soft-cancels ("bumps") that conflicting booking in the same transaction, after the caller confirms. `bookings` gains `status`/`last_edited_*` columns so both the edited and bumped bookings show their reason inline in the existing Current Bookings list. Frontend: a new `AdminEditBookingModal` component (sibling to the existing `BookingModal`) and small additions to `CurrentBookings` and the dashboard page.

**Tech Stack:** Next.js 14 (App Router) + React 18 + Supabase (Postgres, Auth, Realtime, RLS) + Tailwind CSS. No test runner exists in this repo (no Jest/Vitest/Playwright, confirmed by search) — verification is manual (Supabase SQL Editor + browser), matching how the rest of this codebase is validated today. Each frontend task still runs `npx tsc --noEmit` as an automated correctness gate.

## Global Constraints

- Admin identity comes from `profiles.role` ('member' | 'admin'), never a hardcoded list — see `docs/superpowers/specs/2026-08-08-admin-booking-override-design.md`.
- Regular (non-admin) users must have **no RLS write path** to `profiles.role` at all — not even to their own row. Promotion to admin only happens via a manual SQL statement run directly against the database.
- Every admin edit or bump requires a non-empty `reason`, enforced server-side inside `admin_edit_booking` (not just in the UI).
- Bumping a conflicting booking soft-cancels it (`status = 'cancelled'`) — it is never hard-deleted, and it keeps showing in Current Bookings (struck through, with the reason) until its original `end_time` passes.
- Only the *latest* edit's reason/admin/timestamp is kept per booking — no separate audit-history table.
- Regular members' own booking flows (create, self-cancel) are unchanged. Editing is admin-only; there is no self-edit feature.
- No notifications (email/push) and no in-app admin-management UI are in scope.

## File Structure

- **Modify `schema.sql`**: append three new sections — (10) `profiles` table + trigger + RLS + backfill, (11) `bookings` status/audit columns + partial exclusion constraint + `is_admin()` + admin update RLS policy, (12) the `admin_edit_booking` RPC. Follows the file's existing convention of numbered, idempotent, additive sections (see sections 6–9).
- **Modify `types/index.ts`**: extend `Booking` with `status`/`last_edited_*`; add a new `Profile` interface.
- **Modify `components/CurrentBookings.tsx`**: render cancelled/rescheduled state on each booking row; add an admin-only Edit button.
- **Create `components/AdminEditBookingModal.tsx`**: the admin edit/bump form, sibling to `BookingModal.tsx`, reusing `lib/time.ts`'s `computeBookingRange`.
- **Modify `app/dashboard/page.tsx`**: detect whether the signed-in user is an admin, own the "which booking is being admin-edited" state, render `AdminEditBookingModal`.

---

### Task 1: Database — `profiles` table, auto-provisioning, and lockdown RLS

**Files:**
- Modify: `schema.sql` (append after section 9, at the end of the file)

**Interfaces:**
- Produces: table `public.profiles(id uuid primary key, role text, created_at timestamptz)`, values of `role` are `'member'` or `'admin'`.

- [ ] **Step 1: Append the new section to `schema.sql`**

Add this at the end of the file, after section 9:

```sql
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
```

- [ ] **Step 2: Run it against Supabase**

Open your Supabase project → SQL Editor → paste just the new section 10 block above (not the whole file, to avoid re-running sections 1–9 against a database that already has them) → Run.

- [ ] **Step 3: Verify the table, trigger, and backfill**

In the SQL Editor, run:

```sql
select id, role from profiles;
```

Expected: one row per existing `auth.users` row, all with `role = 'member'`.

```sql
select policyname, cmd from pg_policies where tablename = 'profiles';
```

Expected: exactly one row — `users can view their own profile`, `cmd = 'SELECT'`. No insert/update/delete policy exists.

- [ ] **Step 4: Verify a new signup gets a profile automatically**

Sign up a new test user through the app (`npm run dev` → `/signup`, or via Supabase Auth → Users → "Add user" in the dashboard). Then in the SQL Editor:

```sql
select role from profiles where id = (select id from auth.users where email = '<the test email you just used>');
```

Expected: one row, `role = 'member'`.

- [ ] **Step 5: Verify a non-admin cannot write their own role**

With the app running and that test user logged in, open the browser devtools console on the dashboard page and run:

```js
const { data: { user } } = await supabase.auth.getUser();
const { data, error } = await supabase.from('profiles').update({ role: 'admin' }).eq('id', user.id).select();
console.log({ data, error });
```

Expected: `data` is an empty array (`[]`) and `error` is `null` — RLS silently matches zero rows for the update since no policy grants it, rather than throwing a permission error. Confirm with the SQL Editor query from Step 4 that the role is still `'member'`.

- [ ] **Step 6: Commit**

```bash
git add schema.sql
git commit -m "Add profiles table with lockdown RLS for admin role"
```

---

### Task 2: Database — `bookings` status/audit columns, partial exclusion constraint, `is_admin()`

**Files:**
- Modify: `schema.sql` (append after Task 1's section 10)

**Interfaces:**
- Consumes: `public.profiles` (Task 1).
- Produces: `bookings.status`, `bookings.last_edited_by`, `bookings.last_edited_reason`, `bookings.last_edited_at`; function `public.is_admin() returns boolean`.

- [ ] **Step 1: Append the new section to `schema.sql`**

```sql
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
```

- [ ] **Step 2: Run it against Supabase**

Paste just this new section 11 block into the SQL Editor and run it.

- [ ] **Step 3: Verify the columns exist**

```sql
select column_name from information_schema.columns
where table_name = 'bookings'
  and column_name in ('status', 'last_edited_by', 'last_edited_reason', 'last_edited_at')
order by column_name;
```

Expected: 4 rows.

- [ ] **Step 4: Verify the constraint is now partial**

```sql
select pg_get_constraintdef(oid) from pg_constraint where conname = 'no_overlapping_bookings';
```

Expected: the definition string ends with `WHERE (status = 'active')`.

- [ ] **Step 5: Verify `is_admin()` runs without error**

```sql
select is_admin();
```

Expected: returns `false` (no error) — running as the SQL Editor's `postgres` role, `auth.uid()` is `null`, so it falls through the `coalesce` to `false`. This confirms the function compiles and executes cleanly; it isn't a check that the security logic is correct — that's confirmed by end-to-end testing in Task 5–7.

- [ ] **Step 6: Commit**

```bash
git add schema.sql
git commit -m "Add bookings status/audit columns, partial exclusion constraint, is_admin()"
```

---

### Task 3: Database — `admin_edit_booking` RPC

**Files:**
- Modify: `schema.sql` (append after Task 2's section 11)

**Interfaces:**
- Consumes: `public.is_admin()` (Task 2), `bookings.status`/`last_edited_*` (Task 2).
- Produces: RPC `public.admin_edit_booking(p_booking_id uuid, p_room_id uuid, p_title text, p_start_time timestamptz, p_end_time timestamptz, p_reason text, p_confirm_bump boolean default false) returns jsonb`. Return shape: `{"status": "conflict", "conflicts": [{"id", "title", "user_name", "start_time", "end_time"}, ...]}` or `{"status": "ok"}`.

- [ ] **Step 1: Append the new section to `schema.sql`**

```sql
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

  return jsonb_build_object('status', 'ok');
end;
$$;

grant execute on function public.admin_edit_booking to authenticated;
```

- [ ] **Step 2: Run it against Supabase**

Paste just this new section 12 block into the SQL Editor and run it.

- [ ] **Step 3: Verify the admin guard fires before touching any table**

```sql
select public.admin_edit_booking(
  '00000000-0000-0000-0000-000000000000'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'smoke test',
  now(),
  now() + interval '1 hour',
  'smoke test reason'
);
```

Expected: an error — `Only admins can edit other bookings` (running as the SQL Editor's `postgres` role, `is_admin()` returns `false` since `auth.uid()` is `null`). Both UUIDs are fake and it still errors on the admin check first, confirming the guard runs before any lookup. Full functional testing (real conflicts, real bumps) happens end-to-end once the UI exists, in Tasks 5–7.

- [ ] **Step 4: Commit**

```bash
git add schema.sql
git commit -m "Add admin_edit_booking RPC for atomic edit-or-bump"
```

---

### Task 4: Frontend types + Current Bookings status/reason display

**Files:**
- Modify: `types/index.ts`
- Modify: `components/CurrentBookings.tsx`

**Interfaces:**
- Consumes: `bookings.status`/`last_edited_*` columns (Task 2).
- Produces: `Booking` type now includes `status: "active" | "cancelled"`, `last_edited_by: string | null`, `last_edited_reason: string | null`, `last_edited_at: string | null`. This is what Task 5/6's modal and the dashboard page will read/write.

- [ ] **Step 1: Extend the `Booking` type**

In `types/index.ts`, replace the `Booking` interface:

```ts
export interface Booking {
  id: string;
  room_id: string;
  user_id: string;
  user_name: string;
  title: string;
  start_time: string; // ISO timestamp
  end_time: string; // ISO timestamp
  created_at: string;
  status: "active" | "cancelled";
  last_edited_by: string | null;
  last_edited_reason: string | null;
  last_edited_at: string | null;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (the existing `data as Booking[]` casts in `app/dashboard/page.tsx` remain valid since they're type assertions, not structural literal checks).

- [ ] **Step 3: Render cancelled/rescheduled state in `CurrentBookings.tsx`**

Replace the `<li>` block inside the `sorted.map(...)` in `components/CurrentBookings.tsx`:

```tsx
{sorted.map((b) => {
  const cancelled = b.status === "cancelled";
  return (
    <li
      key={b.id}
      className={`flex items-center justify-between border border-ink/20 px-3 py-2 ${
        cancelled ? "opacity-60" : ""
      }`}
    >
      <div>
        <p
          className={`font-mono font-medium text-sm ${
            cancelled ? "line-through" : ""
          }`}
        >
          {roomName(b.room_id)} — {b.title}
        </p>
        <p className="text-xs text-ink/60">{formatRange(b)}</p>
        <p className="text-xs text-ink/60">Booked by {b.user_name}</p>
        {cancelled && (
          <p className="text-xs text-booked font-mono mt-1">
            CANCELLED BY ADMIN — Reason: &quot;{b.last_edited_reason}&quot;
          </p>
        )}
        {!cancelled && b.last_edited_reason && (
          <p className="text-xs text-blueprint font-mono mt-1">
            Rescheduled by admin — &quot;{b.last_edited_reason}&quot;
          </p>
        )}
      </div>
      {!cancelled && b.user_id === currentUserId && (
        <button
          onClick={() => cancelBooking(b.id)}
          disabled={cancelingId === b.id}
          className="text-xs font-mono text-booked border border-booked px-2 py-1 hover:bg-booked hover:text-paper disabled:opacity-50"
        >
          {cancelingId === b.id ? "..." : "Cancel"}
        </button>
      )}
    </li>
  );
})}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify visually**

Make sure Tasks 1–3's SQL has been run against your Supabase project. Start the app (`npm run dev`), log in, note an existing booking's `id` (visible in Current Bookings, or query `select id, title from bookings limit 5;`). In the SQL Editor:

```sql
update bookings set status = 'cancelled', last_edited_reason = 'QA test reason' where id = '<that id>';
```

Reload the dashboard. Expected: that booking shows struck through, at reduced opacity, with the line `CANCELLED BY ADMIN — Reason: "QA test reason"`. No Cancel button appears on it even if you own it.

Then revert so later tasks start clean:

```sql
update bookings set status = 'active', last_edited_reason = null where id = '<that id>';
```

- [ ] **Step 6: Commit**

```bash
git add types/index.ts components/CurrentBookings.tsx
git commit -m "Render cancelled/rescheduled booking state in Current Bookings"
```

---

### Task 5: Admin role detection + `AdminEditBookingModal` (edit step) + Edit button

**Files:**
- Modify: `types/index.ts`
- Modify: `app/dashboard/page.tsx`
- Modify: `components/CurrentBookings.tsx`
- Create: `components/AdminEditBookingModal.tsx`

**Interfaces:**
- Consumes: `public.profiles` (Task 1), RPC `admin_edit_booking` (Task 3), `Booking`/`Room` types (Task 4 / existing).
- Produces: `Profile` type; `CurrentBookings` gains `isAdmin: boolean` and `onEditRequest: (booking: Booking) => void` props; `AdminEditBookingModal` component with props `{ booking: Booking; rooms: Room[]; onClose: () => void; onSaved: () => void }`.

- [ ] **Step 1: Add the `Profile` type**

In `types/index.ts`, add:

```ts
export interface Profile {
  id: string;
  role: "member" | "admin";
}
```

- [ ] **Step 2: Create `components/AdminEditBookingModal.tsx`**

```tsx
"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { computeBookingRange } from "@/lib/time";
import type { Booking, Room } from "@/types";

interface AdminEditBookingModalProps {
  booking: Booking;
  rooms: Room[];
  onClose: () => void;
  onSaved: () => void;
}

function dateStrFromISO(iso: string) {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function timeStrFromISO(iso: string) {
  return new Date(iso).toTimeString().slice(0, 5);
}

export default function AdminEditBookingModal({
  booking,
  rooms,
  onClose,
  onSaved,
}: AdminEditBookingModalProps) {
  const [roomId, setRoomId] = useState(booking.room_id);
  const [title, setTitle] = useState(booking.title);
  const [date, setDate] = useState(dateStrFromISO(booking.start_time));
  const [startTime, setStartTime] = useState(timeStrFromISO(booking.start_time));
  const [endTime, setEndTime] = useState(timeStrFromISO(booking.end_time));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }
    if (startTime === endTime) {
      setError("End time must be after start time.");
      return;
    }

    const { startISO, endISO } = computeBookingRange(date, startTime, endTime);

    setLoading(true);
    const { data, error: rpcError } = await supabase.rpc("admin_edit_booking", {
      p_booking_id: booking.id,
      p_room_id: roomId,
      p_title: title.trim() || booking.title,
      p_start_time: startISO,
      p_end_time: endISO,
      p_reason: reason.trim(),
      p_confirm_bump: false,
    });
    setLoading(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    if (data?.status === "conflict") {
      const names = (data.conflicts as { title: string; user_name: string }[])
        .map((c: { title: string; user_name: string }) => `"${c.title}" (${c.user_name})`)
        .join(", ");
      setError(
        `${rooms.find((r) => r.id === roomId)?.name ?? "That room"} is already booked for part of that window by ${names}. Cancel that booking first, then retry.`
      );
      return;
    }

    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-ink/50 flex items-center justify-center z-50 px-4">
      <div className="blueprint-card w-full max-w-md p-6">
        <p className="font-mono text-xs tracking-widest text-blueprint mb-1">
          ADMIN EDIT
        </p>
        <h2 className="font-mono text-xl font-semibold mb-5">{booking.title}</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Room</label>
            <select
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              className="blueprint-input w-full px-3 py-2"
            >
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Purpose / title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="blueprint-input w-full px-3 py-2"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Date</label>
            <input
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="blueprint-input w-full px-3 py-2"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">
                Start time
              </label>
              <input
                type="time"
                required
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="blueprint-input w-full px-3 py-2"
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">
                End time
              </label>
              <input
                type="time"
                required
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="blueprint-input w-full px-3 py-2"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Reason (required)
            </label>
            <input
              type="text"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Dean's meeting needs this room"
              className="blueprint-input w-full px-3 py-2"
            />
          </div>

          {error && (
            <p className="text-sm text-booked border border-booked px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary flex-1 py-2 font-mono"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary flex-1 py-2 font-mono disabled:opacity-60"
            >
              {loading ? "Saving..." : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Wire `isAdmin` / `onEditRequest` into `CurrentBookings.tsx`**

Update the props interface and function signature:

```tsx
interface CurrentBookingsProps {
  bookings: Booking[];
  rooms: Room[];
  currentUserId: string;
  isAdmin: boolean;
  onChanged: () => void;
  onEditRequest: (booking: Booking) => void;
}

export default function CurrentBookings({
  bookings,
  rooms,
  currentUserId,
  isAdmin,
  onChanged,
  onEditRequest,
}: CurrentBookingsProps) {
```

Replace the single Cancel-button block from Task 4 with a button group holding both Edit (admin-only) and Cancel (owner-only):

```tsx
<div className="flex gap-2">
  {isAdmin && !cancelled && (
    <button
      onClick={() => onEditRequest(b)}
      className="text-xs font-mono text-blueprint border border-blueprint px-2 py-1 hover:bg-blueprint hover:text-paper"
    >
      Edit
    </button>
  )}
  {!cancelled && b.user_id === currentUserId && (
    <button
      onClick={() => cancelBooking(b.id)}
      disabled={cancelingId === b.id}
      className="text-xs font-mono text-booked border border-booked px-2 py-1 hover:bg-booked hover:text-paper disabled:opacity-50"
    >
      {cancelingId === b.id ? "..." : "Cancel"}
    </button>
  )}
</div>
```

(`onChanged` is unused directly in this diff but remains a prop passed through from the parent for the existing `cancelBooking` flow — no change to that.)

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Wire admin detection and the modal into `app/dashboard/page.tsx`**

Add the import near the other component imports:

```tsx
import AdminEditBookingModal from "@/components/AdminEditBookingModal";
```

Add state, alongside the existing `selectedRoom` state:

```tsx
const [isAdmin, setIsAdmin] = useState(false);
const [editingBooking, setEditingBooking] = useState<Booking | null>(null);
```

Add a new effect that fetches the signed-in user's role whenever `session` changes (place it after the "Load rooms once" effect):

```tsx
useEffect(() => {
  if (!session) {
    setIsAdmin(false);
    return;
  }
  supabase
    .from("profiles")
    .select("role")
    .eq("id", session.user.id)
    .single()
    .then(({ data }) => setIsAdmin(data?.role === "admin"));
}, [session]);
```

Pass the new props to `CurrentBookings`:

```tsx
<CurrentBookings
  bookings={currentBookings}
  rooms={rooms}
  currentUserId={session?.user.id ?? ""}
  isAdmin={isAdmin}
  onChanged={() => {
    fetchCurrentBookings();
    fetchWindowBookings();
  }}
  onEditRequest={setEditingBooking}
/>
```

Render the modal, alongside the existing `BookingModal` render block:

```tsx
{editingBooking && (
  <AdminEditBookingModal
    booking={editingBooking}
    rooms={rooms}
    onClose={() => setEditingBooking(null)}
    onSaved={() => {
      setEditingBooking(null);
      fetchCurrentBookings();
      fetchWindowBookings();
    }}
  />
)}
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Verify end-to-end (happy path, no conflict)**

Make sure Tasks 1–3's SQL has been run. Promote your own test account to admin:

```sql
update public.profiles set role = 'admin'
where id = (select id from auth.users where email = '<your test account email>');
```

Log out and back in (or refresh) so the dashboard re-fetches your role. Confirm an **Edit** button now appears next to every booking in Current Bookings, including bookings you don't own. Click it on someone else's booking, change the title and time to a slot with no conflicts, enter a reason, save. Confirm: the modal closes, the booking updates in place, and it now shows `Rescheduled by admin — "<your reason>"` (from Task 4's rendering). Open a second browser tab as a different user — confirm it updates there too via realtime.

- [ ] **Step 9: Verify the conflict case shows an error (bump support lands in Task 6)**

As the admin, edit a booking into a room/time slot that's already occupied by another active booking. Confirm you get an inline error listing the conflicting booking's title and owner, and nothing is saved (the target booking is unchanged, the conflicting one is unaffected).

- [ ] **Step 10: Commit**

```bash
git add types/index.ts app/dashboard/page.tsx components/CurrentBookings.tsx components/AdminEditBookingModal.tsx
git commit -m "Add admin role detection and admin booking edit modal (no-conflict path)"
```

---

### Task 6: `AdminEditBookingModal` — bump/confirm step

**Files:**
- Modify: `components/AdminEditBookingModal.tsx`

**Interfaces:**
- Consumes: RPC `admin_edit_booking` (Task 3), same props as Task 5.
- Produces: no new external interface — this task replaces Task 5's inline conflict error with an interactive confirm step inside the same component.

- [ ] **Step 1: Add step/conflict state and a shared `submit` function**

In `components/AdminEditBookingModal.tsx`, add new state below the existing `useState` calls:

```tsx
const [step, setStep] = useState<"edit" | "confirm">("edit");
const [conflicts, setConflicts] = useState<
  { id: string; title: string; user_name: string; start_time: string; end_time: string }[]
>([]);
```

Replace `handleSubmit` with a shared `submit` function plus a thin form handler:

```tsx
async function submit(confirmBump: boolean) {
  setError(null);
  const { startISO, endISO } = computeBookingRange(date, startTime, endTime);

  setLoading(true);
  const { data, error: rpcError } = await supabase.rpc("admin_edit_booking", {
    p_booking_id: booking.id,
    p_room_id: roomId,
    p_title: title.trim() || booking.title,
    p_start_time: startISO,
    p_end_time: endISO,
    p_reason: reason.trim(),
    p_confirm_bump: confirmBump,
  });
  setLoading(false);

  if (rpcError) {
    setError(rpcError.message);
    return;
  }

  if (data?.status === "conflict") {
    setConflicts(data.conflicts ?? []);
    setStep("confirm");
    return;
  }

  onSaved();
}

async function handleSubmit(e: React.FormEvent) {
  e.preventDefault();
  setError(null);

  if (!reason.trim()) {
    setError("A reason is required.");
    return;
  }
  if (startTime === endTime) {
    setError("End time must be after start time.");
    return;
  }

  await submit(false);
}

function handleConfirmBump() {
  submit(true);
}

function handleBack() {
  setStep("edit");
  setConflicts([]);
}
```

- [ ] **Step 2: Render the confirm step, keeping the edit form for the `edit` step**

Replace the `<form onSubmit={handleSubmit} className="space-y-4">...</form>` block with:

```tsx
{step === "confirm" ? (
  <div className="space-y-4">
    <p className="text-sm text-ink/80">
      {rooms.find((r) => r.id === roomId)?.name ?? "This room"} is already
      booked for part of that window. Confirming will cancel the following
      booking(s):
    </p>
    <ul className="space-y-2">
      {conflicts.map((c) => (
        <li key={c.id} className="border border-booked/40 px-3 py-2 text-sm">
          <p className="font-mono font-medium">{c.title}</p>
          <p className="text-xs text-ink/60">Booked by {c.user_name}</p>
        </li>
      ))}
    </ul>
    <p className="text-xs text-ink/60">
      Reason (applies to both changes): &quot;{reason}&quot;
    </p>

    {error && (
      <p className="text-sm text-booked border border-booked px-3 py-2">
        {error}
      </p>
    )}

    <div className="flex gap-3 pt-2">
      <button
        type="button"
        onClick={handleBack}
        className="btn-secondary flex-1 py-2 font-mono"
      >
        Back
      </button>
      <button
        type="button"
        onClick={handleConfirmBump}
        disabled={loading}
        className="btn-primary flex-1 py-2 font-mono disabled:opacity-60"
      >
        {loading ? "Saving..." : "Bump conflicting booking & save"}
      </button>
    </div>
  </div>
) : (
  <form onSubmit={handleSubmit} className="space-y-4">
    <div>
      <label className="block text-sm font-medium mb-1">Room</label>
      <select
        value={roomId}
        onChange={(e) => setRoomId(e.target.value)}
        className="blueprint-input w-full px-3 py-2"
      >
        {rooms.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </div>

    <div>
      <label className="block text-sm font-medium mb-1">Purpose / title</label>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="blueprint-input w-full px-3 py-2"
      />
    </div>

    <div>
      <label className="block text-sm font-medium mb-1">Date</label>
      <input
        type="date"
        required
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="blueprint-input w-full px-3 py-2"
      />
    </div>

    <div className="flex gap-3">
      <div className="flex-1">
        <label className="block text-sm font-medium mb-1">Start time</label>
        <input
          type="time"
          required
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          className="blueprint-input w-full px-3 py-2"
        />
      </div>
      <div className="flex-1">
        <label className="block text-sm font-medium mb-1">End time</label>
        <input
          type="time"
          required
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
          className="blueprint-input w-full px-3 py-2"
        />
      </div>
    </div>

    <div>
      <label className="block text-sm font-medium mb-1">Reason (required)</label>
      <input
        type="text"
        required
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. Dean's meeting needs this room"
        className="blueprint-input w-full px-3 py-2"
      />
    </div>

    {error && (
      <p className="text-sm text-booked border border-booked px-3 py-2">
        {error}
      </p>
    )}

    <div className="flex gap-3 pt-2">
      <button
        type="button"
        onClick={onClose}
        className="btn-secondary flex-1 py-2 font-mono"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={loading}
        className="btn-primary flex-1 py-2 font-mono disabled:opacity-60"
      >
        {loading ? "Saving..." : "Save changes"}
      </button>
    </div>
  </form>
)}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify the bump flow end-to-end**

As an admin (from Task 5's promoted test account), edit a booking into a slot occupied by another active booking. Confirm the modal switches to the confirm step, listing the correct conflicting booking's title and owner. Click **Bump conflicting booking & save**. Confirm:
- The modal closes and both bookings refresh in Current Bookings.
- The conflicting booking now shows struck through with `CANCELLED BY ADMIN — Reason: "<your reason>"` (Task 4's rendering).
- The edited booking shows in its new room/time with `Rescheduled by admin — "<your reason>"`.

Click **Back** on a fresh attempt instead of confirming — verify it returns to the edit form with your entered values intact and does not save anything.

- [ ] **Step 5: Commit**

```bash
git add components/AdminEditBookingModal.tsx
git commit -m "Add bump-confirmation step to admin booking edit modal"
```

---

### Task 7: End-to-end QA pass

No code changes — this task re-runs the spec's full manual test checklist against the finished feature, using a fresh non-admin test account to catch anything the incremental per-task checks in Tasks 1–6 might have missed in combination.

**Files:** none.

- [ ] **Step 1: Non-admin has no admin UI**

Sign up a brand-new test user (never promoted). Confirm no Edit button appears anywhere in Current Bookings, even on their own bookings.

- [ ] **Step 2: Non-admin cannot call the RPC directly**

While logged in as that non-admin user, open the browser console and run:

```js
const { data, error } = await supabase.rpc('admin_edit_booking', {
  p_booking_id: '00000000-0000-0000-0000-000000000000',
  p_room_id: '00000000-0000-0000-0000-000000000000',
  p_title: 'x',
  p_start_time: new Date().toISOString(),
  p_end_time: new Date(Date.now() + 3600000).toISOString(),
  p_reason: 'test',
});
console.log({ data, error });
```

Expected: `error` is set with the message `Only admins can edit other bookings`; `data` is `null`.

- [ ] **Step 3: Non-admin cannot write their own or anyone else's profile role**

Repeat Task 1 Step 5's check — confirm it still holds after all subsequent migrations.

- [ ] **Step 4: Admin edit with no conflict**

Promote the test user to admin (SQL from Task 5 Step 8). Edit another member's booking to a free slot with a reason. Confirm the change and the reason both show correctly, and that a second browser tab (a different logged-in user) sees the update live via realtime without a manual refresh.

- [ ] **Step 5: Admin bump**

Edit a booking into an occupied slot, confirm the bump. Confirm both the moved booking and the now-cancelled booking display correctly per Task 4/6's rendering.

- [ ] **Step 6: Bumped slot is actually free**

As a different (non-admin) user, try to book the exact room/time slot that was freed up by Step 5's bump. Confirm it succeeds — the partial exclusion constraint from Task 2 no longer sees the cancelled booking as occupying that slot.

- [ ] **Step 7: Reason required**

As admin, try to submit the edit form with the Reason field empty. Confirm the client-side validation blocks it (`"A reason is required."`) before any network call.

- [ ] **Step 8: Cancelled bookings age out naturally**

Pick a bumped/cancelled booking whose original `end_time` is in the past (or use SQL to set one's `end_time` to a past timestamp for testing, then revert). Confirm it no longer appears in Current Bookings once its `end_time` has passed, same as any other booking — no separate cleanup step exists or is needed.

This task ends the plan — no commit needed since no files change.
