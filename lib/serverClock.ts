import { supabase } from "@/lib/supabase/client";

let cachedOffsetMs = 0;
let offsetMsPromise: Promise<number> | null = null;

// A device's clock can be wrong (bad timezone, drift, manually set). This
// fetches Postgres' now() once per session and caches the delta from the
// local clock, so `serverNow()` gives a server-accurate time without a
// round trip on every call.
async function fetchClockOffsetMs(): Promise<number> {
  const { data, error } = await supabase.rpc("get_server_time");
  if (error || !data) return 0;
  const offset = new Date(data as string).getTime() - Date.now();
  cachedOffsetMs = offset;
  return offset;
}

function getClockOffsetMs(): Promise<number> {
  if (!offsetMsPromise) {
    offsetMsPromise = fetchClockOffsetMs();
  }
  return offsetMsPromise;
}

export async function serverNow(): Promise<Date> {
  const offset = await getClockOffsetMs();
  return new Date(Date.now() + offset);
}

// Kicks off the one-time offset fetch without waiting on it.
export function primeServerClock(): void {
  void getClockOffsetMs();
}

// Best-effort synchronous "now", for use in render-time logic that can't
// await. Uses the device clock until primeServerClock()'s fetch resolves,
// then the server-corrected offset from then on.
export function serverNowSync(): Date {
  return new Date(Date.now() + cachedOffsetMs);
}
