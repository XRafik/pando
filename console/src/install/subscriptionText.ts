// What the Events screen says about a subscription, in words: its name, what
// it sends, where, and whether it is on. Apart from the screen so each can be
// tested without one.

export interface EventDef {
  name: string;
  scope: 'app' | 'install';
  summary: string;
  fields: { name: string; description: string }[];
}

export interface Destination {
  id: string;
  name?: string;
  kind: string;
  audience: 'people' | 'channel';
  /** A subscription to it names a channel: Slack. */
  channels?: boolean;
}

export interface Subscription {
  id: string;
  owner_id: string;
  owner_name?: string;
  app_id?: string;
  app_name?: string;
  events: string[];
  destination: 'webhook' | 'notify';
  channel?: string;
  url?: string;
  adapter_id?: string;
  description: string;
  enabled: boolean;
  disabled_reason?: string;
  consecutive_failures: number;
  last_delivery_at?: string;
  created_at: string;
  signing_key?: string;
  owner_token_id?: string;
  method?: string;
  content_type?: string;
  payload_template?: string;
  header_names?: string[];
}

const KIND_NAMES: Record<string, string> = {
  console: 'Console',
  smtp: 'Email',
  slack: 'Slack',
  teams: 'Teams',
  discord: 'Discord',
  ntfy: 'ntfy',
};

function kindName(kind: string): string {
  return KIND_NAMES[kind] ?? kind;
}

/** What each group of events is about, by the prefix of their names. */
const GROUPS: Record<string, string> = {
  app: 'Apps',
  deploy: 'Deployments',
  security: 'Security',
  grant: 'Access',
  backup: 'Backups',
  policy: 'Policy',
  user: 'Accounts',
  token: 'Tokens',
  adapter: 'Adapters',
  pando: 'Upgrades',
  subscription: 'Subscriptions',
};

export function groupName(prefix: string): string {
  return GROUPS[prefix] ?? prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

/** Event names grouped by what they are about, in catalog order. */
export function groupsOf(catalog: readonly EventDef[]): [string, EventDef[]][] {
  const groups = new Map<string, EventDef[]>();
  for (const e of catalog) {
    const prefix = e.name.split('.')[0] ?? e.name;
    groups.set(prefix, [...(groups.get(prefix) ?? []), e]);
  }
  return [...groups.entries()];
}

/** One event's name in words: deploy.failed is "deploy failed". */
function eventWords(name: string): string {
  return name.replace('.', ' ').replaceAll('_', ' ');
}

/**
 * What a subscription sends, in a few words: "Everything", "Deployments,
 * security", "Deploy failed, backup failed". Past three it says how many more.
 */
export function eventsSummary(events: readonly string[]): string {
  if (events.includes('*')) return 'Everything';
  if (events.length === 0) return 'Nothing';
  const parts = events.map((e) => (e.endsWith('.*') ? groupName(e.slice(0, -2)) : eventWords(e)));
  const shown = parts.length > 3 ? [...parts.slice(0, 2), `${parts.length - 2} more`] : parts;
  const text = shown.map((p, i) => (i === 0 ? p : p.toLowerCase())).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Its name: the description it was given, or what it sends. */
export function subscriptionName(s: Pick<Subscription, 'description' | 'events'>): string {
  return (s.description ?? '').trim() || eventsSummary(s.events);
}

export function scopeName(s: Pick<Subscription, 'app_id' | 'app_name'>): string {
  return s.app_id ? s.app_name || s.app_id : 'Installation';
}

/** Where it sends: the kind of destination, and the address or channel. */
export function destinationOf(
  s: Pick<Subscription, 'destination' | 'url' | 'adapter_id' | 'channel'>,
  destinations: readonly Pick<Destination, 'id' | 'kind'>[],
): { kind: string; target?: string } {
  if (s.destination === 'webhook') return { kind: 'Webhook', target: s.url?.replace(/^https?:\/\//, '') };
  const d = destinations.find((x) => x.id === s.adapter_id);
  return { kind: d ? kindName(d.kind) : (s.adapter_id ?? 'Notification'), target: s.channel || undefined };
}

/** A destination in the Send to list. */
export function destinationLabel(d: Destination, all: readonly Destination[]): string {
  const base = d.name && d.name.toLowerCase() !== d.kind ? `${kindName(d.kind)} · ${d.name}` : kindName(d.kind);
  const twin = all.some((x) => x.id !== d.id && x.kind === d.kind && (x.name ?? '') === (d.name ?? ''));
  return twin ? `${base} (${d.id})` : base;
}

export type SubscriptionState = 'on' | 'failing' | 'off';

export function stateOf(s: Pick<Subscription, 'enabled' | 'consecutive_failures'>): SubscriptionState {
  if (!s.enabled) return 'off';
  return s.consecutive_failures > 0 ? 'failing' : 'on';
}

export const STATE_NAMES: Record<SubscriptionState, string> = { on: 'On', failing: 'Failing', off: 'Off' };

/** How a webhook is sent, in a line: "POST · JSON". */
export function requestLine(s: Pick<Subscription, 'method' | 'content_type' | 'payload_template' | 'header_names'>): string {
  const type = s.content_type || 'application/json';
  const parts = [s.method || 'POST', type === 'application/json' ? 'JSON' : type];
  const headers = s.header_names?.length ?? 0;
  if (headers > 0) parts.push(headers === 1 ? '1 header' : `${headers} headers`);
  if (s.payload_template) parts.push('Custom body');
  return parts.join(' · ');
}

export interface SubscriptionFilters {
  search: string;
  /** "install" or an app's ID. */
  scope: string[];
  /** Destination kinds, as kindName gives them. */
  destination: string[];
  status: SubscriptionState[];
}

export const NO_FILTERS: SubscriptionFilters = { search: '', scope: [], destination: [], status: [] };

/** The subscriptions the filter row keeps. */
export function filterSubscriptions(
  rows: readonly Subscription[],
  f: SubscriptionFilters,
  destinations: readonly Destination[],
): Subscription[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((s) => {
    const to = destinationOf(s, destinations);
    if (f.scope.length > 0 && !f.scope.includes(s.app_id || 'install')) return false;
    if (f.destination.length > 0 && !f.destination.includes(to.kind)) return false;
    if (f.status.length > 0 && !f.status.includes(stateOf(s))) return false;
    if (!q) return true;
    return [subscriptionName(s), scopeName(s), eventsSummary(s.events), to.kind, to.target ?? '', ...s.events].some((t) =>
      t.toLowerCase().includes(q),
    );
  });
}

/** One of each value present, in first-seen order, for a filter's checklist. */
export function optionsOf(rows: readonly Subscription[], destinations: readonly Destination[]) {
  const scopes = new Map<string, string>();
  const kinds = new Set<string>();
  for (const s of rows) {
    scopes.set(s.app_id || 'install', scopeName(s));
    kinds.add(destinationOf(s, destinations).kind);
  }
  return {
    scope: [...scopes].map(([value, label]) => ({ value, label })),
    destination: [...kinds].map((k) => ({ value: k, label: k })),
  };
}

export interface Delivery {
  id: string;
  event_id: string;
  event: string;
  status: 'pending' | 'succeeded' | 'failed';
  attempts: number;
  next_attempt_at?: string;
  last_status_code?: number;
  last_error?: string;
  created_at: string;
  attempt_log?: {
    attempt: number;
    attempted_at: string;
    status_code?: number;
    error?: string;
    duration_ms: number;
  }[];
  payload?: unknown;
}

/** What became of a delivery, in a word: its answer, or that it is still trying. */
export function deliveryResult(d: Pick<Delivery, 'status' | 'attempts' | 'last_status_code'>): string {
  if (d.status === 'pending') return d.attempts > 0 ? 'Retrying' : 'Sending';
  if (d.last_status_code) return String(d.last_status_code);
  return d.status === 'succeeded' ? 'Delivered' : 'Failed';
}

/** One attempt, in a line: "1 · 14:30:02 · 503 · 1.2 s". */
export function attemptLine(a: NonNullable<Delivery['attempt_log']>[number]): string {
  const at = new Date(a.attempted_at).toLocaleTimeString('en-US', { hourCycle: 'h23' });
  const took = a.duration_ms < 1000 ? `${a.duration_ms} ms` : `${(a.duration_ms / 1000).toFixed(1)} s`;
  return [String(a.attempt), at, a.status_code ? String(a.status_code) : 'No answer', took].join(' · ');
}
