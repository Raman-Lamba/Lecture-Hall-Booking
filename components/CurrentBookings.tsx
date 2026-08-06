"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { Booking, Room } from "@/types";

interface CurrentBookingsProps {
  bookings: Booking[];
  rooms: Room[];
  currentUserId: string;
  onChanged: () => void;
}

export default function CurrentBookings({
  bookings,
  rooms,
  currentUserId,
  onChanged,
}: CurrentBookingsProps) {
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  const roomName = (roomId: string) =>
    rooms.find((r) => r.id === roomId)?.name ?? "Unknown room";

  async function cancelBooking(id: string) {
    setCancelingId(id);
    const { error } = await supabase.from("bookings").delete().eq("id", id);
    setCancelingId(null);
    if (!error) onChanged();
  }

  const sorted = [...bookings].sort(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  );

  function formatRange(b: Booking) {
    const start = new Date(b.start_time);
    const end = new Date(b.end_time);
    const sameDay = start.toDateString() === end.toDateString();

    const startStr = start.toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const endStr = sameDay
      ? end.toLocaleTimeString([], { timeStyle: "short" })
      : end.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

    return `${startStr} → ${endStr}`;
  }

  return (
    <div className="blueprint-card p-5">
      <p className="font-mono text-xs tracking-widest text-blueprint mb-3">
        CURRENT BOOKINGS
      </p>

      {sorted.length === 0 ? (
        <p className="text-sm text-ink/60">
          No upcoming bookings — click any available room in the model to
          reserve it.
        </p>
      ) : (
        <ul className="space-y-3">
          {sorted.map((b) => (
            <li
              key={b.id}
              className="flex items-center justify-between border border-ink/20 px-3 py-2"
            >
              <div>
                <p className="font-mono font-medium text-sm">
                  {roomName(b.room_id)} — {b.title}
                </p>
                <p className="text-xs text-ink/60">{formatRange(b)}</p>
                <p className="text-xs text-ink/60">Booked by {b.user_name}</p>
              </div>
              {b.user_id === currentUserId && (
                <button
                  onClick={() => cancelBooking(b.id)}
                  disabled={cancelingId === b.id}
                  className="text-xs font-mono text-booked border border-booked px-2 py-1 hover:bg-booked hover:text-paper disabled:opacity-50"
                >
                  {cancelingId === b.id ? "..." : "Cancel"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
