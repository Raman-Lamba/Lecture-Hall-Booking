# Admin Direct-Cancel + User-Cancel Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a direct **Cancel** action on any booking (not just the existing bump-as-a-side-effect-of-edit path), and lock a booking's self-cancel once an admin has edited or cancelled it — enforced at the database level, not just hidden in the UI.

**Architecture:** A new `security definer` RPC, `admin_cancel_booking`, soft-cancels a booking the same way the existing bump path already does (`status = 'cancelled'`, `last_edited_*` stamped) but as a direct, single-step action with no conflict handling needed. The existing `users can delete their own bookings` RLS policy gets a second condition — `last_edited_by is null` — so once *any* admin action (edit or cancel) has touched a booking, no client path can delete it as the owner. Frontend: a small new `AdminCancelBookingModal` sibling to `AdminEditBookingModal`, a second admin button in `CurrentBookings`, and a tightened visibility condition on the existing owner Cancel button.

**Tech Stack:** Next.js 14 (App Router) + React 18 + Supabase (Postgres, Auth, Realtime, RLS) + Tailwind CSS. No test runner exists in this repo — verification is manual (Supabase SQL Editor + browser), same as the rest of this codebase. Each frontend task still runs `npx tsc --noEmit` as an automated correctness gate.

## Global Constraints

- `last_edited_by` is the sole signal for "an admin has touched this booking" — set only by `admin_edit_booking` and the new `admin_cancel_booking`, never anywhere else. See `docs/superpowers/specs/2026-08-28-admin-cancel-and-cancel-lock-design.md`.
- The self-cancel lock is enforced at the RLS layer (`using (auth.uid() = user_id and last_edited_by is null)`), not just by hiding the Cancel button — no client path (UI, direct REST call, or otherwise) may delete an admin-touched booking.
- `admin_cancel_booking` requires a non-empty `p_reason`, enforced server-side inside the function — matching `admin_edit_booking`'s existing rule.
- Cancelling a booking that is already `status = 'cancelled'` must raise a clear error (`'Booking is already cancelled'`), never silently no-op.
- Admin cancel is a single-step form — no conflict/confirm step, since cancelling can never collide with anything.
- Out of scope: any "release the lock" mechanism, notifications (email/push), and any change to hard-delete semantics for a user's own never-touched bookings.

## File Structure

- **Modify `schema.sql`**: append a new section 14 — (14a) tighten the `users can delete their own bookings` policy with the `last_edited_by is null` condition, (14b) the `admin_cancel_booking` RPC.
- **Modify `components/CurrentBookings.tsx`**: gate the owner's existing Cancel button on `!b.last_edited_by`, extend the "Rescheduled by admin" line with an explanation, add a new admin-only Cancel button and `onCancelRequest` prop.
- **Create `components/AdminCancelBookingModal.tsx`**: single-step reason form, sibling to `AdminEditBookingModal.tsx`.
- **Modify `app/dashboard/page.tsx`**: own the "which booking is being admin-cancelled" state, wire the new prop and modal.
- **Modify `docs/admin-booking-qa-checklist.md`**: add new parts covering the admin Cancel button, the self-cancel lock, and the direct-REST-bypass check for the tightened delete policy.

---

### Task 1: Database — tighten the self-cancel RLS policy

**Files:**
- Modify: `schema.sql` (append after section 13b, at the end of the file)

**Interfaces:**
- Consumes: `bookings.last_edited_by` (already exists from the prior admin-override migration).
- Produces: the `users can delete their own bookings` policy now additionally requires `last_edited_by is null`.

- [ ] **Step 1: Append the new section to `schema.sql`**

Add this at the end of the file:

```sql
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
```

- [ ] **Step 2: Run it against Supabase**

Open your Supabase project → SQL Editor → paste just the new section 14a block above → Run.

- [ ] **Step 3: Verify the policy's new condition**

```sql
select policyname, cmd, qual from pg_policies
where tablename = 'bookings' and policyname = 'users can delete their own bookings';
```

Expected: one row, `cmd = 'DELETE'`, and `qual` contains both `auth.uid() = user_id` and `last_edited_by IS NULL`.

- [ ] **Step 4: Verify the lock end-to-end with SQL**

Pick any existing active booking's id and owner:

```sql
select id, user_id, status, last_edited_by from bookings where status = 'active' limit 1;
```

Simulate an admin touch on it directly (bypassing the app, just to test the policy in isolation):

```sql
update bookings set last_edited_by = user_id, last_edited_reason = 'QA test touch', last_edited_at = now()
where id = '<that id>';
```

As that booking's owner (log in as them in the app, or use their JWT via the SQL Editor's "Run as" if available), attempt:

```sql
delete from bookings where id = '<that id>';
```

Expected: `0 rows affected` (RLS silently filters it out) — the booking still exists and is unchanged. Then revert your test touch so later tasks start clean:

```sql
update bookings set last_edited_by = null, last_edited_reason = null, last_edited_at = null
where id = '<that id>';
```

- [ ] **Step 5: Commit**

```bash
git add schema.sql
git commit -m "Lock user self-cancel once an admin has touched the booking"
```

---

### Task 2: Database — `admin_cancel_booking` RPC

**Files:**
- Modify: `schema.sql` (append after Task 1's section 14a)

**Interfaces:**
- Consumes: `public.is_admin()` (existing), `bookings.status`/`last_edited_*` (existing).
- Produces: RPC `public.admin_cancel_booking(p_booking_id uuid, p_reason text) returns jsonb`. Return shape: `{"status": "ok"}` on success; raises a Postgres exception on any failure (non-admin, empty reason, not found, already cancelled).

- [ ] **Step 1: Append the new section to `schema.sql`**

```sql
-- --------------------------------------------
-- 14b. Direct admin cancel.
-- --------------------------------------------
-- Unlike admin_edit_booking, this never needs conflict handling --
-- cancelling a booking only ever frees a slot, it can't collide with
-- anything. `select ... for update` plus the explicit already-cancelled
-- check below prevents two admins racing to cancel the same booking from
-- silently double-stamping last_edited_at.
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

- [ ] **Step 2: Run it against Supabase**

Paste just this new section 14b block into the SQL Editor and run it.

- [ ] **Step 3: Verify the admin guard fires before touching any table**

```sql
select public.admin_cancel_booking(
  '00000000-0000-0000-0000-000000000000'::uuid,
  'smoke test reason'
);
```

Expected: an error — `Only admins can cancel other bookings` (running as the SQL Editor's `postgres` role, `is_admin()` returns `false` since `auth.uid()` is `null`). The fake UUID still errors on the admin check first, confirming the guard runs before any lookup.

- [ ] **Step 4: Verify the already-cancelled guard (requires a real admin session)**

This step needs a real admin's session, so it's easiest to verify from the app once Task 5's UI exists — skip ahead and come back, or use the SQL Editor's impersonation feature if your Supabase plan has one:

```sql
select public.admin_cancel_booking('<id of an already status=cancelled booking>', 'test');
```

Expected: an error — `Booking is already cancelled`.

- [ ] **Step 5: Commit**

```bash
git add schema.sql
git commit -m "Add admin_cancel_booking RPC for direct admin cancellation"
```

---

### Task 3: Lock the owner's Cancel button + explain why

**Files:**
- Modify: `components/CurrentBookings.tsx`

**Interfaces:**
- Consumes: `Booking.last_edited_by` (existing field, already on the type from the prior admin-override work).
- Produces: no new external interface — this task only changes what's rendered for existing props.

- [ ] **Step 1: Gate the owner's Cancel button and extend the reschedule copy**

In `components/CurrentBookings.tsx`, replace this block:

```tsx
                  {!cancelled && b.last_edited_reason && (
                    <p className="text-xs text-blueprint font-mono mt-1">
                      Rescheduled by admin — &quot;{b.last_edited_reason}&quot;
                    </p>
                  )}
                </div>
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

with:

```tsx
                  {!cancelled && b.last_edited_reason && (
                    <p className="text-xs text-blueprint font-mono mt-1">
                      Rescheduled by admin — &quot;{b.last_edited_reason}&quot; ·
                      Cancellation now requires an admin.
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  {isAdmin && !cancelled && (
                    <button
                      onClick={() => onEditRequest(b)}
                      className="text-xs font-mono text-blueprint border border-blueprint px-2 py-1 hover:bg-blueprint hover:text-paper"
                    >
                      Edit
                    </button>
                  )}
                  {!cancelled && !b.last_edited_by && b.user_id === currentUserId && (
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

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify visually**

Make sure Task 1's SQL has been run. Start the app (`npm run dev`), log in as a non-admin user, and note one of your own active booking's `id` (query `select id, title from bookings where status = 'active' limit 5;` in the SQL Editor, or read it off the page). Simulate an admin edit on it:

```sql
update bookings set last_edited_by = user_id, last_edited_reason = 'QA test edit' where id = '<that id>';
```

Reload the dashboard. Expected: that booking now shows `Rescheduled by admin — "QA test edit" · Cancellation now requires an admin.`, and its Cancel button is gone — even though you're logged in as its owner. Confirm every other (untouched) booking you own still shows its Cancel button as before.

Revert so later tasks start clean:

```sql
update bookings set last_edited_by = null, last_edited_reason = null where id = '<that id>';
```

- [ ] **Step 4: Commit**

```bash
git add components/CurrentBookings.tsx
git commit -m "Lock owner Cancel button once a booking has been admin-edited"
```

---

### Task 4: `AdminCancelBookingModal` component

**Files:**
- Create: `components/AdminCancelBookingModal.tsx`

**Interfaces:**
- Consumes: RPC `admin_cancel_booking` (Task 2), `Booking` type (existing).
- Produces: `AdminCancelBookingModal` component with props `{ booking: Booking; roomName: string; onClose: () => void; onCancelled: () => void }`.

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { Booking } from "@/types";

interface AdminCancelBookingModalProps {
  booking: Booking;
  roomName: string;
  onClose: () => void;
  onCancelled: () => void;
}

export default function AdminCancelBookingModal({
  booking,
  roomName,
  onClose,
  onCancelled,
}: AdminCancelBookingModalProps) {
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

    setLoading(true);
    const { error: rpcError } = await supabase.rpc("admin_cancel_booking", {
      p_booking_id: booking.id,
      p_reason: reason.trim(),
    });
    setLoading(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    onCancelled();
  }

  return (
    <div className="fixed inset-0 bg-ink/50 flex items-center justify-center z-50 px-4">
      <div className="blueprint-card w-full max-w-md p-6">
        <p className="font-mono text-xs tracking-widest text-blueprint mb-1">
          ADMIN CANCEL
        </p>
        <h2 className="font-mono text-xl font-semibold mb-1">{booking.title}</h2>
        <p className="text-sm text-ink/60 mb-5">
          {roomName} — booked by {booking.user_name}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Reason (required)
            </label>
            <input
              type="text"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Room needed for maintenance"
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
              Back
            </button>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary flex-1 py-2 font-mono disabled:opacity-60"
            >
              {loading ? "Cancelling..." : "Cancel booking"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (this component isn't imported anywhere yet, but it must still type-check standalone).

- [ ] **Step 3: Commit**

```bash
git add components/AdminCancelBookingModal.tsx
git commit -m "Add AdminCancelBookingModal for direct admin cancellation"
```

---

### Task 5: Wire the admin Cancel button and modal

**Files:**
- Modify: `components/CurrentBookings.tsx`
- Modify: `app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `AdminCancelBookingModal` (Task 4), RPC `admin_cancel_booking` (Task 2).
- Produces: `CurrentBookings` gains an `onCancelRequest: (booking: Booking) => void` prop; `app/dashboard/page.tsx` gains `cancelingBooking` state.

- [ ] **Step 1: Add the `onCancelRequest` prop and admin Cancel button in `CurrentBookings.tsx`**

Replace the props interface and function signature:

```tsx
interface CurrentBookingsProps {
  bookings: Booking[];
  rooms: Room[];
  currentUserId: string;
  isAdmin: boolean;
  onChanged: () => void;
  onEditRequest: (booking: Booking) => void;
  onCancelRequest: (booking: Booking) => void;
}

export default function CurrentBookings({
  bookings,
  rooms,
  currentUserId,
  isAdmin,
  onChanged,
  onEditRequest,
  onCancelRequest,
}: CurrentBookingsProps) {
```

Replace the button group from Task 3:

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
                  {!cancelled && !b.last_edited_by && b.user_id === currentUserId && (
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

with:

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
                  {isAdmin && !cancelled && (
                    <button
                      onClick={() => onCancelRequest(b)}
                      className="text-xs font-mono text-booked border border-booked px-2 py-1 hover:bg-booked hover:text-paper"
                    >
                      Cancel
                    </button>
                  )}
                  {!cancelled && !b.last_edited_by && b.user_id === currentUserId && (
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

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: it will FAIL at this point — `app/dashboard/page.tsx` renders `<CurrentBookings>` without the new required `onCancelRequest` prop. Confirm the error names `onCancelRequest` and `CurrentBookings` before moving to the next step.

- [ ] **Step 3: Wire the modal into `app/dashboard/page.tsx`**

Add the import next to the existing `AdminEditBookingModal` import (`app/dashboard/page.tsx:12`):

```tsx
import AdminCancelBookingModal from "@/components/AdminCancelBookingModal";
```

Add state next to `editingBooking` (`app/dashboard/page.tsx:61`):

```tsx
  const [cancelingBooking, setCancelingBooking] = useState<Booking | null>(null);
```

Pass the new prop to `CurrentBookings` (alongside the existing `onEditRequest={setEditingBooking}`):

```tsx
          onEditRequest={setEditingBooking}
          onCancelRequest={setCancelingBooking}
```

Render the new modal, alongside the existing `AdminEditBookingModal` render block:

```tsx
      {cancelingBooking && (
        <AdminCancelBookingModal
          booking={cancelingBooking}
          roomName={
            rooms.find((r) => r.id === cancelingBooking.room_id)?.name ?? "This room"
          }
          onClose={() => setCancelingBooking(null)}
          onCancelled={() => {
            setCancelingBooking(null);
            fetchCurrentBookings();
            fetchWindowBookings();
          }}
        />
      )}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify end-to-end**

Make sure Tasks 1–2's SQL has been run and you're logged in as an already-promoted admin test account (promote via the SQL from the prior admin-override plan if you haven't: `update public.profiles set role = 'admin' where id = (select id from auth.users where email = '<your test account email>');`, then refresh).

Click the new **Cancel** button (next to Edit) on a booking owned by a different user. Enter a reason, submit. Confirm:
- The modal closes.
- That booking now shows struck through with `CANCELLED BY ADMIN — Reason: "<your reason>"`.
- Open a second browser tab as that booking's owner — confirm it updates there too via realtime, and their own Cancel button is gone (nothing left to cancel).

Try submitting the form with the Reason field empty — confirm client-side validation blocks it (`"A reason is required."`) before any network call.

Try clicking Cancel on a booking, then **Back** — confirm the modal closes with nothing saved (booking unchanged).

- [ ] **Step 6: Commit**

```bash
git add components/CurrentBookings.tsx app/dashboard/page.tsx
git commit -m "Wire direct admin Cancel button into Current Bookings"
```

---

### Task 6: Extend the QA checklist

**Files:**
- Modify: `docs/admin-booking-qa-checklist.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add a new Part 8 covering the self-cancel lock**

Insert this new section right before the existing `## Part 6 — Non-admin still can't touch role/admin status` heading in `docs/admin-booking-qa-checklist.md`:

```markdown
## Part 6.5 — Self-cancel lock after an admin edit

- [ ] Log in as a non-admin user. Create a booking.
- [ ] Confirm you can see and use its Cancel button (baseline — no admin
      involvement yet).
- [ ] Create a second booking. Ask an admin (or, if you have access,
      promote yourself temporarily) to Edit that second booking's
      time/room/title with any reason, no conflict needed.
- [ ] Back as the original (non-admin) owner, refresh Current Bookings.
      Confirm: the edited booking now reads `Rescheduled by admin —
      "<reason>" · Cancellation now requires an admin.` and its **Cancel
      button is gone** — even though you're still its owner.
- [ ] Confirm your *other*, untouched booking from the first step still
      has its Cancel button and still cancels normally.
- [ ] While logged in as that non-admin owner, open the browser console
      and try to delete the admin-touched booking directly, bypassing the
      UI:
  ```js
  (async () => {
    const { data, error } = await supabase
      .from('bookings')
      .delete()
      .eq('id', 'PASTE_THE_ADMIN_TOUCHED_BOOKING_ID_HERE')
      .select();
    console.log({ data, error });
  })();
  ```
  Expected: `data` is an empty array `[]` (0 rows affected) — confirm the
  booking still exists in Current Bookings afterward. **This confirms the
  lock is enforced by the database, not just by hiding the button.**
```

- [ ] **Step 2: Add a new Part 9 covering the direct admin Cancel action**

Append this new section after the existing `## Part 7 — Pre-existing bookings still work` section (before the `---` / "Reporting results" footer):

```markdown
## Part 8 — Direct admin cancel

- [ ] As an admin, find a booking made by a different user that has never
      been edited (no "Rescheduled by admin" / "CANCELLED BY ADMIN" line
      yet).
- [ ] Confirm you now see **two** buttons on it: **Edit** and **Cancel**.
- [ ] Click **Cancel**. Try submitting with the Reason field empty —
      confirm it's blocked with "A reason is required." and nothing is
      saved.
- [ ] Fill in a reason (e.g. "testing direct cancel") and submit.
- [ ] Confirm the booking now shows struck through with `CANCELLED BY
      ADMIN — Reason: "testing direct cancel"`, exactly like a bumped
      booking does.
- [ ] If you have a second browser tab logged in as that booking's
      original owner, confirm it updates there too within a second or
      two via realtime, and their Cancel button is gone.
- [ ] Try clicking **Cancel** again on that same (now-cancelled) booking
      via the browser console (since the button no longer shows in the
      UI once a booking is cancelled):
  ```js
  (async () => {
    const { data, error } = await supabase.rpc('admin_cancel_booking', {
      p_booking_id: 'PASTE_THE_JUST_CANCELLED_BOOKING_ID_HERE',
      p_reason: 'double cancel attempt',
    });
    console.log({ data, error });
  })();
  ```
  Expected: `error` is set with the message "Booking is already
  cancelled"; `data` is `null`.
- [ ] As a non-admin user, confirm the direct RPC bypass is also blocked
      here:
  ```js
  (async () => {
    const { data, error } = await supabase.rpc('admin_cancel_booking', {
      p_booking_id: '00000000-0000-0000-0000-000000000000',
      p_reason: 'test',
    });
    console.log({ data, error });
  })();
  ```
  Expected: `error` is set with the message "Only admins can cancel other
  bookings"; `data` is `null`.
```

- [ ] **Step 3: Read the whole file back and sanity-check ordering**

Open `docs/admin-booking-qa-checklist.md` and confirm the parts now read in
this order: Setup, Part 1, Part 2, Part 3, Part 4, Part 5, Part 6.5, Part 6,
Part 7, Part 8, Reporting results. (Part 6.5 sitting between Part 5 and Part
6 is intentional — it's testable as soon as an edit exists, before the
role-tampering checks in Part 6.)

- [ ] **Step 4: Commit**

```bash
git add docs/admin-booking-qa-checklist.md
git commit -m "Add QA checklist coverage for admin cancel and self-cancel lock"
```

---

### Task 7: End-to-end QA pass

No code changes — this task re-runs the newly-added QA checklist sections (Part 6.5 and Part 8) plus a couple of interaction checks against the finished feature, using real admin/non-admin test accounts, to catch anything the incremental per-task checks in Tasks 1–6 might have missed in combination.

**Files:** none.

- [ ] **Step 1: Run QA checklist Part 6.5 in full**

Follow `docs/admin-booking-qa-checklist.md`'s new Part 6.5 exactly as written, using two real accounts (one admin, one not). Confirm every checkbox passes.

- [ ] **Step 2: Run QA checklist Part 8 in full**

Follow the new Part 8 exactly as written. Confirm every checkbox passes.

- [ ] **Step 3: Verify the bump path still locks self-cancel too**

The existing bump path (editing a booking into an occupied slot) also sets
`last_edited_by` on the *bumped* booking, via `admin_edit_booking` — confirm
the new lock covers that path too, not just direct edits/cancels: as
admin, create a booking, bump a conflicting one via Edit, then confirm the
bumped booking's original owner has no Cancel button and gets `0 rows
affected` on a direct `supabase.from('bookings').delete()` attempt for it,
same as Part 6.5's check.

- [ ] **Step 4: Verify an untouched booking is completely unaffected**

As a non-admin user with a booking that has never been edited or cancelled
by an admin, confirm self-cancel still works exactly as it did before this
feature — no behavior change for the common case.

- [ ] **Step 5: Verify realtime propagation for the direct-cancel path specifically**

With two browser tabs open as two different users (one admin, one not),
have the admin directly cancel (not bump) a booking owned by the other
user. Confirm the non-admin tab updates within a second or two without a
manual refresh — this is the one path (Task 5) that doesn't reuse any
existing tested realtime flow verbatim, so it's worth its own explicit
check.

This task ends the plan — no commit needed since no files change.
