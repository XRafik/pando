// Events — subscriptions to what happens in Pando, and where each one sends
// (issue #50, R-364 – R-374).
//
// A subscription is a filter and a destination: a webhook Pando signs, or a
// notification channel an administrator set up (Slack, Teams, Discord, email,
// ntfy). Anybody who administers an app may subscribe to it; an install-wide
// subscription, and seeing everybody's, needs install.events.manage.
//
// The screen is a table with one filter row; a row opens the subscription in
// the side panel, with its recent deliveries, each of which opens in place to
// its attempts (R-369). An app's Events tab shows the same subscriptions as a
// column of cards.
//
// The signing key is shown once, at creation, in the dialog that made it, the
// way a token is (R-371).

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Banner,
  Button,
  Card,
  Checkbox,
  CodeBlock,
  Dialog,
  EmptyState,
  Icon,
  InlineCode,
  Input,
  Select,
  Skeleton,
  StatusIndicator,
  StatusSymbol,
} from '@design';

import { api } from '@api/client';
import type { App } from '@api/types.gen';
import { Quiet, Screen, messageOf, refusal } from './Accounts';
import { useNotifyChannels } from './Notify';
import { Table } from '../ui/Table';
import { ShowMore, usePaged, type PageOf } from '../ui/paged';
import { relative, stamp } from '../ui/time';
import { Disclosure } from '../ui/Disclosure';
import { deliveriesInterval } from '../ui/polling';
import { EVENTS_DOCS_URL } from '../ui/docs';
import { SidePanel } from '../ui/SidePanel';
import { Segmented } from '../ui/Segmented';
import { FilterMenu } from '../ui/FilterMenu';
import { SearchField } from '../ui/SearchField';
import { useNarrow } from '../ui/narrow';
import {
  NO_FILTERS,
  STATE_NAMES,
  destinationLabel,
  destinationOf,
  eventsSummary,
  filterSubscriptions,
  groupName,
  groupsOf,
  optionsOf,
  requestLine,
  scopeName,
  stateOf,
  subscriptionName,
  attemptLine,
  deliveryResult,
  type Delivery,
  type Destination,
  type EventDef,
  type Subscription,
  type SubscriptionFilters,
  type SubscriptionState,
} from './subscriptionText';

const caption = { font: 'var(--type-caption)', color: 'var(--ink-secondary)', margin: 0 };

function useCatalog() {
  return useQuery({
    queryKey: ['events'],
    queryFn: () => api.get<{ events: EventDef[]; destinations: Destination[] }>('/events'),
    staleTime: 60_000,
  });
}

/** Everything that shows a subscription, read again after it changes. */
function useRefresh(id: string) {
  const queries = useQueryClient();
  return () => {
    void queries.invalidateQueries({ queryKey: ['subscriptions'] });
    void queries.invalidateQueries({ queryKey: ['subscription', id] });
    void queries.invalidateQueries({ queryKey: ['deliveries', id] });
  };
}

export function Events({ canManageAll, apps }: { canManageAll: boolean; apps: App[] }) {
  const [creating, setCreating] = useState(false);
  return (
    <Screen
      heading="Events"
      action={
        <Button variant="primary" onClick={() => setCreating(true)}>
          New subscription
        </Button>
      }
    >
      <Subscriptions apps={apps} canManageAll={canManageAll} creating={creating} onCreating={setCreating} />
    </Screen>
  );
}

const STATUS_OPTIONS = (['on', 'failing', 'off'] as const).map((s) => ({ value: s, label: STATE_NAMES[s] }));
const WHOSE = [
  { value: 'mine', label: 'Mine' },
  { value: 'everyone', label: 'Everyone' },
];

/**
 * Subscriptions, as a table with the panel and dialogs that make, show and
 * change one. The Events screen shows the caller's across the installation;
 * an app's Events tab passes `app` and shows that app's, and makes new ones
 * about it — as a column of cards beside the app's events (`layout="cards"`).
 */
export function Subscriptions({
  apps,
  app,
  layout = 'table',
  canManageAll,
  creating,
  onCreating,
}: {
  apps: App[];
  app?: App;
  layout?: 'table' | 'cards';
  canManageAll: boolean;
  creating: boolean;
  onCreating: (open: boolean) => void;
}) {
  const [everyone, setEveryone] = useState(false);
  const [filters, setFilters] = useState<SubscriptionFilters>(NO_FILTERS);
  const [created, setCreated] = useState<Subscription | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const catalog = useCatalog();
  // Newest first, a page at a time (issue #72).
  const paged = usePaged<{ subscriptions: Subscription[] | null } & PageOf, Subscription>({
    key: ['subscriptions'],
    path: '/subscriptions',
    rows: (p) => p.subscriptions,
    params: { everyone: everyone ? 'true' : undefined, app_id: app?.id },
  });
  const subs = paged.query;
  const destinations = catalog.data?.destinations ?? [];
  const rows = paged.rows;
  const shown = useMemo(() => filterSubscriptions(rows, filters, destinations), [rows, filters, destinations]);
  const options = useMemo(() => optionsOf(rows, destinations), [rows, destinations]);
  const set = (patch: Partial<SubscriptionFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const narrow = useNarrow();
  const empty =
    rows.length > 0 ? (
      <Quiet>No subscriptions match.</Quiet>
    ) : (
      <EmptyState
        heading="No subscriptions yet"
        action={
          <Button variant="primary" onClick={() => onCreating(true)}>
            New subscription
          </Button>
        }
      />
    );

  return (
    <>
      {subs.isError && <Quiet>{messageOf(subs.error)}</Quiet>}

      {layout === 'cards' ? (
        <SubscriptionCards loading={subs.isPending} rows={rows} destinations={destinations} onOpen={setOpen} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
            <SearchField value={filters.search} onChange={(search) => set({ search })} placeholder="Search subscriptions" />
            {canManageAll && (
              <FilterMenu
                single
                label="Whose"
                options={WHOSE}
                chosen={[everyone ? 'everyone' : 'mine']}
                onChange={([v]) => setEveryone(v === 'everyone')}
              />
            )}
            {!app && (
              <FilterMenu label="Scope" options={options.scope} chosen={filters.scope} onChange={(scope) => set({ scope })} />
            )}
            <FilterMenu
              label="Destination"
              options={options.destination}
              chosen={filters.destination}
              onChange={(destination) => set({ destination })}
            />
            <FilterMenu
              label="Status"
              options={STATUS_OPTIONS}
              chosen={filters.status}
              onChange={(status) => set({ status: status as SubscriptionState[] })}
            />
          </div>
          {narrow ? (
            <SubscriptionRows loading={subs.isPending} rows={shown} destinations={destinations} empty={empty} onOpen={setOpen} />
          ) : (
            <Table
              loading={subs.isPending}
              onRowClick={(row: Subscription) => setOpen(row.id)}
              empty={empty}
              columns={[
                {
                  key: 'name',
                  header: 'Subscription',
                  width: 'minmax(0,1.2fr)',
                  render: (row: Subscription) => (
                    <Stacked first={<span style={{ font: 'var(--type-label)' }}>{subscriptionName(row)}</span>} second={scopeName(row)} />
                  ),
                },
                {
                  key: 'events',
                  header: 'Events',
                  width: 'minmax(0,1fr)',
                  render: (row: Subscription) => eventsSummary(row.events),
                },
                {
                  key: 'to',
                  header: 'Destination',
                  width: 'minmax(0,1.2fr)',
                  render: (row: Subscription) => {
                    const to = destinationOf(row, destinations);
                    return <Stacked first={to.kind} second={to.target} />;
                  },
                },
                {
                  key: 'status',
                  header: 'Status',
                  width: '12ch',
                  render: (row: Subscription) => <SubscriptionStatus sub={row} />,
                },
                {
                  key: 'last',
                  header: 'Last delivery',
                  width: '16ch',
                  muted: true,
                  render: (row: Subscription) => (row.last_delivery_at ? stamp(row.last_delivery_at) : 'Never'),
                },
              ]}
              rows={shown}
            />
          )}
        </div>
      )}
      <ShowMore query={subs} label="Show more subscriptions" />

      {creating && (
        <SubscriptionForm
          apps={app ? [app] : apps}
          fixedApp={app}
          canManageAll={canManageAll}
          catalog={catalog.data?.events ?? []}
          destinations={destinations}
          onClose={() => onCreating(false)}
          onSaved={(s) => {
            onCreating(false);
            if (s.signing_key) setCreated(s);
          }}
        />
      )}
      {created && <SigningKey sub={created} onClose={() => setCreated(null)} />}
      {open && (
        <SubscriptionPanel
          id={open}
          catalog={catalog.data?.events ?? []}
          destinations={destinations}
          onClose={() => setOpen(null)}
          onKey={(s) => setCreated(s)}
        />
      )}
    </>
  );
}

/** The subscriptions at phone width: a row each, its name and status, then
 *  its scope and destination, and its last delivery. */
function SubscriptionRows({
  loading,
  rows,
  destinations,
  empty,
  onOpen,
}: Readonly<{
  loading: boolean;
  rows: Subscription[];
  destinations: Destination[];
  empty: React.ReactNode;
  onOpen: (id: string) => void;
}>) {
  if (loading) return <Skeleton width="60%" />;
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div style={{ borderTop: 'var(--border-width) solid var(--rule-strong)' }}>
      {rows.map((s) => {
        const to = destinationOf(s, destinations);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onOpen(s.id)}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) auto',
              gap: 'var(--space-1) var(--space-3)',
              width: '100%',
              padding: 'var(--space-3) 0',
              border: 0,
              borderBottom: 'var(--border-width) solid var(--rule)',
              background: 'transparent',
              color: 'var(--ink)',
              font: 'var(--type-body-ui)',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <span style={{ font: 'var(--type-label)', overflowWrap: 'anywhere' }}>{subscriptionName(s)}</span>
            <SubscriptionStatus sub={s} />
            <span style={{ ...caption, overflowWrap: 'anywhere' }}>{`${scopeName(s)} · ${to.kind}`}</span>
            <span style={{ ...caption, whiteSpace: 'nowrap' }}>{s.last_delivery_at ? stamp(s.last_delivery_at) : 'Never'}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A value with a caption under it, as a table cell or a panel row shows one. */
function Stacked({ first, second, mono = false }: Readonly<{ first: React.ReactNode; second?: string; mono?: boolean }>) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <span>{first}</span>
      {second && (
        <span
          style={{
            font: mono ? 'var(--type-code-sm)' : 'var(--type-caption)',
            color: 'var(--ink-secondary)',
            overflowWrap: 'anywhere',
          }}
        >
          {second}
        </span>
      )}
    </span>
  );
}

const STATUS_LOOK: Record<SubscriptionState, 'running' | 'failed' | 'stopped'> = {
  on: 'running',
  failing: 'failed',
  off: 'stopped',
};

function SubscriptionStatus({ sub }: { sub: Subscription }) {
  const state = stateOf(sub);
  return <StatusIndicator status={STATUS_LOOK[state]} label={STATE_NAMES[state]} />;
}

/**
 * One card per subscription: what it is, where it sends, whether it is on,
 * and what can be done to it. A subscription Pando turned off after failing
 * (R-370) says why, with the way to turn it back on beside the reason.
 */
function SubscriptionCards({
  loading,
  rows,
  destinations,
  onOpen,
}: {
  loading: boolean;
  rows: Subscription[];
  destinations: Destination[];
  onOpen: (id: string) => void;
}) {
  if (loading) {
    return (
      <Card padding="md">
        <Skeleton width="60%" />
      </Card>
    );
  }
  if (rows.length === 0) return <EmptyState heading="No subscriptions yet" />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {rows.map((s) => (
        <SubscriptionCard key={s.id} sub={s} destinations={destinations} onOpen={() => onOpen(s.id)} />
      ))}
    </div>
  );
}

function SubscriptionCard({
  sub,
  destinations,
  onOpen,
}: {
  sub: Subscription;
  destinations: Destination[];
  onOpen: () => void;
}) {
  const refresh = useRefresh(sub.id);
  const turnOn = useMutation({
    mutationFn: () => api.patch<Subscription>(`/subscriptions/${sub.id}`, { enabled: true }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: () => api.post<Delivery>(`/subscriptions/${sub.id}/test`, {}),
    onSuccess: refresh,
  });
  const to = destinationOf(sub, destinations);
  const failure = turnOn.error ?? test.error;

  return (
    <Card padding="md" as="article" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
        <Stacked
          first={<span style={{ font: 'var(--type-label)' }}>{subscriptionName(sub)}</span>}
          second={to.target ? `${to.kind} · ${to.target}` : to.kind}
        />
        <SubscriptionStatus sub={sub} />
      </div>
      {(sub.description ?? '').trim() && <p style={caption}>{eventsSummary(sub.events)}</p>}
      {!sub.enabled && sub.disabled_reason && (
        <span style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)', ...caption, color: 'var(--contour-text)' }}>
          <Icon name="triangle-alert" color="var(--contour-text)" />
          <span>{sub.disabled_reason}</span>
        </span>
      )}
      {test.isSuccess && <p style={caption}>Test sent.</p>}
      {failure && <p style={{ ...caption, color: 'var(--marker-deep)' }}>{messageOf(failure)}</p>}
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
        {!sub.enabled && (
          <Button variant="secondary" disabled={turnOn.isPending} onClick={() => turnOn.mutate()}>
            {turnOn.isPending ? 'Turning on' : 'Turn on'}
          </Button>
        )}
        <Button variant="ghost" disabled={!sub.enabled || test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? 'Sending test' : 'Send test'}
        </Button>
        <Button variant="ghost" onClick={onOpen}>
          Details
        </Button>
      </span>
    </Card>
  );
}

// --- the panel ---------------------------------------------------------------

/** One subscription in the side panel: what can be done to it, what it is,
 *  and its recent deliveries. */
function SubscriptionPanel({
  id,
  catalog,
  destinations,
  onClose,
  onKey,
}: {
  id: string;
  catalog: EventDef[];
  destinations: Destination[];
  onClose: () => void;
  onKey: (s: Subscription) => void;
}) {
  const queries = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const refresh = useRefresh(id);

  const sub = useQuery({
    queryKey: ['subscription', id],
    queryFn: () => api.get<Subscription>(`/subscriptions/${id}`),
  });
  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) => api.patch<Subscription>(`/subscriptions/${id}`, { enabled }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: () => api.post<Delivery>(`/subscriptions/${id}/test`, {}),
    onSuccess: refresh,
  });
  const rotate = useMutation({
    mutationFn: () => api.post<Subscription>(`/subscriptions/${id}/signing-key`, {}),
    onSuccess: (s) => onKey(s),
  });
  const remove = useMutation({
    mutationFn: () => api.del<unknown>(`/subscriptions/${id}`),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['subscriptions'] });
      onClose();
    },
  });

  const s = sub.data;
  const failure = setEnabled.error ?? test.error ?? rotate.error;
  const to = s && destinationOf(s, destinations);

  return (
    <SidePanel
      title={s ? subscriptionName(s) : 'Subscription'}
      under={s && <SubscriptionStatus sub={s} />}
      width="min(36rem, 100%)"
      onClose={onClose}
    >
      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          padding: 'var(--space-4) var(--space-5) var(--space-6)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        {sub.isError && <Quiet>{messageOf(sub.error)}</Quiet>}
        {s && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <Button variant="secondary" disabled={!s.enabled || test.isPending} onClick={() => test.mutate()}>
              {test.isPending ? 'Sending test' : 'Send test'}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="ghost" disabled={setEnabled.isPending} onClick={() => setEnabled.mutate(!s.enabled)}>
              {s.enabled ? 'Turn off' : 'Turn on'}
            </Button>
            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
        )}
        {test.isSuccess && <p style={caption}>Test sent.</p>}
        {failure && <Banner tone="failed">{messageOf(failure)}</Banner>}
        {s && !s.enabled && s.disabled_reason && <Banner tone="failed">{s.disabled_reason}</Banner>}

        {s && to && (
          <dl style={{ margin: 0, font: 'var(--type-body-ui)' }}>
            <Row term="Scope">{scopeName(s)}</Row>
            <Row term="Events">{eventsSummary(s.events)}</Row>
            <Row term="Destination">
              <Stacked first={to.kind} second={s.destination === 'webhook' ? s.url : to.target} mono={s.destination === 'webhook'} />
            </Row>
            {s.destination === 'webhook' && (
              <>
                <Row term="Request">{requestLine(s)}</Row>
                <Row term="Signing key">
                  <Button variant="ghost" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
                    {rotate.isPending ? 'Rotating' : 'Rotate'}
                  </Button>
                </Row>
              </>
            )}
            <Row term="Owner">{s.owner_name || s.owner_id}</Row>
          </dl>
        )}

        <section style={{ display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ font: 'var(--type-label)', color: 'var(--ink-secondary)', margin: '0 0 var(--space-2)' }}>
            Recent deliveries
          </h3>
          <DeliveryLog id={id} />
        </section>
      </div>

      {editing && s && (
        <SubscriptionForm
          editing={s}
          apps={[]}
          canManageAll={false}
          catalog={catalog}
          destinations={destinations}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refresh();
          }}
        />
      )}
      {confirmDelete && (
        <Dialog
          open
          title="Delete this subscription?"
          description="Its deliveries are deleted with it."
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
                {remove.isPending ? 'Deleting' : 'Delete'}
              </Button>
            </>
          }
        >
          {remove.isError && <Banner tone="failed">{messageOf(remove.error)}</Banner>}
        </Dialog>
      )}
    </SidePanel>
  );
}

function Row({ term, children }: Readonly<{ term: string; children: React.ReactNode }>) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '8rem minmax(0,1fr)',
        gap: 'var(--space-3)',
        alignItems: 'baseline',
        padding: 'var(--space-2) 0',
        borderTop: 'var(--border-width) solid var(--rule)',
      }}
    >
      <dt style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>{term}</dt>
      <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{children}</dd>
    </div>
  );
}

/** A subscription's recent deliveries; each opens in place to its attempts. */
function DeliveryLog({ id }: { id: string }) {
  const [openDelivery, setOpenDelivery] = useState<string | null>(null);
  const deliveries = useQuery({
    queryKey: ['deliveries', id],
    queryFn: () => api.get<{ deliveries: Delivery[] }>(`/subscriptions/${id}/deliveries`),
    // Pending deliveries move on their own; the list follows them, as often
    // as they can move (deliveriesInterval) rather than every three seconds
    // through hours of retries.
    refetchInterval: (q) => deliveriesInterval(q.state.data?.deliveries),
  });
  if (deliveries.isPending) return <Skeleton width="60%" />;
  if (deliveries.isError) return <Quiet>{messageOf(deliveries.error)}</Quiet>;
  const list = deliveries.data.deliveries ?? [];
  if (list.length === 0) return <Quiet>No deliveries yet.</Quiet>;
  return (
    <div>
      {list.map((d) => (
        <DeliveryRow
          key={d.id}
          subscriptionID={id}
          d={d}
          open={openDelivery === d.id}
          onToggle={() => setOpenDelivery(openDelivery === d.id ? null : d.id)}
        />
      ))}
    </div>
  );
}

const DELIVERY_LOOK: Record<Delivery['status'], 'running' | 'failed' | 'building'> = {
  succeeded: 'running',
  failed: 'failed',
  pending: 'building',
};

function DeliveryRow({
  subscriptionID,
  d,
  open,
  onToggle,
}: Readonly<{ subscriptionID: string; d: Delivery; open: boolean; onToggle: () => void }>) {
  return (
    <div style={{ borderTop: 'var(--border-width) solid var(--rule)' }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0,1fr) auto',
          gap: 'var(--space-1) var(--space-3)',
          alignItems: 'baseline',
          width: '100%',
          padding: 'var(--space-2) 0',
          border: 0,
          background: 'transparent',
          color: 'var(--ink)',
          font: 'var(--type-body-ui)',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <StatusSymbol status={DELIVERY_LOOK[d.status]} />
        <Stacked first={<span style={{ font: 'var(--type-code-sm)' }}>{d.event}</span>} second={deliveryResult(d)} />
        <span style={{ ...caption, whiteSpace: 'nowrap' }}>{stamp(d.created_at)}</span>
      </button>
      {open && <DeliveryDetail subscriptionID={subscriptionID} deliveryID={d.id} />}
    </div>
  );
}

function DeliveryDetail({ subscriptionID, deliveryID }: Readonly<{ subscriptionID: string; deliveryID: string }>) {
  const refresh = useRefresh(subscriptionID);
  const [payload, setPayload] = useState(false);
  const path = `/subscriptions/${subscriptionID}/deliveries/${deliveryID}`;
  const d = useQuery({ queryKey: ['delivery', deliveryID], queryFn: () => api.get<Delivery>(path) });
  const redeliver = useMutation({
    mutationFn: () => api.post<Delivery>(`${path}/redeliver`, {}),
    onSuccess: () => {
      refresh();
      void d.refetch();
    },
  });

  const inner = { display: 'flex', flexDirection: 'column' as const, gap: 'var(--space-1)', padding: '0 0 var(--space-3) var(--space-5)' };
  if (d.isPending) return <div style={inner}><Skeleton width="40%" /></div>;
  if (d.isError) return <div style={inner}><Quiet>{messageOf(d.error)}</Quiet></div>;
  const delivery = d.data;

  return (
    <div style={inner}>
      {(delivery.attempt_log ?? []).map((a) => (
        <span key={a.attempt} style={caption}>
          {attemptLine(a)}
          {a.error && ` · ${a.error}`}
        </span>
      ))}
      {delivery.status === 'pending' && delivery.next_attempt_at && (
        <span style={caption}>Next attempt {relative(delivery.next_attempt_at).toLowerCase()}</span>
      )}
      {redeliver.isError && <Banner tone="failed">{messageOf(redeliver.error)}</Banner>}
      <span style={{ display: 'flex', gap: 'var(--space-2)', paddingTop: 'var(--space-2)' }}>
        <Button variant="secondary" disabled={redeliver.isPending} onClick={() => redeliver.mutate()}>
          {redeliver.isPending ? 'Redelivering' : 'Redeliver'}
        </Button>
        <Button variant="ghost" aria-expanded={payload} onClick={() => setPayload(!payload)}>
          Payload
        </Button>
      </span>
      {payload && <CodeBlock dense copyable lines={JSON.stringify(delivery.payload, null, 2)} />}
    </div>
  );
}

// --- making and changing one -------------------------------------------------

/** How a webhook is sent (R-375), as a form edits it. */
interface RequestOptions {
  method: string;
  contentType: string;
  /** "Name: value" lines. */
  headers: string;
  template: string;
}

const DEFAULT_REQUEST: RequestOptions = { method: 'POST', contentType: 'application/json', headers: '', template: '' };

/** Reads "Name: value" lines into headers, or says which line is wrong. */
function parseHeaders(text: string): { headers: Record<string, string>; problem?: string } {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const at = line.indexOf(':');
    const name = at < 0 ? '' : line.slice(0, at).trim();
    if (!name) return { headers, problem: `"${line.trim()}" is not a header. Write one per line as Name: value.` };
    headers[name] = line.slice(at + 1).trim();
  }
  return { headers };
}

/** The request body fields for these options. Headers only when asked to send them. */
function requestBody(opts: RequestOptions, withHeaders: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    method: opts.method,
    content_type: opts.contentType,
    payload_template: opts.template,
  };
  if (withHeaders) body.headers = parseHeaders(opts.headers).headers;
  return body;
}

function RequestFields({
  value,
  onChange,
  headerNote,
}: {
  value: RequestOptions;
  onChange: (next: RequestOptions) => void;
  headerNote?: string;
}) {
  const problem = parseHeaders(value.headers).problem;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,12ch) minmax(0,1fr)', gap: 'var(--space-3)' }}>
        <Select
          label="Method"
          value={value.method}
          options={['POST', 'PUT', 'PATCH']}
          onChange={(e) => onChange({ ...value, method: e.target.value })}
        />
        <Input
          label="Content type"
          value={value.contentType}
          mono
          onChange={(e) => onChange({ ...value, contentType: e.target.value })}
        />
      </div>
      <Input
        as="textarea"
        rows={3}
        mono
        spellCheck={false}
        autoComplete="off"
        label="Headers"
        value={value.headers}
        placeholder="Authorization: Bearer …"
        helper={headerNote ?? 'One per line, as Name: value. Never shown again.'}
        error={problem}
        onChange={(e) => onChange({ ...value, headers: e.target.value })}
      />
      <Input
        as="textarea"
        rows={5}
        mono
        spellCheck={false}
        label="Body"
        value={value.template}
        placeholder={'{"text": {{json .Subject}}, "link": {{json .Link}}}'}
        helper="Empty sends the event as JSON. Otherwise a Go template."
        onChange={(e) => onChange({ ...value, template: e.target.value })}
      />
    </div>
  );
}

const WEBHOOK = 'webhook';

/** Chosen in Send to: "webhook", or "notify:" and an adapter's ID. */
function sendTo(s: Pick<Subscription, 'destination' | 'adapter_id'>): string {
  return s.destination === 'webhook' ? WEBHOOK : `notify:${s.adapter_id ?? ''}`;
}

/**
 * New subscription, or Edit: one dialog. Name, scope (new only — it cannot
 * be changed), events, and where it sends. An existing subscription keeps its
 * kind of destination (the API changes a webhook's URL or a channel's
 * adapter, not one into the other), and its header values are never shown
 * back, so the headers field starts empty and replaces them only if changed.
 */
function SubscriptionForm({
  editing,
  apps,
  fixedApp,
  canManageAll,
  catalog,
  destinations,
  onClose,
  onSaved,
}: {
  editing?: Subscription;
  apps: App[];
  /** Made from an app's own Events tab: about that app, without asking. */
  fixedApp?: App;
  canManageAll: boolean;
  catalog: EventDef[];
  destinations: Destination[];
  onClose: () => void;
  onSaved: (s: Subscription) => void;
}) {
  const queries = useQueryClient();
  const [description, setDescription] = useState(editing?.description ?? '');
  const [appID, setAppID] = useState(editing?.app_id ?? fixedApp?.id ?? (canManageAll ? '' : (apps[0]?.id ?? '')));
  const [chosen, setChosen] = useState<string[]>(editing?.events ?? ['*']);
  const [target, setTarget] = useState(editing ? sendTo(editing) : WEBHOOK);
  const [url, setURL] = useState(editing?.url ?? '');
  const [channel, setChannel] = useState(editing?.channel ?? '');
  const [request, setRequest] = useState<RequestOptions>(
    editing
      ? {
          method: editing.method || 'POST',
          contentType: editing.content_type || 'application/json',
          headers: '',
          template: editing.payload_template ?? '',
        }
      : DEFAULT_REQUEST,
  );
  const [removeHeaders, setRemoveHeaders] = useState(false);

  const webhook = target === WEBHOOK;
  const adapterID = webhook ? '' : target.slice('notify:'.length);
  const takesChannel = !webhook && destinations.some((d) => d.id === adapterID && d.channels);
  const everything = chosen.includes('*');
  const headerNames = editing?.header_names ?? [];
  const replaceHeaders = !editing || removeHeaders || request.headers.trim() !== '';

  // An install event never reaches an app subscription, so it is not offered
  // for one: a box that can be ticked and never fires is a broken promise.
  const offered = useMemo(() => catalog.filter((e) => !appID || e.scope === 'app'), [catalog, appID]);
  const toggle = (pattern: string, on: boolean) =>
    setChosen((cur) => (on ? [...cur.filter((c) => c !== pattern), pattern] : cur.filter((c) => c !== pattern)));

  const where = (): Record<string, unknown> => {
    if (webhook) return { url, ...requestBody(removeHeaders ? { ...request, headers: '' } : request, replaceHeaders) };
    const out: Record<string, unknown> = { adapter_id: adapterID };
    if (takesChannel) out.channel = channel;
    else if (editing?.channel) out.channel = '';
    return out;
  };
  const body = (): Record<string, unknown> => ({ description, events: chosen, ...where() });
  const save = useMutation({
    mutationFn: () =>
      editing
        ? api.patch<Subscription>(`/subscriptions/${editing.id}`, body())
        : api.post<Subscription>('/subscriptions', {
            ...body(),
            app_id: appID || undefined,
            destination: webhook ? 'webhook' : 'notify',
          }),
    onSuccess: (s) => {
      void queries.invalidateQueries({ queryKey: ['subscriptions'] });
      onSaved(s);
    },
  });

  const scopeOptions = [
    ...(canManageAll ? [{ value: '', label: 'Installation' }] : []),
    ...apps.map((a) => ({ value: a.id, label: a.name })),
  ];
  const sendOptions = [
    ...(!editing || editing.destination === 'webhook' ? [{ value: WEBHOOK, label: 'Webhook' }] : []),
    ...(!editing || editing.destination === 'notify'
      ? destinations.map((d) => ({ value: `notify:${d.id}`, label: destinationLabel(d, destinations) }))
      : []),
  ];

  const ready =
    chosen.length > 0 &&
    (webhook ? url.trim() !== '' && !parseHeaders(request.headers).problem : adapterID !== '' && (!takesChannel || channel !== '')) &&
    (Boolean(editing) || Boolean(fixedApp) || scopeOptions.length > 0);

  let saveLabel = editing ? 'Save' : 'Create';
  if (save.isPending) saveLabel = editing ? 'Saving' : 'Creating';

  return (
    <Dialog
      open
      width={640}
      title={editing ? 'Edit subscription' : 'New subscription'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || save.isPending} onClick={() => save.mutate()}>
            {saveLabel}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        {save.isError && <Banner tone="failed">{messageOf(save.error)}</Banner>}

        <Input label="Name" value={description} onChange={(e) => setDescription(e.target.value)} />

        {!editing && !fixedApp && (
          <Select
            label="Scope"
            value={appID}
            options={scopeOptions}
            onChange={(e) => {
              setAppID(e.target.value);
              setChosen(['*']);
            }}
          />
        )}

        <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <legend style={{ font: 'var(--type-label)', color: 'var(--ink)', marginBottom: 'var(--space-2)' }}>Events</legend>
          <Segmented
            label="Events"
            value={everything ? 'all' : 'some'}
            options={[
              { value: 'all', label: 'Everything' },
              { value: 'some', label: 'Choose' },
            ]}
            onChange={(v) => setChosen(v === 'all' ? ['*'] : [])}
          />
          {!everything && (
            <EventChecklist groups={groupsOf(offered)} chosen={chosen} onToggle={toggle} />
          )}
        </fieldset>

        <Select
          label="Send to"
          value={target}
          options={sendOptions}
          onChange={(e) => {
            setTarget(e.target.value);
            setChannel('');
          }}
        />
        {webhook && (
          <>
            <Input label="URL" value={url} placeholder="https://example.com/hooks/pando" onChange={(e) => setURL(e.target.value)} />
            <Disclosure show="Request options" hide="Request options">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <RequestFields
                  value={request}
                  onChange={setRequest}
                  headerNote={headerNames.length > 0 ? `Sent now: ${headerNames.join(', ')}. New headers replace them all.` : undefined}
                />
                {headerNames.length > 0 && (
                  <Checkbox label="Remove every header" checked={removeHeaders} onChange={(e) => setRemoveHeaders(e.target.checked)} />
                )}
              </div>
            </Disclosure>
          </>
        )}
        {takesChannel && <ChannelPicker adapterID={adapterID} value={channel} onChange={setChannel} />}
      </div>
    </Dialog>
  );
}

/** Each group of events, and its events under it while the group is not chosen whole. */
function EventChecklist({
  groups,
  chosen,
  onToggle,
}: Readonly<{ groups: [string, EventDef[]][]; chosen: string[]; onToggle: (pattern: string, on: boolean) => void }>) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {groups.map(([prefix, defs]) => {
        const whole = chosen.includes(`${prefix}.*`);
        return (
          <div key={prefix} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <Checkbox label={groupName(prefix)} checked={whole} onChange={(e) => onToggle(`${prefix}.*`, e.target.checked)} />
            {!whole && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(24ch, 1fr))',
                  gap: 'var(--space-2)',
                  paddingLeft: 'var(--space-5)',
                }}
              >
                {defs.map((d) => (
                  <Checkbox
                    key={d.name}
                    label={d.name}
                    checked={chosen.includes(d.name)}
                    onChange={(e) => onToggle(d.name, e.target.checked)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The signing key, the one time Pando can show it. */
function SigningKey({ sub, onClose }: { sub: Subscription; onClose: () => void }) {
  return (
    <Dialog
      open
      width={640}
      title="Save the signing key"
      description={`Pando signs every delivery to ${sub.url} with this key.`}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          I&rsquo;ve saved it
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Banner tone="info">Pando shows this key only once. If you lose it, rotate it from the subscription.</Banner>
        <CodeBlock copyable lines={sub.signing_key ?? ''} />
        <Quiet>
          Check each delivery&rsquo;s <InlineCode>Pando-Signature</InlineCode> header against it. The{' '}
          <a href={EVENTS_DOCS_URL} target="_blank" rel="noopener noreferrer">
            events reference
          </a>{' '}
          shows how.
        </Quiet>
      </div>
    </Dialog>
  );
}

/** The channel a subscription to Slack posts to, from the workspace's. */
function ChannelPicker({
  adapterID,
  value,
  onChange,
}: Readonly<{ adapterID: string; value: string; onChange: (id: string) => void }>) {
  const channels = useNotifyChannels(adapterID);
  if (channels.isError) return <Banner tone="failed">{refusal(channels.error)}</Banner>;
  const list = channels.data?.channels ?? [];
  return (
    <Select
      label="Slack channel"
      value={value}
      disabled={channels.isPending}
      helper="A private channel is listed once Pando is invited with /invite @Pando."
      options={[
        { value: '', label: channels.isPending ? 'Loading channels' : 'Choose a channel' },
        ...list.map((c) => ({ value: c.id, label: `#${c.name}` })),
      ]}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
