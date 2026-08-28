# Admin Booking Override — QA Checklist

Manual test checklist for the admin booking-override feature (edit/reschedule
any booking, with a required reason visible to everyone). No coding
knowledge needed — just an @imthyderabad.edu.in account and a browser.

Run the app at whatever URL the developer gives you (local: `http://localhost:3000`,
or a deployed URL). For each item, check it off and note pass/fail — if
something fails, write down exactly what you did and what happened instead
of what's expected.

## Setup

- [ ] You have at least one @imthyderabad.edu.in account signed up. Two
      accounts is better (lets you test as both an admin and a normal
      member, and see another person's name on a booking) but one account
      is enough to test most of this.

## Part 1 — As a normal (non-admin) user

- [ ] Log in with an account that has **not** been promoted to admin.
- [ ] Look at "Current Bookings" — confirm there is **no "Edit" button**
      anywhere, including on bookings you made yourself.
- [ ] Try to book a room/time. Confirm normal booking still works exactly
      like before (title, date, start/end time, confirm).
- [ ] Try to cancel a booking you made. Confirm it still works.
- [ ] Open the browser console (F12 → Console tab) and paste this, then
      press Enter:
  ```js
  (async () => {
    const { data, error } = await supabase.rpc('admin_edit_booking', {
      p_booking_id: '00000000-0000-0000-0000-000000000000',
      p_room_id: '00000000-0000-0000-0000-000000000000',
      p_title: 'x',
      p_start_time: new Date().toISOString(),
      p_end_time: new Date(Date.now() + 3600000).toISOString(),
      p_reason: 'test',
    });
    console.log({ data, error });
  })();
  ```
  Expected: `error` is set with a message like "Only admins can edit other
  bookings"; `data` is `null`. **This confirms a non-admin cannot bypass
  the UI and call the admin function directly.**

  If `supabase` isn't defined in your console, ask the developer to add
  this one temporary line to `lib/supabase/client.ts`, right after the
  `export const supabase = createClient(...)` block, restart the dev
  server, and remove it again after testing is done:
  ```ts
  if (typeof window !== "undefined") (window as any).supabase = supabase;
  ```

- [ ] While you're in the console (same account, still not promoted to
      admin), also confirm the RPC's server-side reason check by leaving
      `p_reason` empty/whitespace — paste this:
  ```js
  (async () => {
    const { data, error } = await supabase.rpc('admin_edit_booking', {
      p_booking_id: '00000000-0000-0000-0000-000000000000',
      p_room_id: '00000000-0000-0000-0000-000000000000',
      p_title: 'x',
      p_start_time: new Date().toISOString(),
      p_end_time: new Date(Date.now() + 3600000).toISOString(),
      p_reason: '   ',
    });
    console.log({ data, error });
  })();
  ```
  Expected: `error` is set (either the "Only admins..." message, since
  this account isn't an admin, or — if you happen to be testing this as
  an already-promoted admin — "A reason is required"). Either way, `data`
  is `null`. **This confirms the reason requirement is enforced by the
  database itself, not just by graying out the Save button in the UI.**

## Part 2 — Getting promoted to admin

(Someone with Supabase dashboard access needs to run one SQL statement to
promote your account — ask the developer to do this for you, or do it
yourself if you have access:)

```sql
update public.profiles set role = 'admin'
where id = (select id from auth.users where email = 'YOUR_EMAIL_HERE');
```

- [ ] After promotion, **log out and back in** (or refresh the page).
- [ ] Confirm you now see an **"Edit" button** on every booking in Current
      Bookings, including bookings made by other people.

## Part 3 — Admin edit (no conflict)

- [ ] Click **Edit** on any booking (ideally one made by someone else, or
      one of your own if that's all you have).
- [ ] Change the title, date, or time to something with **no overlap**
      with any other booking.
- [ ] Try to save with the **Reason field left empty** — confirm it's
      blocked with a message like "A reason is required" and nothing is
      saved (no network activity, no change).
- [ ] Now fill in a reason (e.g. "testing") and save.
- [ ] Confirm the booking updates to the new room/time/title, and now
      shows a line like `Rescheduled by admin — "testing"`.
- [ ] If you have a second browser tab (or a second device) logged in as
      a different user, confirm it updates there too within a second or
      two, without needing a manual refresh.

## Part 4 — Admin bump (edit into an occupied slot)

- [ ] Create **Booking A**: pick a room, e.g. 2:00–3:00 PM.
- [ ] Create **Booking B**: same room, a different time that does NOT
      overlap, e.g. 4:00–5:00 PM. (Can be the same account for both.)
- [ ] Click **Edit** on Booking B. Change its time to overlap Booking A
      (e.g. 2:30–3:30 PM). Enter a reason. Save.
- [ ] Expected: instead of saving immediately, you see a **confirmation
      screen** listing Booking A as a conflict, with a button like "Bump
      conflicting booking & save".
- [ ] Click **Back** instead of confirming. Confirm you land back on the
      edit form with the room/title/date/time/reason you'd already typed
      still filled in (nothing reset), and confirm nothing was actually
      saved — Booking A and Booking B are both unchanged (check Current
      Bookings or refresh).
- [ ] Re-enter the overlapping time (or just click Save again if your
      changes are still there) to get back to the confirmation screen,
      then click **"Bump conflicting booking & save"**.
- [ ] Confirm:
  - Booking A now shows **struck through**, with a badge like
    "CANCELLED BY ADMIN" and your reason.
  - Booking B now shows in its **new time** with "Rescheduled by admin"
    and the same reason.
- [ ] If you have a second browser tab (or a second device) logged in as
      a different user, confirm the bump — Booking A's cancellation and
      Booking B's new time — shows up there too within a second or two,
      without needing a manual refresh (not just a plain edit — the bump
      case specifically).
- [ ] Try booking Booking A's **original time slot** again (same room,
      same original time). It should succeed — the slot should be free,
      even though Booking A's row is still visible (struck through) in
      the list.

## Part 5 — Cancelled bookings disappear on their own

- [ ] Find a struck-through (cancelled) booking from Part 4. Note its
      original end time.
- [ ] Either wait until that time passes, or (if you have SQL access) run:
  ```sql
  update bookings set end_time = now() - interval '1 minute'
  where id = '<that booking's id>';
  ```
- [ ] Refresh Current Bookings. Confirm the cancelled booking has
      **disappeared** from the list on its own — no manual cleanup needed.

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

## Part 6 — Non-admin still can't touch role/admin status

- [ ] Log back in as a non-admin account (or use one you didn't promote).
- [ ] Open the browser console and paste:
  ```js
  (async () => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('profiles').update({ role: 'admin' }).eq('id', user.id).select();
    console.log({ data, error });
  })();
  ```
- [ ] Expected: `data` is an empty array `[]`, `error` is `null` — the
      update silently affects zero rows. Confirm you still don't have an
      Edit button after this (i.e. you did NOT actually become an admin).

  If `supabase` isn't defined in your console, ask the developer to add
  this one temporary line to `lib/supabase/client.ts`, right after the
  `export const supabase = createClient(...)` block, restart the dev
  server, and remove it again after testing is done:
  ```ts
  if (typeof window !== "undefined") (window as any).supabase = supabase;
  ```

- [ ] Still as this non-admin account, pick any existing booking (yours or
      someone else's — grab its id from Current Bookings, e.g. from the
      network tab, or ask the developer for one) and try to edit it
      directly, bypassing the UI entirely:
  ```js
  (async () => {
    const { data, error } = await supabase
      .from('bookings')
      .update({ title: 'hacked by non-admin' })
      .eq('id', 'PASTE_A_BOOKING_ID_HERE')
      .select();
    console.log({ data, error });
  })();
  ```
  Expected: `data` is an empty array `[]` (or `error` is set) — the update
  affects zero rows. Confirm the booking's title is unchanged in Current
  Bookings. **This confirms a non-admin cannot edit bookings via a direct
  API call even though they lack an Edit button in the UI.**

## Part 7 — Pre-existing bookings still work

- [ ] Find (or create, then treat as "pre-existing" for this check) a
      booking that has no admin-edit history — i.e. it has never shown a
      "Rescheduled by admin" or "CANCELLED BY ADMIN" line.
- [ ] Confirm it still displays normally in Current Bookings (title, room,
      time, booked-by name), with no edit/bump badge.
- [ ] As the account that made it, confirm you can still **self-cancel**
      it exactly as before (no admin involvement needed).

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

---

## Reporting results

For each part above, note: **Pass** / **Fail**, and for any Fail, exactly
what you did and what happened instead of the expected result. Send that
back so it can be fixed before this ships.
