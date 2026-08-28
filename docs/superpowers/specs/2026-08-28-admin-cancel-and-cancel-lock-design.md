# Admin direct-cancel + user-cancel lock — design

Date: 2026-08-28

## Problem

The [admin booking override](2026-08-08-admin-booking-override-design.md) work
gave admins an **Edit** action (reschedule, with conflict-bump) but no way to
simply cancel a booking outright. Today the only path to `status =
'cancelled'` is the *side effect* of an edit bumping a conflicting booking —
there's no direct "admin cancels this booking, done" action.

Separately, once an admin *does* edit a booking (reschedule, no bump), the
original booker currently keeps full, unrestricted cancel rights over it —
same as any booking they've never had touched by an admin. That's
inconsistent with the intent of an admin edit: if an admin has deliberately
placed a booking in a specific room/time (e.g. "Dean's meeting needs this
room"), the original user unilaterally deleting it undoes the admin's
decision without the admin's knowledge.

This spec adds:
1. A direct **Cancel** action for admins, alongside the existing Edit action.
2. A rule that once an admin has touched a booking (edited or cancelled), the
   original booker's self-cancel is locked — only an admin can cancel it from
   then on.

Everything else about the existing override system (roles, `is_admin()`,
`admin_edit_booking`, realtime propagation, soft-cancel rendering) is
unchanged and reused as-is.

## Data model changes

No new columns. `status`, `last_edited_by`, `last_edited_reason`,
`last_edited_at` (added in the prior spec) are reused unchanged.
`last_edited_by` becomes the signal for "has an admin ever touched this
booking" — it's set only by `admin_edit_booking` and the new
`admin_cancel_booking`, never by anything else.

## RLS: lock self-cancel once admin-touched

```sql
drop policy if exists "users can delete their own bookings" on bookings;
create policy "users can delete their own bookings"
  on bookings for delete
  to authenticated
  using (auth.uid() = user_id and last_edited_by is null);
```

This is the enforcement point — not the UI. Hiding the Cancel button alone
wouldn't stop a user from calling `supabase.from("bookings").delete()`
directly against the REST API, the same bypass class already closed once for
admin edits (see prior spec's section 13a / commit `4009868`). Tightening the
`using` clause here means **no** client path — button, direct REST call, or
otherwise — can delete a booking once `last_edited_by` is non-null, for any
reason.

Note this is a `delete` policy `using` clause, not `with check` (deletes
don't have a `with check`), so this is the complete condition: the row is
deletable by its owner only while no admin has ever recorded an edit against
it.

## `admin_cancel_booking` RPC

```sql
create or replace function public.admin_cancel_booking(
  p_booking_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can cancel other bookings';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required';
  end if;

  select status into v_status
    from public.bookings
    where id = p_booking_id
    for update;

  if not found then
    raise exception 'Booking not found';
  end if;

  if v_status = 'cancelled' then
    raise exception 'Booking is already cancelled';
  end if;

  update public.bookings
    set status = 'cancelled',
        last_edited_by = auth.uid(),
        last_edited_reason = p_reason,
        last_edited_at = now()
    where id = p_booking_id;

  return jsonb_build_object('status', 'ok');
end;
$$;

grant execute on function public.admin_cancel_booking to authenticated;
```

Notes:
- `security definer`, so it bypasses RLS internally — `is_admin()` is
  re-checked inline, same pattern as `admin_edit_booking`.
- `select ... for update` + explicit already-cancelled check prevents a
  double-cancel race (two admins clicking Cancel on the same booking at
  once) from silently no-op'ing or double-stamping `last_edited_at`; the
  second caller gets a clear error instead.
- No conflict-checking needed (unlike edit) — cancelling can't collide with
  anything, it only ever frees a slot.
- Reuses the exact `status = 'cancelled'` + `last_edited_reason` convention
  `CurrentBookings.tsx` already renders ("CANCELLED BY ADMIN — Reason:
  ..."). No new rendering branch needed for the cancelled state.

## Frontend

### New `components/AdminCancelBookingModal.tsx`

Sibling to `AdminEditBookingModal.tsx`, much smaller — single step, no
conflict/confirm flow (cancelling can't conflict with anything):

- Shows the booking's title/room/time for context (read-only).
- Required **Reason** text input.
- **Back** / **Cancel booking** buttons. Submitting calls:
  ```ts
  supabase.rpc("admin_cancel_booking", {
    p_booking_id: booking.id,
    p_reason: reason.trim(),
  });
  ```
  - RPC error → show `error.message` inline (same pattern as
    `AdminEditBookingModal`/`BookingModal`).
  - Success → call `onCancelled()`, parent closes the modal and refetches.

### `components/CurrentBookings.tsx`

- New `onCancelRequest: (booking: Booking) => void` prop, mirrors the
  existing `onEditRequest`.
- Admin **Cancel** button added next to the existing **Edit** button, same
  visibility rule: `isAdmin && !cancelled`.
- User's own **Cancel** button visibility changes from:
  ```js
  !cancelled && b.user_id === currentUserId
  ```
  to:
  ```js
  !cancelled && !b.last_edited_by && b.user_id === currentUserId
  ```
- The existing "Rescheduled by admin" line (shown when `!cancelled &&
  b.last_edited_reason`) gets an added clause so the missing Cancel button
  isn't unexplained:
  > `Rescheduled by admin — "<last_edited_reason>" · Cancellation now
  > requires an admin.`

### `app/dashboard/page.tsx`

Same wiring pattern already used for `editingBooking` /
`AdminEditBookingModal`:
- New `cancelingBooking` state, `setCancelingBooking` passed as
  `onCancelRequest`.
- New conditional render of `AdminCancelBookingModal` when
  `cancelingBooking` is set, with `onClose` clearing it and `onCancelled`
  clearing it + calling `fetchCurrentBookings()` / `fetchWindowBookings()`
  (identical refetch pair used by the edit modal's `onSaved`).

No realtime plumbing changes needed — the existing `postgres_changes`
subscription already refetches on any `bookings` table change, so both the
new admin cancel and the tightened delete policy's effects propagate to
every open tab exactly like the existing bump-cancel path does today.

### `types/index.ts`

No changes — `last_edited_by` already exists on `Booking` from the prior
spec.

## Behavior summary

| Booking state | Owner can cancel? | Admin can cancel? |
|---|---|---|
| Never touched by an admin | Yes (hard delete) | Yes (soft-cancel, new) |
| Admin edited (rescheduled), no bump | **No (new lock)** | Yes (soft-cancel, new) |
| Already `cancelled` (bumped or admin-cancelled) | No (nothing to cancel) | No (already cancelled — RPC rejects) |

## Out of scope (explicitly not building)

- Any "release the lock" mechanism to hand cancel rights back to the user
  after an admin edit — the lock is permanent for that booking once set.
- Notifying the cancelled/locked-out user (email/push) — no notification
  system exists in this codebase; same as the prior spec's stance on bump
  notifications.
- Changing hard-delete-vs-soft-cancel semantics for the user's own
  never-touched bookings — self-cancel stays a hard delete, unchanged.
- Any change to `admin_edit_booking`'s bump behavior — it already
  soft-cancels the bumped booking and stamps `last_edited_by`, which the new
  RLS policy already accounts for.

## Testing

- Manual: as a regular user, book a room, confirm Cancel button works
  (unchanged baseline).
- Manual: as admin, edit that user's booking (reschedule, no conflict) →
  confirm the user's Cancel button disappears on their next refresh/realtime
  update, and the "Cancellation now requires an admin" line appears.
- Manual: as that user, attempt `supabase.from('bookings').delete().eq('id',
  ...)` directly from the browser console on the now-admin-touched booking →
  confirm RLS rejects it (0 rows affected / permission error), not just that
  the button is hidden.
- Manual: as admin, click the new Cancel button on an untouched booking →
  enter a reason → confirm it renders struck-through as "CANCELLED BY ADMIN"
  for both the admin and the original user's browser tab (realtime).
- Manual: as admin, attempt to cancel a booking that's already `cancelled` →
  confirm a clear error, no crash.
- Manual: attempt to call `admin_cancel_booking` as a non-admin (devtools) →
  confirm server-side rejection, not just a hidden button.
- Manual: confirm a booking bumped via `admin_edit_booking`'s existing
  conflict path also loses the owner's Cancel button (it already does, via
  `!cancelled`, but re-verify `last_edited_by` is also set so the RLS lock
  covers it too, in case the row somehow gets reactivated later).
- Regenerate `docs/admin-booking-qa-checklist.md` coverage for: admin Cancel
  button, locked self-cancel after edit, and the direct-REST-bypass check
  above — that checklist currently only covers the edit/bump flow from the
  prior spec.
