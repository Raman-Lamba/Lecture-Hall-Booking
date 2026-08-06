"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { Room } from "@/types";

interface BookingModalProps {
  room: Room;
  defaultDate: string;
  defaultStart: string;
  defaultEnd: string;
  userId: string;
  onClose: () => void;
  onBooked: () => void;
}

// Postgres exclusion constraint violation code
const EXCLUSION_VIOLATION = "23P01";

export default function BookingModal({
  room,
  defaultDate,
  defaultStart,
  defaultEnd,
  userId,
  onClose,
  onBooked,
}: BookingModalProps) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [startTime, setStartTime] = useState(defaultStart);
  const [endTime, setEndTime] = useState(defaultEnd);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const startISO = new Date(`${date}T${startTime}`).toISOString();
    const endISO = new Date(`${date}T${endTime}`).toISOString();

    if (new Date(endISO) <= new Date(startISO)) {
      setError("End time must be after start time.");
      return;
    }
    if (new Date(startISO) < new Date()) {
      setError("You can't book a time in the past.");
      return;
    }

    setLoading(true);
    const { error: insertError } = await supabase.from("bookings").insert({
      room_id: room.id,
      user_id: userId,
      title: title.trim() || `${room.name} booking`,
      start_time: startISO,
      end_time: endISO,
    });
    setLoading(false);

    if (insertError) {
      if (insertError.code === EXCLUSION_VIOLATION) {
        setError(
          `${room.name} is already booked for part of that time window. Pick a different time.`
        );
      } else {
        setError(insertError.message);
      }
      return;
    }

    onBooked();
  }

  return (
    <div className="fixed inset-0 bg-ink/50 flex items-center justify-center z-50 px-4">
      <div className="blueprint-card w-full max-w-md p-6">
        <p className="font-mono text-xs tracking-widest text-blueprint mb-1">
          NEW BOOKING
        </p>
        <h2 className="font-mono text-xl font-semibold mb-5">{room.name}</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Purpose / title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Data Structures Lecture"
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
              {loading ? "Booking..." : "Confirm booking"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
