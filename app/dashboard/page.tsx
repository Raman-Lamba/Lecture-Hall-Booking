"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { computeBookingRange } from "@/lib/time";
import { serverNow, serverNowSync } from "@/lib/serverClock";
import BookingModal from "@/components/BookingModal";
import CurrentBookings from "@/components/CurrentBookings";
import type { Room, Booking, RoomStatus } from "@/types";

// 3D scene uses browser-only APIs (WebGL), so load it client-side only
const Building3D = dynamic(() => import("@/components/Building3D"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[520px] blueprint-card flex items-center justify-center font-mono text-sm text-ink/60">
      Loading 3D model...
    </div>
  ),
});

// Local calendar date, not UTC -- toISOString() would roll back to the
// previous day for any positive UTC-offset timezone (e.g. India, UTC+5:30)
// between midnight and the offset boundary.
function dateStr(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function todayStr() {
  return dateStr(new Date());
}

function roundedTimeStr(base: Date, offsetHours = 0) {
  const d = new Date(base);
  d.setHours(d.getHours() + offsetHours, 0, 0, 0);
  return d.toTimeString().slice(0, 5);
}

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [windowBookings, setWindowBookings] = useState<Booking[]>([]);
  const [currentBookings, setCurrentBookings] = useState<Booking[]>([]);

  const [date, setDate] = useState(todayStr());
  const [startTime, setStartTime] = useState(roundedTimeStr(new Date(), 0));
  const [endTime, setEndTime] = useState(roundedTimeStr(new Date(), 1));
  const dateTimeTouchedRef = useRef(false);

  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);

  // Correct the default date/time window against the server's clock once
  // on mount, in case the device's system clock is wrong (not just its
  // timezone, which dateStr()/todayStr() already handle correctly).
  useEffect(() => {
    serverNow().then((now) => {
      if (dateTimeTouchedRef.current) return;
      setDate(dateStr(now));
      setStartTime(roundedTimeStr(now, 0));
      setEndTime(roundedTimeStr(now, 1));
    });
  }, []);

  // --- Auth guard ---
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        router.replace("/login");
      } else {
        setSession(data.session);
      }
      setCheckingAuth(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, sess) => {
        setSession(sess);
        if (!sess) router.replace("/login");
      }
    );
    return () => listener.subscription.unsubscribe();
  }, [router]);

  // --- Load rooms once ---
  useEffect(() => {
    supabase
      .from("rooms")
      .select("*")
      .order("floor", { ascending: true })
      .order("pos_x", { ascending: true })
      .then(({ data, error }) => {
        if (error) console.error("Failed to load rooms:", error.message);
        if (data) setRooms(data as Room[]);
      });
  }, []);

  // --- Fetch bookings overlapping the currently selected window ---
  const fetchWindowBookings = useCallback(async () => {
    if (!date || !startTime || !endTime) return;
    const { startISO, endISO } = computeBookingRange(date, startTime, endTime);

    const { data } = await supabase
      .from("bookings")
      .select("*")
      .lt("start_time", endISO)
      .gt("end_time", startISO);

    if (data) setWindowBookings(data as Booking[]);
  }, [date, startTime, endTime]);

  useEffect(() => {
    fetchWindowBookings();
  }, [fetchWindowBookings]);

  // --- Fetch every user's current/upcoming bookings, soonest first ---
  // Filtered server-side against Postgres' now(), not the device's clock.
  const fetchCurrentBookings = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_current_bookings");
    if (error) console.error("Failed to load current bookings:", error.message);
    if (data) setCurrentBookings(data as Booking[]);
  }, []);

  useEffect(() => {
    fetchCurrentBookings();
  }, [fetchCurrentBookings]);

  // --- Realtime: refresh both views whenever ANY user's booking changes ---
  useEffect(() => {
    const channel = supabase
      .channel("bookings-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "bookings" },
        () => {
          fetchWindowBookings();
          fetchCurrentBookings();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchWindowBookings, fetchCurrentBookings]);

  // --- Clock-driven refresh: room colors (upcoming -> booked -> available
  // again), the current-bookings list, and (if the filters are still at
  // their auto-derived default) the default window itself all depend on
  // elapsed time, not just on someone creating/canceling a booking --
  // nothing else re-renders this page as time passes. Rather than poll
  // blindly, schedule exactly one wake-up for the next moment something
  // actually changes (server clock): a loaded booking's start_time or
  // end_time, or -- if untouched -- the top of the next hour, since the
  // default window is "now" and would otherwise stay pinned to whichever
  // hour the page happened to load in. This effect re-runs on the fresh
  // data/state and schedules the next wake-up after that.
  useEffect(() => {
    const MAX_DELAY_MS = 24 * 60 * 60 * 1000; // clamp: setTimeout overflows past ~24.8 days
    const now = serverNowSync();
    const nowMs = now.getTime();

    const boundaries: number[] = [];
    for (const b of windowBookings) {
      const start = new Date(b.start_time).getTime();
      const end = new Date(b.end_time).getTime();
      if (start > nowMs) boundaries.push(start);
      if (end > nowMs) boundaries.push(end);
    }
    for (const b of currentBookings) {
      const end = new Date(b.end_time).getTime();
      if (end > nowMs) boundaries.push(end);
    }

    if (!dateTimeTouchedRef.current) {
      const nextHour = new Date(now);
      nextHour.setMinutes(0, 0, 0);
      nextHour.setHours(nextHour.getHours() + 1);
      boundaries.push(nextHour.getTime());
    }

    if (boundaries.length === 0) return;

    const delayMs = Math.min(Math.min(...boundaries) - nowMs, MAX_DELAY_MS) + 250;
    const timeoutId = setTimeout(() => {
      if (!dateTimeTouchedRef.current) {
        serverNow().then((serverTime) => {
          if (dateTimeTouchedRef.current) return; // touched while we were waiting on the RPC
          setDate(dateStr(serverTime));
          setStartTime(roundedTimeStr(serverTime, 0));
          setEndTime(roundedTimeStr(serverTime, 1));
        });
      }
      fetchWindowBookings();
      fetchCurrentBookings();
    }, delayMs);

    return () => clearTimeout(timeoutId);
  }, [windowBookings, currentBookings, fetchWindowBookings, fetchCurrentBookings]);

  function getStatus(room: Room): RoomStatus {
    if (selectedRoom?.id === room.id) return "selected";
    const conflicts = windowBookings.filter((b) => b.room_id === room.id);
    if (conflicts.length === 0) return "available";
    const now = serverNowSync();
    const inProgress = conflicts.some((b) => new Date(b.start_time) <= now);
    return inProgress ? "booked" : "upcoming";
  }

  function handleRoomClick(room: Room) {
    const isBooked = windowBookings.some((b) => b.room_id === room.id);
    if (isBooked) {
      const conflict = windowBookings.find((b) => b.room_id === room.id);
      alert(
        `${room.name} is already booked for this window` +
          (conflict ? `: "${conflict.title}"` : "") +
          ". Try a different time range."
      );
      return;
    }
    setSelectedRoom(room);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  if (checkingAuth) {
    return (
      <main className="min-h-screen flex items-center justify-center font-mono text-sm">
        Checking session...
      </main>
    );
  }

  return (
    <main className="min-h-screen px-4 py-8 md:px-10">
      <header className="flex items-center justify-between mb-8">
        <div>
          <p className="font-mono text-xs tracking-widest text-blueprint">
            IMT Hyderabad
          </p>
          <h1 className="font-mono text-2xl font-semibold">
            Lecture Hall Booking
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-ink/70 hidden sm:inline">
            {session?.user.email}
          </span>
          <button onClick={handleSignOut} className="btn-secondary px-4 py-2 font-mono text-sm">
            Sign out
          </button>
        </div>
      </header>

      <section className="blueprint-card p-4 mb-6 flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs font-mono mb-1 text-ink/70">
            DATE
          </label>
          <input
            type="date"
            value={date}
            min={todayStr()}
            onChange={(e) => {
              dateTimeTouchedRef.current = true;
              setDate(e.target.value);
            }}
            className="blueprint-input px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-xs font-mono mb-1 text-ink/70">
            FROM
          </label>
          <input
            type="time"
            value={startTime}
            onChange={(e) => {
              dateTimeTouchedRef.current = true;
              setStartTime(e.target.value);
            }}
            className="blueprint-input px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-xs font-mono mb-1 text-ink/70">
            TO
          </label>
          <input
            type="time"
            value={endTime}
            onChange={(e) => {
              dateTimeTouchedRef.current = true;
              setEndTime(e.target.value);
            }}
            className="blueprint-input px-3 py-2"
          />
        </div>
        <p className="text-xs text-ink/60 font-mono max-w-xs">
          Room colors below reflect availability for this window. Click any
          green room to book it.
        </p>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <Building3D
          rooms={rooms}
          getStatus={getStatus}
          onRoomClick={handleRoomClick}
        />
        <CurrentBookings
          bookings={currentBookings}
          rooms={rooms}
          currentUserId={session?.user.id ?? ""}
          onChanged={() => {
            fetchCurrentBookings();
            fetchWindowBookings();
          }}
        />
      </div>

      {selectedRoom && session && (
        <BookingModal
          room={selectedRoom}
          defaultDate={date}
          defaultStart={startTime}
          defaultEnd={endTime}
          userId={session.user.id}
          onClose={() => setSelectedRoom(null)}
          onBooked={() => {
            setSelectedRoom(null);
            fetchWindowBookings();
            fetchCurrentBookings();
          }}
        />
      )}
    </main>
  );
}
