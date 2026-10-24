// A time in a list, with its date: "Oct 24 14:32". Lists carry the date in
// each row rather than in a divider above a day's rows.

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "Oct 24 14:32", in the viewer's own clock. */
export function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${DAY.format(d)} ${TIME.format(d)}`;
}

/** "October 24, 2026 at 14:32 UTC": the whole of one time, for a record. */
export function fullStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(d);
  return `${date} at ${time} UTC`;
}

/** Whether a time falls on today, in the viewer's own clock. */
export function isToday(iso: string, now = new Date()): boolean {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}
