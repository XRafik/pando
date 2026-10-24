// What the Events tab reads from an app's feed, kept apart from the screen so
// it can be tested without rendering one (R-378).

/** One line of GET /apps/{id}/events. */
export interface FeedItem {
  id: string;
  type: string;
  occurred_at: string;
  subject: string;
  body?: string;
  /** The event described for a person. */
  fields?: FeedField[] | null;
  data?: Record<string, unknown> | null;
  actor: { kind: string; id?: string; on_behalf_of?: string };
  /** The person who acted, or the person a token acted for (R-379). */
  actor_name?: string;
}

export interface FeedField {
  label?: string;
  value?: string;
}

export interface FeedPage {
  events: FeedItem[] | null;
  next_before: string;
}

/** Whether an event is a success, a failure, or neither. Only the first two
 *  carry a symbol: a dot on every line would say nothing. */
export type Outcome = 'success' | 'failure' | null;

const SUCCEEDED = new Set([
  'deploy.succeeded',
  'backup.created',
  'backup.restored',
  'security.recovered',
  'adapter.recovered',
  'pando.upgraded',
]);

const FAILED = new Set(['adapter.unhealthy']);

export function outcomeOf(type: string): Outcome {
  if (SUCCEEDED.has(type)) return 'success';
  if (FAILED.has(type) || /[._]failed$/.test(type)) return 'failure';
  return null;
}

/** A field's label and value, empty where the event left one out. */
export function fieldOf(f: FeedField): { label: string; value: string } {
  return { label: f.label ?? '', value: f.value ?? '' };
}

/** The deployment an event is about, when it names one: deploy.succeeded and
 *  deploy.failed carry `deployment_id`. */
export function deploymentOf(item: FeedItem): string | undefined {
  if (!item.type.startsWith('deploy.')) return undefined;
  const id = item.data?.deployment_id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** Who caused an event, in the Actor column: "You", the person's name as the
 *  feed gives it, Pando for its own work, or an ID when nobody can be named. */
export function actorName(
  actor: FeedItem['actor'],
  me?: { id?: string; user_id?: string },
  name?: string,
): string {
  if (actor.kind === 'system' || !actor.id) return 'Pando';
  if (me && (actor.id === me.id || actor.id === me.user_id)) return 'You';
  return name || actor.id;
}

/** When an event happened, in the Time column: its date and time, such as
 *  "Oct 24 14:32", with the year only when it is not this one. Each row
 *  carries its own date rather than sitting under a divider row per day. */
export function timeOf(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const date = at.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${date} ${time}`;
}

/** Whether a scrolling box is close enough to its end that the next page
 *  should be read. A box with nothing to scroll is at its end. */
export function nearEnd(box: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 200): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack;
}
