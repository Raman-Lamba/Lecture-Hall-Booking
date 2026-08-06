# Lecture Hall Booking System

A multi-user booking system for LT1–LT9 and CR1–CR2, visualized as an
interactive 3D building matching the real floor plan (Ground: LT1-3 +
CR1-2, 1st floor: LT4-6, 2nd floor: LT7-9).

**Stack:** Next.js 14 + React Three Fiber (3D) + Supabase (Postgres, Auth,
Realtime) + Tailwind CSS. Deploys free on Vercel + Supabase.

---

## 1. Set up the database

1. Open your Supabase project → **SQL Editor**.
2. Paste the entire contents of `schema.sql` (in this folder) and run it.
   This creates the `rooms` and `bookings` tables, seeds all 11 rooms in
   their correct floor plan positions, and adds the overlap-prevention
   constraint that makes double-booking impossible.
3. Go to **Authentication → Providers** and make sure **Email** is enabled
   (it is by default). Optionally, under **Authentication → Settings**,
   turn off "Confirm email" while testing so you can sign up and log in
   immediately without checking an inbox.

## 2. Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:3000 — you'll be redirected to `/signup`. Your
`.env.local` is already filled in with your Supabase URL and anon key.

## 3. How the core pieces work

- **3D building** (`components/Building3D.tsx`, `RoomBox.tsx`): renders
  each room as a labeled box positioned by its `floor` and `pos_x` from
  the database — so the 3D layout always matches the real building.
- **Availability colors**: pick a date + time window at the top of the
  dashboard; rooms turn red if any booking overlaps that window, green if
  free. Click a green room to book it.
- **No double-booking, ever**: this isn't checked in JavaScript — it's a
  Postgres `EXCLUDE` constraint (see `schema.sql`) that makes it physically
  impossible for two overlapping bookings to exist for the same room, even
  if two users click "Confirm" at the exact same instant. The second
  request gets a database error, which the UI catches and shows as
  "already booked."
- **Realtime**: all connected users see room colors update live via
  Supabase Realtime — good for a class demo (book on one screen, watch it
  turn red on another).

## 4. Deploy for free

1. Push this project to a GitHub repo.
2. Go to [vercel.com](https://vercel.com) → sign up free with GitHub →
   **New Project** → import your repo.
3. In the Vercel project's **Environment Variables**, add:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   (same values as your `.env.local`)
4. Click **Deploy**. You'll get a free `.vercel.app` URL.

## 5. For your presentation

- Open the app on two browser windows (or your laptop + phone) side by
  side, sign in as two different users, and book the same room at the
  same time in both — one will succeed, the other will get the "already
  booked" error instantly. This is the best way to demo the concurrency
  guarantee live.
- The 3D model responds to drag (orbit) and scroll (zoom) — good for
  showing off the floor mapping matches the real building.

## Project structure

```
app/
  page.tsx              → redirects to /login or /dashboard
  login/, signup/        → auth pages
  dashboard/page.tsx     → main app: 3D view + time selector + my bookings
components/
  Building3D.tsx         → 3D scene, floors, camera
  RoomBox.tsx             → single room mesh, hover/click/status color
  BookingModal.tsx        → booking form + conflict handling
  MyBookings.tsx          → user's upcoming bookings + cancel
lib/supabase/client.ts   → Supabase client setup
types/index.ts            → shared TypeScript types
schema.sql                 → full database schema (run this first)
```
