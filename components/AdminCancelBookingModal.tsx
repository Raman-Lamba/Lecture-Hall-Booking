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

function formatRange(booking: Booking) {
  const start = new Date(booking.start_time);
  const end = new Date(booking.end_time);
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
        <p className="text-sm text-ink/60">
          {roomName} — booked by {booking.user_name}
        </p>
        <p className="text-sm text-ink/60 mb-5">{formatRange(booking)}</p>

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
