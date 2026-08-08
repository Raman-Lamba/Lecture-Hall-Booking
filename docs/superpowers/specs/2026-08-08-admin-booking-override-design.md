# Admin booking override — design

Date: 2026-08-08

## Problem

Today, `bookings` has no concept of roles: any signed-in user can create a
booking and cancel (hard-delete) only their own. There's no edit capability
at all, and no way for anyone to resolve a scheduling conflict except by the
original booker cancelling.

We want a small set of "admin" users who can:

- Edit any booking (room, title, time), including other members' bookings.
- Reschedule a booking into a slot that's already taken by bumping
  (cancelling) the conflicting booking.
- Have their reason for doing either of the above be visible on the
  "Current Bookings" list, to everyone (bookings are already visible to
  everyone today).

Everything else about the app (booking creation, self-cancel, realtime
updates, server-clock-based time) stays as-is.

## Admin identity

Hardcoded email allowlist, not a `profiles` table or user-metadata flag —
smallest change, matches the existing `ALLOWED_EMAIL_DOMAIN` pattern in
`lib/auth.ts`, and admin turnover is expected to be rare enough that a code
deploy + SQL migration per change is acceptable.

`lib/auth.ts` adds:

```ts
export const ADMIN_EMAILS = ["dean@imthyderabad.edu.in"]; // placeholder — edit as needed

export function isAdmin(email: string): boolean {
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}
```

This list must be kept in sync with the hardcoded list inside the
`public.is_admin()` SQL function below — there are intentionally two copies
(client-side for UI gating, server-side for actual authorization), and nothing
enforces they match. A comment in each file points at the other.

## Data model changes (`schema.sql`)

Add to `bookings`:

```sql
alter table bookings add column if not exists status text not null default 'active'
  check (status in ('active', 'cancelled'));
alter table bookings add column if not exists last_edited_by uuid references auth.users(id);
alter table bookings add column if not exists last_edited_reason text;
alter table bookings add column if not exists last_edited_at timestamptz;
```

- `status`: `'active'` (normal) or `'cancelled'` (soft-cancelled by an admin
  bump). Regular user self-cancel is unchanged — it still hard-deletes the
  row. Only the admin bump path sets `status = 'cancelled'`.
- `last_edited_by` / `last_edited_reason` / `last_edited_at`: set whenever an
  admin edits or bumps a booking. Holds only the *latest* edit — no separate
  audit-history table. `null` until first touched by an admin.

The overlap-prevention exclusion constraint becomes partial, so a cancelled
row no longer blocks the slot it used to occupy:

```sql
alter table bookings drop constraint no_overlapping_bookings;
alter table bookings
  add constraint no_overlapping_bookings
  exclude using gist (
    room_id with =,
    tstzrange(start_time, end_time) with &&
  )
  where (status = 'active');
```

`get_current_bookings()` is unchanged (`where end_time > now()`). This means
a bumped booking keeps appearing — struck through, with its reason — until
its *original* end time passes, then disappears on its own. No extra cleanup
job needed.

### `is_admin()` helper

```sql
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.email(), '') = any (array[
    'dean@imthyderabad.edu.in'  -- keep in sync with lib/auth.ts ADMIN_EMAILS
  ]);
$$;

grant execute on function public.is_admin to authenticated;
```

### RLS

Add an `update` policy so admins can update any booking directly (in
addition to the RPC below, which is `security definer` and doesn't strictly
need it, but keeping the policy explicit documents access the same way the
rest of the schema does):

```sql
create policy "admins can update any booking"
  on bookings for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
```

## `admin_edit_booking` RPC

One `security definer` function that performs the whole edit-or-bump flow
as a single transaction, so a caller can't observe or cause a half-applied
state (e.g. the conflicting booking cancelled but the target update failing,
or two admins racing on the same slot).

```sql
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

Notes:
- `is_admin()` is re-checked inside the function (not just relied on via RLS)
  since this function is `security definer` and bypasses RLS internally.
- Cancelling conflicts happens *before* updating the target row, so the
  partial exclusion constraint never sees a moment where both rows are
  `active` and overlapping.
- Non-admin callers get a Postgres error from the RPC; the frontend surfaces
  `error.message` the same way `BookingModal` already does today.

## Frontend

### `lib/auth.ts`
Add `ADMIN_EMAILS` / `isAdmin()` as above.

### `app/dashboard/page.tsx`
Compute `const admin = isAdmin(session?.user.email ?? "")` and pass it to
`CurrentBookings` as a new `isAdmin` prop. No other changes — the existing
realtime subscription already refetches both `windowBookings` and
`currentBookings` on any change to the `bookings` table, so admin
edits/bumps propagate to every open tab without new plumbing.

### `components/CurrentBookings.tsx`
- New `isAdmin: boolean` prop.
- Each row gets an **Edit** button when `isAdmin` is true (shown regardless
  of who owns the booking; the existing **Cancel** button keeps its current
  "only shows for `b.user_id === currentUserId`" rule, unchanged).
- Rendering per booking `status`:
  - `active`, `last_edited_reason` null → today's rendering, unchanged.
  - `active`, `last_edited_reason` set → today's rendering plus a line:
    `Rescheduled by admin — "<last_edited_reason>"`.
  - `cancelled` → row renders struck-through with a `CANCELLED BY ADMIN`
    badge and `Reason: "<last_edited_reason>"`. No Cancel button (already
    cancelled); no Edit button either (nothing left to edit).
- Clicking Edit opens `AdminEditBookingModal` for that booking.

### New `components/AdminEditBookingModal.tsx`
Sibling to `BookingModal.tsx`, reusing `computeBookingRange` and
`serverNow`. Two-step flow in one modal:

1. **Edit step** — pre-filled room (`<select>` of all rooms)/title/date/
   start/end from the booking being edited, plus a required **Reason**
   text input. Submitting calls
   `supabase.rpc('admin_edit_booking', { ..., p_confirm_bump: false })`.
   - `status: 'ok'` → close modal, call `onChanged()`.
   - `status: 'conflict'` → switch to the confirm step, keeping the
     entered reason.
   - RPC error (validation, non-admin, etc.) → show `error.message` inline,
     same pattern as `BookingModal`.
2. **Confirm step** — lists the conflicting booking(s) (room name looked up
   client-side from the already-loaded `rooms`, title, owner, time range)
   with the message "This will cancel the following booking(s)", and a
   **"Bump conflicting booking & save"** button that resubmits the same RPC
   with `p_confirm_bump: true`. A **Back** button returns to the edit step
   without resubmitting.

### `types/index.ts`
`Booking` gains:
```ts
status: "active" | "cancelled";
last_edited_by: string | null;
last_edited_reason: string | null;
last_edited_at: string | null;
```

## Out of scope (explicitly not building)

- Self-edit for regular members (they can still only create + cancel their
  own bookings; editing is admin-only).
- A `profiles`/roles table or any admin-management UI — admins are a
  hardcoded list edited by a developer.
- Full audit-history table — only the latest edit's reason/admin/timestamp
  is kept per booking.
- Notifications (email/push) to the bumped user — they see the reason next
  time they load/refresh Current Bookings, same visibility model as every
  other booking today.

## Testing

- Manual: sign in as a non-admin, confirm no Edit button appears anywhere.
- Manual: sign in as an admin (email in `ADMIN_EMAILS`), edit another
  member's booking with no conflict → title/room/time update, reason shows
  as "Rescheduled by admin" on the row, realtime-propagates to a second
  browser tab.
- Manual: admin edits a booking into an occupied slot → confirm step lists
  the right conflicting booking → confirm → conflicting booking shows
  struck-through with reason, target booking shows in its new slot.
- Manual: attempt to call `admin_edit_booking` as a non-admin (e.g. via
  browser devtools/RPC directly) → confirm it's rejected server-side, not
  just hidden client-side.
- Manual: verify a cancelled (bumped) booking still blocks nothing — book
  that same slot as a different user, should succeed.
