// The audit log (R-227, R-379): each event as a sentence, with the raw action
// under it for whoever searches by it, its actor, and its time with its date.
// One row of filters, each a button that opens a small popover; a row opens
// the event's whole record in a side panel, a screen of its own at phone
// width.
//
// The sentence is the server's (`summary`, made in core), so the console, the
// CLI and MCP read an event the same way.

import { useEffect, useId, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button, EmptyState, Icon, IconButton, Input, Radio, Select, StatusIndicator, Tooltip } from '@design';

import { api, base } from '@api/client';
import { useAIFunctionOn } from './AIFunctions';
import { ActorField } from './ActorField';
import type { Person } from './ActorField';
import { AuditAI } from './AuditAI';
import { ARCHIVES_ANCHOR, AuditSinkLine, AuditSinks } from './AuditSinks';
import { Quiet, Screen, messageOf } from './Accounts';
import { NO_FILTERS, WHEN, auditQuery, filtersFromSearch } from './audit';
import type { AuditFilters } from './audit';
import { AIButton } from '../ui/AskAI';
import { useCloseOnOutside } from '../ui/combobox';
import { copyOrSelect } from '../ui/CopyField';
import { useNarrow } from '../ui/narrow';
import { useSettled } from '../ui/paged';
import { useNamedPeople } from '../ui/people';
import { SearchField } from '../ui/SearchField';
import { Table } from '../ui/Table';
import { fullStamp, stamp } from './stamp';
import '../ui/panel.css';
import './system.css';

export interface AuditRecord {
  id: number;
  occurred_at: string;
  principal_kind: string;
  principal_id?: string;
  on_behalf_of?: string;
  action: string;
  app_id?: string;
  target_kind?: string;
  target_id?: string;
  request_id?: string;
  detail?: Record<string, unknown>;
  // What R-379 adds. Absent on events written before it.
  /** success, denied or failed. */
  outcome?: string;
  /** The client's address, from the trusted forwarding chain. */
  source_ip?: string;
  /** The address the connection came from: the proxy in front, if any. */
  peer_ip?: string;
  user_agent?: string;
  /** The actor's name and email when the event was written, so an account
   *  deleted since still reads as who it was. */
  actor_name?: string;
  actor_email?: string;
  schema_version?: number;
  /** The event in plain words, such as "Deployed crewmate"; the action when
   *  Pando has no wording for it. Absent from a server before it. */
  summary?: string;
  /** The names the app and the target go by now. */
  app_name?: string;
  target_name?: string;
}

// The kinds of thing the server records events against.
const TARGET_KINDS = [
  'app',
  'user',
  'group',
  'role',
  'grant',
  'token',
  'session',
  'secret',
  'backup',
  'deployment',
  'policy',
  'adapter',
  'volume',
  'slot',
  'spec_revision',
  'workload',
  'launcher_section',
];

const OUTCOMES = [
  { value: '', label: 'Any' },
  { value: 'success', label: 'Succeeded' },
  { value: 'denied', label: 'Denied' },
  { value: 'failed', label: 'Failed' },
];

/** The audit log, paged on the server's cursor, for one set of filters. */
export function useAuditLog(filters: AuditFilters) {
  // Pages on the server's cursor (design 04 §2.8): "Load older events" asks
  // for the page before the last one shown, so events arriving meanwhile never
  // shift what has already been read.
  const log = useInfiniteQuery({
    queryKey: ['audit', filters],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api.get<{ events: AuditRecord[] | null; next_before: string }>('/audit' + auditQuery(filters, pageParam || undefined)),
    getNextPageParam: (last) => last.next_before || undefined,
  });
  const events = log.data?.pages.flatMap((p) => p.events ?? []) ?? [];
  return { log, events };
}

/** Names for the actor column and the actor pickers: the accounts the events
 *  on screen and the chosen filters name, asked about by ID (issue #72).
 *  install.audit.read does not imply install.view, so when the lookup is
 *  refused, the pickers take an ID and the column shows IDs. */
function usePeople(events: AuditRecord[], chosen: string[] = []): Person[] {
  return useNamedPeople([
    ...chosen,
    ...events.flatMap((e) => [e.principal_id, e.on_behalf_of, e.target_kind === 'user' ? e.target_id : undefined]),
  ]);
}

/** Who did it, by the name the event recorded (R-379), and the person a
 *  delegated token acted for (R-229). */
function actorText(row: AuditRecord, people: Person[]): string {
  const nameOf = (id?: string) => (id ? (people.find((u) => u.id === id)?.external_id ?? id) : '');
  const actor = row.actor_name || nameOf(row.principal_id);
  if (row.on_behalf_of && row.on_behalf_of !== row.principal_id) return `${actor} for ${nameOf(row.on_behalf_of)}`;
  if (actor) return actor;
  if (row.principal_kind === 'anonymous') return 'Anonymous visitor';
  return row.principal_kind === 'system' ? 'Pando' : row.principal_kind;
}

/** What it was done to: "app crewmate", "user dana". */
function targetText(row: AuditRecord, people: Person[]): string {
  if (!row.target_id) return row.app_name || row.app_id || '';
  const name =
    row.target_name ||
    (row.target_kind === 'user' ? (people.find((u) => u.id === row.target_id)?.external_id ?? row.target_id) : row.target_id);
  return row.target_kind ? `${row.target_kind} ${name}` : name;
}

export function Audit({
  initial = NO_FILTERS,
  onFilters,
  onAdapters,
  adaptersHref,
}: Readonly<{
  /** Filters carried in from a link, such as an account's page. */
  initial?: AuditFilters;
  /** Told of every change, so the address bar can hold the filters and a
   *  reload or a copied link shows the same events. */
  onFilters?: (f: AuditFilters) => void;
  /** Opens Adapters, where audit sinks are configured. */
  onAdapters?: () => void;
  adaptersHref?: string;
}>) {
  const [filters, setFilters] = useState<AuditFilters>(initial);
  const change = (next: AuditFilters) => {
    setFilters(next);
    onFilters?.(next);
  };
  const set = (patch: Partial<AuditFilters>) => change({ ...filters, ...patch });
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);

  // The search box asks the server once typing stops.
  const [text, setText] = useState(initial.q);
  const settled = useSettled(text);
  useEffect(() => {
    if (settled.trim() !== filters.q) set({ q: settled.trim() });
  }, [settled]);

  const { log, events } = useAuditLog(filters);
  const people = usePeople(events, [filters.actor, filters.involving]);
  const [open, setOpen] = useState<AuditRecord | null>(null);

  // Asking a question with AI (R-345), behind one button. Its answer becomes
  // the filters, where it can be read and changed.
  const searchOn = useAIFunctionOn('search_audit');
  const [asking, setAsking] = useState(false);

  return (
    <Screen
      heading="Audit log"
      action={
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)' }}>
          {/* R-385: every copy of this log that leaves the installation, said
              where the log is read. */}
          <AuditSinkLine onAdapters={onAdapters} href={adaptersHref} />
          {searchOn && <AIButton onClick={() => setAsking(true)} />}
        </span>
      }
    >
      {asking && <AuditAI onClose={() => setAsking(false)} onShow={(f) => change(filtersFromSearch(f))} />}
      <AuditSinks />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        <SearchField value={text} onChange={setText} placeholder="Search events" width="28ch" />
        <Filters filters={filters} set={set} people={people} />
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setText('');
              change(NO_FILTERS);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {log.isError && <Quiet>{messageOf(log.error)}</Quiet>}

      <AuditTable
        events={events}
        people={people}
        loading={log.isPending}
        onOpen={setOpen}
        // A filter that matches nothing and a log that holds nothing look
        // identical as an empty table, and they are very different answers.
        empty={
          <EmptyState heading={filtered ? 'No matching events' : 'No events recorded'}>
            {filtered && filters.action ? 'Action is a prefix match: app. matches every app event.' : null}
          </EmptyState>
        }
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
        <LoadOlder log={log} />
        <ArchivedMonths />
      </div>

      {open && (
        <AuditPanel
          event={open}
          people={people}
          onClose={() => setOpen(null)}
          onActor={(actor) => {
            setOpen(null);
            change({ ...NO_FILTERS, actor });
          }}
        />
      )}
    </Screen>
  );
}

/** The filters past the search box: each a button naming what it narrows,
 *  with how many it is narrowed to, opening a small popover. */
function Filters({
  filters,
  set,
  people,
}: Readonly<{ filters: AuditFilters; set: (patch: Partial<AuditFilters>) => void; people: Person[] }>) {
  const when = WHEN.find((w) => w.value === filters.when)?.label ?? 'All time';
  const count = (...vs: string[]) => vs.filter(Boolean).length;
  return (
    <>
      <FilterButton label={when} active={filters.when !== ''}>
        <div role="radiogroup" aria-label="Time range" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {WHEN.map((w) => (
            <Radio
              key={w.value || 'all'}
              name="audit-when"
              value={w.value}
              label={w.label}
              checked={filters.when === w.value}
              onChange={() => set({ when: w.value, ...(w.value === 'custom' ? {} : { since: '', until: '' }) })}
            />
          ))}
        </div>
        {filters.when === 'custom' && (
          <>
            <Input label="From" type="datetime-local" value={filters.since} onChange={(e) => set({ since: e.target.value })} />
            <Input label="To" type="datetime-local" value={filters.until} onChange={(e) => set({ until: e.target.value })} />
          </>
        )}
      </FilterButton>

      <FilterButton label="Actor" count={count(filters.actor, filters.involving)}>
        {/* Typed, not picked from a list: an installation has too many
            accounts for a dropdown. Without install.view it takes an ID. */}
        <ActorField people={people} value={filters.actor} onChange={(actor) => set({ actor })} />
        {/* The one filter that is an OR: what an account's page links with. */}
        <ActorField label="Actor or target" pando={false} people={people} value={filters.involving} onChange={(involving) => set({ involving })} />
      </FilterButton>

      <FilterButton label="Action" count={count(filters.action)}>
        <Input
          label="Action"
          mono
          value={filters.action}
          placeholder="app."
          helper="A prefix. Separate several with commas."
          onChange={(e) => set({ action: e.target.value })}
        />
      </FilterButton>

      <FilterButton label="App" count={count(filters.app)}>
        <Input label="App ID" mono value={filters.app} placeholder="app_…" onChange={(e) => set({ app: e.target.value })} />
      </FilterButton>

      <FilterButton label="Target" count={count(filters.targetKind, filters.targetID)}>
        <Select
          label="Kind"
          value={filters.targetKind}
          options={[{ value: '', label: 'Any' }, ...TARGET_KINDS.map((k) => ({ value: k, label: k }))]}
          onChange={(e) => set({ targetKind: e.target.value })}
        />
        <Input label="ID" mono value={filters.targetID} onChange={(e) => set({ targetID: e.target.value })} />
      </FilterButton>

      <FilterButton label="Outcome" count={count(filters.outcome)}>
        <div role="radiogroup" aria-label="Outcome" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {OUTCOMES.map((o) => (
            <Radio
              key={o.value || 'any'}
              name="audit-outcome"
              value={o.value}
              label={o.label}
              checked={filters.outcome === o.value}
              onChange={() => set({ outcome: o.value })}
            />
          ))}
        </div>
      </FilterButton>
    </>
  );
}

/**
 * A filter's button and the popover it opens: paper-raised, a rule border and
 * the one popover shadow, as the console's menus are. A click outside or
 * Escape closes it.
 */
function FilterButton({
  label,
  count = 0,
  active = count > 0,
  children,
}: Readonly<{ label: string; count?: number; active?: boolean; children: React.ReactNode }>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  useCloseOnOutside(root, open, () => setOpen(false));
  return (
    <div ref={root} style={{ position: 'relative' }}>
      <Button
        variant={active ? 'secondary' : 'ghost'}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
          {count > 0 ? `${label} · ${count}` : label}
          <Icon name="chevron-down" size={14} />
        </span>
      </Button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
          style={{
            position: 'absolute',
            top: 'calc(100% + var(--space-1))',
            left: 0,
            zIndex: 30,
            width: 'min(20rem, calc(100vw - 2 * var(--space-4)))',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
            padding: 'var(--space-4)',
            background: 'var(--paper-raised)',
            border: 'var(--border-width) solid var(--rule-strong)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-popover)',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** An event's outcome when it was not a success, as a symbol and a word:
 *  denied is a refusal, failed is an attempt that went wrong. */
function Outcome({ outcome }: Readonly<{ outcome?: string }>) {
  if (outcome === 'denied') return <StatusIndicator status="stopped" label="Denied" />;
  if (outcome === 'failed') return <StatusIndicator status="failed" label="Failed" />;
  return null;
}

/** The sentence, how it ended when it did not succeed, and the action. */
function EventCell({ row }: Readonly<{ row: AuditRecord }>) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minWidth: 0 }}>
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
        <span style={{ font: 'var(--type-body-ui)', color: 'var(--ink)' }}>{row.summary || row.action}</span>
        <Outcome outcome={row.outcome} />
      </span>
      {row.summary && row.summary !== row.action && (
        <span style={{ font: 'var(--type-code-sm)', color: 'var(--ink-secondary)' }}>{row.action}</span>
      )}
    </span>
  );
}

/** The log's rows: time, event, actor. */
export function AuditTable({
  events,
  people,
  empty,
  loading = false,
  onOpen,
}: Readonly<{
  events: AuditRecord[];
  people: Person[];
  empty: React.ReactNode;
  /** The first page has not arrived. A change of filter is a new query, so
   *  this is also what shows between one filter and its results. */
  loading?: boolean;
  /** Opens an event's whole record. */
  onOpen?: (event: AuditRecord) => void;
}>) {
  const narrow = useNarrow();
  return (
    <Table
      dense
      loading={loading}
      skeletonRows={6}
      empty={empty}
      onRowClick={onOpen}
      columns={
        narrow
          ? [
              {
                key: 'action',
                header: 'Event',
                width: 'minmax(0,1fr)',
                render: (row: AuditRecord) => (
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
                      <span>{row.summary || row.action}</span>
                      <Outcome outcome={row.outcome} />
                    </span>
                    <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>{actorText(row, people)}</span>
                  </span>
                ),
              },
              { key: 'occurred_at', header: 'Time', width: '12ch', muted: true, render: (row: AuditRecord) => stamp(row.occurred_at) },
            ]
          : [
              {
                key: 'occurred_at',
                header: 'Time',
                width: '14ch',
                muted: true,
                render: (row: AuditRecord) => <Tooltip content={new Date(row.occurred_at).toLocaleString()}>{stamp(row.occurred_at)}</Tooltip>,
              },
              { key: 'action', header: 'Event', width: 'minmax(0,1fr)', render: (row: AuditRecord) => <EventCell row={row} /> },
              {
                key: 'principal_id',
                header: 'Actor',
                width: 'minmax(0,24ch)',
                render: (row: AuditRecord) => {
                  const more = [row.actor_email, row.actor_name ? row.principal_id : undefined].filter(Boolean).join(' · ');
                  const who = actorText(row, people);
                  return more ? <Tooltip content={more}>{who}</Tooltip> : who;
                },
              },
            ]
      }
      rows={events}
    />
  );
}

/**
 * One event in full: how it ended, who did it from where, what it was done
 * to, and the record itself. The app page's side panel; the whole screen at
 * phone width.
 */
function AuditPanel({
  event: e,
  people,
  onClose,
  onActor,
}: Readonly<{ event: AuditRecord; people: Person[]; onClose: () => void; onActor: (actor: string) => void }>) {
  const narrow = useNarrow();
  const titleID = useId();
  const sheet = useRef<HTMLElement>(null);
  const record = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (k.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    sheet.current?.focus();
  }, []);

  const actor = actorText(e, people);
  const facts: Array<[string, string, boolean?]> = [
    ['Outcome', e.outcome === 'failed' ? 'Failed' : e.outcome === 'denied' ? 'Denied' : 'Succeeded'],
    ['Action', e.action, true],
    ['Actor', [actor, e.actor_email].filter(Boolean).join(' · ')],
  ];
  if (e.principal_id) facts.push(['Actor ID', e.principal_id, true]);
  if (e.on_behalf_of && e.on_behalf_of !== e.principal_id) facts.push(['On behalf of', e.on_behalf_of, true]);
  const target = targetText(e, people);
  if (target) facts.push(['Target', target, true]);
  if (e.app_id) facts.push(['App', e.app_name ? `${e.app_name} · ${e.app_id}` : e.app_id, true]);
  if (e.source_ip) facts.push(['Source IP', e.source_ip, true]);
  if (e.peer_ip && e.peer_ip !== e.source_ip) facts.push(['Through', e.peer_ip, true]);
  if (e.user_agent) facts.push(['Client', e.user_agent]);
  if (e.request_id) facts.push(['Request ID', e.request_id, true]);
  const raw = JSON.stringify(e, null, 2);
  const who = e.actor_name?.split(' ')[0] || actor;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50 }}>
      <div aria-hidden="true" onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--scrim)' }} />
      <aside
        ref={sheet}
        className="pando-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleID}
        tabIndex={-1}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: narrow ? '100%' : 'min(36rem, 75%)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)',
          overflowY: 'auto',
          padding: 'var(--space-4) var(--space-5) var(--space-6)',
          background: 'var(--paper-raised)',
          borderLeft: 'var(--border-width) solid var(--rule)',
          boxShadow: 'var(--shadow-popover)',
          outline: 'none',
        }}
      >
        {narrow && (
          <button
            type="button"
            onClick={onClose}
            style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)', border: 0, padding: 0, background: 'transparent', font: 'var(--type-body-ui)', color: 'var(--ink-secondary)', cursor: 'pointer' }}
          >
            <Icon name="arrow-left" size={14} />
            Audit log
          </button>
        )}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minWidth: 0 }}>
            <h2 id={titleID} style={{ font: 'var(--type-h3)', color: 'var(--ink)', margin: 0 }}>
              {e.summary || e.action}
            </h2>
            <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>
              <Outcome outcome={e.outcome} />
              {fullStamp(e.occurred_at)}
            </span>
          </span>
          {!narrow && (
            <IconButton label="Close" onClick={onClose}>
              <Icon name="x" />
            </IconButton>
          )}
        </div>

        <dl className="pando-facts" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
          {facts.map(([k, v, mono]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd style={mono ? { font: 'var(--type-code-sm)' } : undefined}>{v}</dd>
            </div>
          ))}
        </dl>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <span style={{ font: 'var(--type-label)', color: 'var(--ink-secondary)' }}>Record</span>
          <pre
            ref={record}
            style={{
              margin: 0,
              padding: 'var(--space-3) var(--space-4)',
              font: 'var(--type-code-sm)',
              color: 'var(--ink)',
              background: 'var(--paper-sunken)',
              border: 'var(--border-width) solid var(--rule)',
              borderRadius: 'var(--radius-sm)',
              overflowX: 'auto',
            }}
          >
            {raw}
          </pre>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          {e.principal_id && (
            <Button variant="secondary" onClick={() => onActor(e.principal_id!)}>
              Events by {who}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() =>
              void copyOrSelect(raw, record.current).then((how) => {
                setCopied(how === 'copied');
                window.setTimeout(() => setCopied(false), 2_000);
              })
            }
          >
            {copied ? 'Copied' : 'Copy record'}
          </Button>
        </div>
      </aside>
    </div>
  );
}

interface AuditArchive {
  id: string;
  month: string;
  adapter_ref?: string;
  row_count: number;
  size_bytes: number;
  sha256: string;
}

/**
 * Months past retention (R-347): archived, checked, and removed from the live
 * log, so the table above no longer finds them. One line, opening the list;
 * each month downloads as gzipped JSON lines from the endpoint the CLI uses.
 * A link to the list's anchor, such as a sink's missed range, opens it.
 */
function ArchivedMonths() {
  const anchored = () => globalThis.location?.hash === `#${ARCHIVES_ANCHOR}`;
  const [open, setOpen] = useState(anchored);
  useEffect(() => {
    const onHash = () => anchored() && setOpen(true);
    globalThis.addEventListener?.('hashchange', onHash);
    return () => globalThis.removeEventListener?.('hashchange', onHash);
  }, []);
  const archives = useQuery({
    queryKey: ['audit-archives'],
    queryFn: () => api.get<{ archives: AuditArchive[] }>('/audit/archives'),
  });
  const rows = archives.data?.archives ?? [];
  return (
    <section id={ARCHIVES_ANCHOR} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', flex: open ? '1 1 100%' : undefined }}>
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>
        Older months are archived ·
        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          Archived months
        </Button>
      </span>
      {open && archives.isError && <Quiet>{messageOf(archives.error)}</Quiet>}
      {open && (
        <Table
          dense
          loading={archives.isPending}
          skeletonRows={2}
          empty={<EmptyState heading="No months archived" />}
          columns={[
            { key: 'month', header: 'Month', width: '10ch', mono: true },
            { key: 'row_count', header: 'Events', width: '12ch', render: (row: AuditArchive) => row.row_count.toLocaleString() },
            {
              key: 'adapter_ref',
              header: 'Destination',
              width: 'minmax(0,20ch)',
              mono: true,
              render: (row: AuditArchive) => row.adapter_ref || 'Pando',
            },
            {
              key: 'sha256',
              header: 'SHA-256',
              width: 'minmax(0,1fr)',
              mono: true,
              muted: true,
              render: (row: AuditArchive) => <Tooltip content={row.sha256}>{row.sha256.slice(0, 16) + '…'}</Tooltip>,
            },
            {
              key: 'id',
              header: '',
              width: '12ch',
              render: (row: AuditArchive) => (
                <a href={`${base}/audit/archives/${encodeURIComponent(row.id)}`} download>
                  Download
                </a>
              ),
            },
          ]}
          rows={rows}
        />
      )}
    </section>
  );
}

function LoadOlder({ log }: Readonly<{ log: ReturnType<typeof useAuditLog>['log'] }>) {
  if (!log.hasNextPage) return <span />;
  return (
    <Button variant="secondary" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
      {log.isFetchingNextPage ? 'Loading' : 'Load older events'}
    </Button>
  );
}
