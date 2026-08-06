"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import BookingModal from "@/components/BookingModal";
import MyBookings from "@/components/MyBookings";
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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function roundedTimeStr(offsetHours = 0) {
  const d = new Date();
  d.setHours(d.getHours() + offsetHours, 0, 0, 0);
  return d.toTimeString().slice(0, 5);
}

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [windowBookings, setWindowBookings] = useState<Booking[]>([]);
  const [myBookings, setMyBookings] = useState<Booking[]>([]);

  const [date, setDate] = useState(todayStr());
  const [startTime, setStartTime] = useState(roundedTimeStr(0));
  const [endTime, setEndTime] = useState(roundedTimeStr(1));

  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);

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
    const startISO = new Date(`${date}T${startTime}`).toISOString();
    const endISO = new Date(`${date}T${endTime}`).toISOString();

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

  // --- Fetch this user's own upcoming bookings ---
  const fetchMyBookings = useCallback(async () => {
    if (!session) return;
    const { data } = await supabase
      .from("bookings")
      .select("*")
      .eq("user_id", session.user.id)
      .gt("end_time", new Date().toISOString());
    if (data) setMyBookings(data as Booking[]);
  }, [session]);

  useEffect(() => {
    fetchMyBookings();
  }, [fetchMyBookings]);

  // --- Realtime: refresh both views whenever any booking changes ---
  useEffect(() => {
    const channel = supabase
      .channel("bookings-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "bookings" },
        () => {
          fetchWindowBookings();
          fetchMyBookings();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchWindowBookings, fetchMyBookings]);

  function getStatus(room: Room): RoomStatus {
    if (selectedRoom?.id === room.id) return "selected";
    const isBooked = windowBookings.some((b) => b.room_id === room.id);
    return isBooked ? "booked" : "available";
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
            onChange={(e) => setDate(e.target.value)}
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
            onChange={(e) => setStartTime(e.target.value)}
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
            onChange={(e) => setEndTime(e.target.value)}
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
        <MyBookings
          bookings={myBookings}
          rooms={rooms}
          onChanged={() => {
            fetchMyBookings();
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
            fetchMyBookings();
          }}
        />
      )}
    </main>
  );
}
