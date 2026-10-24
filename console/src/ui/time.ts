// Relative time, for tables and for anywhere a timestamp is read rather than
// compared. The exact value belongs in a tooltip beside it.

export function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'Just now';
  if (seconds < 90) return '1 min ago';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 7200) return '1 hour ago';
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours ago`;
  if (seconds < 172800) return 'Yesterday';
  return `${Math.round(seconds / 86400)} days ago`;
}

/**
 * The date and time, as a list row shows it: "Oct 24 14:32", with the year
 * when it is not this one. Lists carry the date in each row rather than under
 * a "Today" or "Yesterday" divider.
 */
export function stamp(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${day(iso, now)} ${time}`;
}

/** The date alone, as a token's expiry: "Jan 22", with the year when it is not this one. */
export function day(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
