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
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [conflicts, setConflicts] = useState<
    { id: string; title: string; user_name: string; start_time: string; end_time: string }[]
  >([]);

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

  return (
    <div className="fixed inset-0 bg-ink/50 flex items-center justify-center z-50 px-4">
      <div className="blueprint-card w-full max-w-md p-6">
        <p className="font-mono text-xs tracking-widest text-blueprint mb-1">
          ADMIN EDIT
        </p>
        <h2 className="font-mono text-xl font-semibold mb-5">{booking.title}</h2>

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
        )}
      </div>
    </div>
  );
}
