function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Turns a single date + start/end time-of-day into a start/end ISO range,
// rolling the end over to the next calendar day when the end time is not
// after the start time (e.g. 23:00 -> 02:00 spans midnight into day+1).
export function computeBookingRange(
  date: string,
  startTime: string,
  endTime: string
) {
  const startISO = new Date(`${date}T${startTime}`).toISOString();
  const crossesMidnight = endTime < startTime;
  const endDate = crossesMidnight ? addDays(date, 1) : date;
  const endISO = new Date(`${endDate}T${endTime}`).toISOString();
  return { startISO, endISO, crossesMidnight };
}
