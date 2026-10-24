// Adapters, as a list and a detail: every category on the left, with the
// worst status of what it holds, and the chosen category's adapters on the
// right, each with its settings, its status and what can be done to it. At
// phone width the list is a screen of its own, and a category opens one.
//
// Each screen here is shown on the verb it needs, never on "is an
// administrator". There is no implication graph between verbs (R-082), so a
// screen that assumed one would offer actions whose every request comes back
// 403.
//
// The audit log is in AuditLog.tsx; what is exported from there is exported
// from here too, where the screens that show the log have always found it.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banner, Button, Dialog, Icon, StatusIndicator, StatusSymbol, Tag } from '@design';
import type { StatusIndicatorProps } from '@design';

import { api } from '@api/client';
import { InstallVerb, useInstallVerb } from '../app/principal';
import { AdapterDialog } from './AdapterDialog';
import { InlineWarning } from '../ui/InlineWarning';
import { RouteLink } from '../ui/RouteLink';
import { LineSkeleton } from '../ui/Loading';
import { useNarrow } from '../ui/narrow';
import { AppLogoDialog, AuthorizeDialog, covers, githubLogoPlace, needsAuthorizing, useSources } from './Sources';
import {
  ConnectNotifyDialog,
  connectable,
  needsConnecting,
  SlackLogoDialog,
  useNotifyAdapters,
  type NotifyAdapter,
} from './Notify';
import type { SourceConnection } from './Sources';
import { RestartButton } from './Restart';
import { addableKinds, categoryLabel, categoryNote, defaultHandover, isManaged, orderCategories } from './adapters';
import type { AdapterKind } from './adapters';
import type { ConfiguredAdapter } from './AdapterDialog';
import { Quiet, messageOf, refusal } from './Accounts';
import { SystemPage } from './SystemPage';

export { Audit, AuditTable, useAuditLog } from './AuditLog';
export type { AuditRecord } from './AuditLog';

/** Where the startup configuration declares an adapter, in words: a key in
 *  the config file, or a variable such as PANDO_REGISTRY_URL. */
function declaredAt(row: AdapterRow): string {
  const src = row.source as { kind?: string; name?: string; key?: string } | undefined;
  if (src?.kind === 'env' && src.name) return `the environment variable ${src.name}`;
  return src?.key ? `${src.name ?? 'the config file'}, at ${src.key}` : 'the config file';
}

interface AdapterRow extends ConfiguredAdapter {
  /** `overridden` when the config file replaces this stored adapter (R-271). */
  status?: string;
  /** Declared in the config file, so read-only here (R-271). */
  declared?: boolean;
  /** An older name for id, from before GET /adapters settled its shape. */
  ref?: string;
  /** Saved since Pando started, so not yet what runs (R-253). */
  pending_restart?: boolean;
  /** What a routing adapter has Pando run in front of itself, such as Traefik
   *  (R-174). The reason is only there for whoever may change the adapter. */
  edge?: { running: boolean; message?: string; checked_at?: string };
  [key: string]: unknown;
}

type Row = AdapterRow & {
  kindName: string;
  connection?: SourceConnection;
  notify?: NotifyAdapter;
  managed: boolean;
  fields: AdapterKind['fields'];
};

type Tone = NonNullable<StatusIndicatorProps['status']>;

interface State {
  status: Tone;
  label: string;
  title?: string;
}

/** A source connection's state: whether it holds what it needs (R-091). */
function connectionState(c: SourceConnection): State {
  if (c.problem) return { status: 'failed', label: 'Cannot be used', title: c.problem };
  if (!c.capabilities.authorized) return { status: 'info', label: 'Not authorized' };
  return { status: 'running', label: 'Ready', title: covers(c) };
}

/** A notification adapter's state: whether it is connected. */
function notifyState(n: NotifyAdapter): State {
  if (n.problem) return { status: 'failed', label: 'Cannot be used', title: n.problem };
  if (connectable(n) && !n.capabilities.authorized) return { status: 'info', label: 'Not connected' };
  return { status: 'running', label: 'Ready' };
}

/**
 * An adapter's state, as a symbol and a word. Live, not stored: one that was
 * reachable at startup and is not now is exactly what this is for. A source
 * connection's question is whether it holds what it needs (R-091); a
 * notification adapter's, whether it is connected.
 */
export function stateOf(row: Pick<Row, 'status' | 'pending_restart' | 'healthy' | 'edge' | 'connection' | 'notify'>): State {
  // Replaced by one the config file declares (R-271): not running, and not
  // broken either.
  if (row.status === 'overridden') return { status: 'stopped', label: 'Replaced by config file' };
  if (row.pending_restart) return { status: 'info', label: 'Restart to apply' };
  if (row.connection) return connectionState(row.connection);
  if (row.notify) return notifyState(row.notify);
  // Reachable is not the same as working: a Traefik that could not start
  // leaves every app behind it unreachable.
  if (row.healthy !== false && row.edge && !row.edge.running) {
    return { status: 'failed', label: 'Not running', title: row.edge.message };
  }
  return row.healthy === false ? { status: 'failed', label: 'Unreachable' } : { status: 'running', label: 'Working' };
}

const RANK: Record<Tone, number> = { failed: 3, building: 2, info: 2, stopped: 1, running: 0 };

/** The worst of several states: what a category's symbol shows. */
export function worstOf(states: State[]): State | undefined {
  return states.reduce<State | undefined>((w, s) => (!w || RANK[s.status] > RANK[w.status] ? s : w), undefined);
}

/** A setting's value as read: On or Off for a switch, a list or an object as
 *  its JSON, anything else as written. */
function settingText(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v as string | number | bigint);
}

/** The settings worth reading at a glance: its ID, and every setting of its
 *  kind that is not a secret and has a value. Credentials are never in
 *  `config` (R-190), and a field marked as one is left out whatever it holds. */
export function settingsOf(row: Pick<Row, 'id' | 'config' | 'fields'>): Array<[string, string]> {
  const out: Array<[string, string]> = [['ID', row.id]];
  for (const f of row.fields ?? []) {
    if (f.credential) continue;
    const v = row.config?.[f.key];
    if (v === undefined || v === null || v === '') continue;
    out.push([f.label, settingText(v)]);
  }
  return out;
}

/** "Add another", or "Add image registry" for a category with none. */
function addLabel(category: string, any: boolean): string {
  if (any) return 'Add another';
  const label = categoryLabel(category);
  return `Add ${label === 'AI' ? label : label.toLowerCase()}`;
}

/** A source connection (R-091), an image registry (issue #153) and a
 *  notification adapter are used the moment they are saved; every other
 *  category waits on a restart. */
function usedOnSave(category: string | undefined): boolean {
  return category === 'source' || category === 'image_registry' || category === 'notify';
}

/** What came back from a browser authorization, what was just done, and what
 *  the last save warned of. */
function Notices({
  returnedError,
  returnedOK,
  notice,
  warnings,
  onWarnings,
}: Readonly<{
  returnedError: string | null;
  returnedOK: string | null;
  notice: string | null;
  warnings: string[];
  onWarnings: (warnings: string[]) => void;
}>) {
  return (
    <>
      {returnedError && <Banner tone="failed">{returnedError}</Banner>}
      {(notice || (returnedOK && !returnedError)) && (
        <Banner tone="info">{notice ?? `${returnedOK} is authorized and ready.`}</Banner>
      )}
      {warnings.map((w) => (
        <InlineWarning key={w} onDismiss={() => onWarnings(warnings.filter((x) => x !== w))}>
          {w}
        </InlineWarning>
      ))}
    </>
  );
}

/** Saved changes waiting on a restart, named when there is one. */
function RestartNotice({
  saved,
  canManage,
  onRestarted,
}: Readonly<{ saved: string | null; canManage: boolean; onRestarted: () => void }>) {
  return (
    <Banner tone="info" action={canManage ? <RestartButton onRestarted={onRestarted} /> : undefined}>
      {saved ? `${saved} is saved.` : 'Adapter changes are saved.'} Restart Pando to apply {saved ? 'it' : 'them'}.
      {canManage ? null : <> Someone who can manage adapters can restart it.</>}
    </Banner>
  );
}

export function Installation({
  query,
  category: chosen,
  onCategory,
  hrefOf,
}: Readonly<{
  query?: string;
  /** The category shown, from the address. */
  category?: string;
  onCategory?: (category: string | undefined) => void;
  hrefOf?: (category: string | undefined) => string;
}> = {}) {
  const queries = useQueryClient();
  const narrow = useNarrow();
  // Only on the verb (R-082): install.view shows the list, and holding it says
  // nothing about being allowed to change what is in it.
  const canManage = useInstallVerb(InstallVerb.AdaptersManage);
  const [picked, setPicked] = useState<string | undefined>(chosen);
  useEffect(() => setPicked(chosen), [chosen]);
  const choose = (c: string | undefined) => {
    setPicked(c);
    onCategory?.(c);
  };
  const [editing, setEditing] = useState<{ existing?: AdapterRow; category?: string } | null>(null);
  const [viewing, setViewing] = useState<Row | null>(null);
  const [defaulting, setDefaulting] = useState<{ row: Row; previous?: Row } | null>(null);
  // Which adapter was just saved, to name it in the restart notice. The
  // notice itself follows the server's restart_needed, so it stays until
  // Pando has restarted — across a reload, and for everyone who looks.
  const [saved, setSaved] = useState<string | null>(null);
  // A source connection (R-091) and an image registry (issue #153) are used
  // the moment they are saved, so saving one says that instead.
  const [notice, setNotice] = useState<string | null>(null);
  // What the last save said may not work as wanted. Never a refusal.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [authorizing, setAuthorizing] = useState<SourceConnection | null>(null);
  const [disconnecting, setDisconnecting] = useState<SourceConnection | null>(null);
  const [connecting, setConnecting] = useState<NotifyAdapter | null>(null);
  // A notification adapter just saved that connects, such as Slack, opens
  // its connection straight away.
  const [toConnect, setToConnect] = useState<string | null>(null);

  // A browser authorization of a source comes back here with its outcome.
  const back = new URLSearchParams(query ?? '');
  const returnedError = back.get('error');
  const returnedOK = back.get('authorized');
  // The CLI and an assistant send a person here to authorize a connection
  // only a browser can: a GitHub App, whose manifest the browser posts.
  const [toAuthorize, setToAuthorize] = useState<string | null>(back.get('authorize'));
  // A GitHub App just installed has one step left, its logo.
  const [logoFor, setLogoFor] = useState<string | null>(returnedError ? null : returnedOK);

  const sources = useSources();
  const connections = new Map((sources.data?.sources ?? []).map((s) => [s.id, s]));
  useEffect(() => {
    if (!toAuthorize || !sources.data) return;
    const c = (sources.data.sources ?? []).find((s) => s.id === toAuthorize);
    setToAuthorize(null);
    if (c && needsAuthorizing(c)) setAuthorizing(c);
  }, [toAuthorize, sources.data]);

  const notify = useNotifyAdapters();
  const notifiers = new Map((notify.data?.adapters ?? []).map((a) => [a.id, a]));
  useEffect(() => {
    if (!toConnect || !notify.data) return;
    const a = (notify.data.adapters ?? []).find((n) => n.id === toConnect);
    setToConnect(null);
    if (a && needsConnecting(a)) setConnecting(a);
  }, [toConnect, notify.data]);
  const logoNotifier = logoFor ? notifiers.get(logoFor) : undefined;
  const disconnect = useMutation({
    mutationFn: (id: string) => api.del<void>(`/sources/${encodeURIComponent(id)}`),
    onSuccess: (_, id) => {
      setDisconnecting(null);
      setNotice(`Disconnected ${id}.`);
      void queries.invalidateQueries({ queryKey: ['adapters'] });
      void queries.invalidateQueries({ queryKey: ['sources'] });
    },
  });

  const adapters = useQuery({
    queryKey: ['adapters'],
    queryFn: () => api.get<{ adapters: AdapterRow[]; restart_needed?: boolean } | AdapterRow[]>('/adapters'),
  });
  const restartNeeded = !Array.isArray(adapters.data) && adapters.data?.restart_needed === true;
  const stored = normalize(adapters.data).map((r) => ({ ...r, id: r.id ?? r.ref ?? '' }));
  const kinds = useQuery({
    queryKey: ['adapter-kinds'],
    queryFn: () => api.get<{ kinds: AdapterKind[] | null }>('/adapters/kinds'),
  });
  const catalog = kinds.data?.kinds ?? [];
  const rows: Row[] = stored.map((r) => {
    const kind = catalog.find((k) => k.category === r.category && k.kind === r.kind);
    return {
      ...r,
      kindName: kind?.name ?? r.kind,
      fields: kind?.fields ?? null,
      connection: r.category === 'source' ? connections.get(r.id) : undefined,
      notify: r.category === 'notify' ? notifiers.get(r.id) : undefined,
      managed: isManaged(catalog, r),
    };
  });
  const order = orderCategories([...rows.map((r) => r.category), ...catalog.map((k) => k.category)]);
  const inCategory = (c: string) =>
    rows
      .filter((r) => r.category === c)
      // The default first, then by name.
      .sort((a, b) => Number(b.is_default ?? false) - Number(a.is_default ?? false) || (a.name || a.id).localeCompare(b.name || b.id));
  // A category from the address, or the first that holds anything.
  const current =
    order.find((c) => c === picked) ?? order.find((c) => rows.some((r) => r.category === c)) ?? order[0];
  const canAdd = (c: string) => canManage && addableKinds(catalog).some((k) => k.category === c);

  const makeDefault = useMutation({
    mutationFn: (row: Row) =>
      api.post('/adapters', {
        id: row.id,
        category: row.category,
        kind: row.kind,
        name: row.name || row.kindName,
        config: row.config ?? {},
        is_default: true,
        // Sent so making it the default does not turn on one that is off.
        enabled: row.enabled,
      }),
    onSuccess: (_, row) => {
      setDefaulting(null);
      if (usedOnSave(row.category)) {
        setNotice(`${row.name || row.kindName} is the default. No restart is needed.`);
      } else {
        setSaved(row.name || row.kindName);
      }
      void queries.invalidateQueries({ queryKey: ['adapters'] });
    },
  });

  const showList = !narrow || !chosen;
  const showDetail = !narrow || Boolean(chosen);

  return (
    <SystemPage
      title="Adapters"
      // Always here, not only while a change waits on it: a restart is also
      // how an adapter that failed at startup is retried. Red: it takes every
      // app offline for a moment.
      action={canManage && <RestartButton onRestarted={() => setSaved(null)} />}
    >
      {adapters.isError && <Quiet>{messageOf(adapters.error)}</Quiet>}
      <Notices
        returnedError={returnedError}
        returnedOK={returnedOK}
        notice={notice}
        warnings={warnings}
        onWarnings={setWarnings}
      />
      {(restartNeeded || saved) && (
        <RestartNotice saved={saved} canManage={canManage} onRestarted={() => setSaved(null)} />
      )}

      {adapters.isPending ? (
        <output aria-label="Loading" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {[0, 1, 2, 3].map((n) => (
            <LineSkeleton key={n} width="20ch" />
          ))}
        </output>
      ) : (
        <div className={narrow ? undefined : 'pando-adapters'}>
          {showList && (
            <Categories
              order={order}
              current={narrow ? undefined : current}
              rowsOf={inCategory}
              onPick={choose}
              hrefOf={hrefOf}
              lines={narrow}
            />
          )}
          {showDetail && current && (
            <Category
              category={current}
              rows={inCategory(current)}
              canManage={canManage}
              onBack={narrow ? () => choose(undefined) : undefined}
              backHref={hrefOf?.(undefined)}
              onAdd={canAdd(current) ? () => setEditing({ category: current }) : undefined}
              onEdit={(row) => setEditing({ existing: row })}
              onView={setViewing}
              onDefault={(row) => setDefaulting({ row, previous: inCategory(current).find((r) => r.is_default && r.id !== row.id) })}
              onAuthorize={setAuthorizing}
              onConnect={setConnecting}
              onDisconnect={setDisconnecting}
            />
          )}
        </div>
      )}

      {editing && (
        <AdapterDialog
          existing={editing.existing}
          category={editing.category}
          adapters={stored}
          onClose={() => setEditing(null)}
          onSaved={(name, category, saveWarnings, id) => {
            setEditing(null);
            setWarnings(saveWarnings ?? []);
            if (usedOnSave(category)) {
              setNotice(`${name} is saved and in use. No restart is needed.`);
              if (category === 'source') {
                void queries.invalidateQueries({ queryKey: ['sources'] }).then(() => setToAuthorize(id ?? null));
              }
              if (category === 'notify') {
                void queries.invalidateQueries({ queryKey: ['notify'] }).then(() => setToConnect(id ?? null));
              }
            } else {
              setSaved(name);
            }
            void queries.invalidateQueries({ queryKey: ['adapters'] });
          }}
        />
      )}

      {viewing && (
        <Dialog
          open
          title={viewing.name || viewing.kindName}
          description={`Set in ${declaredAt(viewing)}. Change it there, then restart Pando.`}
          onClose={() => setViewing(null)}
          footer={
            <Button variant="secondary" onClick={() => setViewing(null)}>
              Close
            </Button>
          }
        >
          <Settings row={viewing} />
        </Dialog>
      )}

      {defaulting && (
        <MakeDefaultDialog
          row={defaulting.row}
          previous={defaulting.previous}
          pending={makeDefault.isPending}
          error={makeDefault.error}
          onConfirm={() => makeDefault.mutate(defaulting.row)}
          onClose={() => setDefaulting(null)}
        />
      )}

      {authorizing && (
        <AuthorizeDialog
          source={authorizing}
          onClose={() => setAuthorizing(null)}
          onAuthorized={() => {
            setNotice(`${authorizing.name} is authorized and ready.`);
            setAuthorizing(null);
            void queries.invalidateQueries({ queryKey: ['sources'] });
          }}
        />
      )}

      {connecting && (
        <ConnectNotifyDialog
          adapter={connecting}
          onClose={() => setConnecting(null)}
          onConnected={() => {
            setNotice(`${connecting.name} is connected and ready.`);
            setLogoFor(connecting.id);
            setConnecting(null);
            void queries.invalidateQueries({ queryKey: ['notify'] });
          }}
        />
      )}

      {logoNotifier?.capabilities.authorized && !logoNotifier.capabilities.icon_set && (
        <SlackLogoDialog adapter={logoNotifier} onClose={() => setLogoFor(null)} />
      )}

      {logoFor && connections.get(logoFor)?.capabilities.manage_url && (
        <AppLogoDialog manageURL={connections.get(logoFor)!.capabilities.manage_url!} where={githubLogoPlace} onClose={() => setLogoFor(null)} />
      )}

      {disconnecting && (
        <DisconnectDialog
          source={disconnecting}
          pending={disconnect.isPending}
          error={disconnect.error}
          onConfirm={() => disconnect.mutate(disconnecting.id)}
          onClose={() => setDisconnecting(null)}
        />
      )}
    </SystemPage>
  );
}

/** Asks before deleting a source connection's stored credential. */
function DisconnectDialog({
  source,
  pending,
  error,
  onConfirm,
  onClose,
}: Readonly<{ source: SourceConnection; pending: boolean; error: unknown; onConfirm: () => void; onClose: () => void }>) {
  return (
    <Dialog
      open
      title={`Disconnect ${source.name}`}
      description="Its stored credential is deleted. Apps that use it keep running. Their next deployment fails until another connection covers their repository."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? 'Disconnecting' : 'Disconnect'}
          </Button>
        </>
      }
    >
      {error ? <Banner tone="failed">{messageOf(error)}</Banner> : null}
    </Dialog>
  );
}

/** Asks before making an adapter its category's default, saying which one it
 *  takes over from. */
function MakeDefaultDialog({
  row,
  previous,
  pending,
  error,
  onConfirm,
  onClose,
}: Readonly<{
  row: Row;
  previous?: Row;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  onClose: () => void;
}>) {
  const name = row.name || row.kindName;
  return (
    <Dialog
      open
      title={`Make ${name} the default?`}
      description={previous ? defaultHandover(name, previous.name || previous.id, row.category) : undefined}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending} onClick={onConfirm}>
            {pending ? 'Saving' : 'Make default'}
          </Button>
        </>
      }
    >
      {error ? <Banner tone="failed">{refusal(error)}</Banner> : null}
    </Dialog>
  );
}

/**
 * Every category, with the worst status of what it holds and how many when
 * it holds more than one. At phone width each is a row naming its adapters
 * and the problem, if any, that opens the category.
 */
function Categories({
  order,
  current,
  rowsOf,
  onPick,
  hrefOf,
  lines,
}: Readonly<{
  order: string[];
  current?: string;
  rowsOf: (c: string) => Row[];
  onPick: (c: string) => void;
  hrefOf?: (c: string) => string;
  lines: boolean;
}>) {
  return (
    <nav aria-label="Adapter categories" className="pando-adapter-cats">
      {order.map((c) => {
        const rows = rowsOf(c);
        const worst = worstOf(rows.map(stateOf));
        const label = categoryLabel(c);
        const problem = worst && worst.status !== 'running' ? worst.label : undefined;
        const body = (
          <>
            <StatusSymbol status={worst?.status ?? 'stopped'} />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
              <span>{label}</span>
              {lines && (
                <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>
                  {rows.length === 0 ? 'Not set up' : [rows.map((r) => r.name || r.kindName).join(', '), problem].filter(Boolean).join(' · ')}
                </span>
              )}
            </span>
            {!lines && rows.length > 1 && <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>{rows.length}</span>}
            {lines && <Icon name="chevron-right" />}
          </>
        );
        return (
          <RouteLink
            key={c}
            href={hrefOf?.(c) ?? `#${c}`}
            aria-current={c === current ? 'true' : undefined}
            aria-label={`${label}: ${rows.length === 0 ? 'not set up' : (worst?.label ?? '')}`}
            onFollow={() => onPick(c)}
          >
            {body}
          </RouteLink>
        );
      })}
    </nav>
  );
}

/** One category: what it is for, and each of its adapters as a card. */
function Category({
  category,
  rows,
  canManage,
  onBack,
  backHref,
  onAdd,
  onEdit,
  onView,
  onDefault,
  onAuthorize,
  onConnect,
  onDisconnect,
}: Readonly<{
  category: string;
  rows: Row[];
  canManage: boolean;
  onBack?: () => void;
  backHref?: string;
  onAdd?: () => void;
  onEdit: (row: Row) => void;
  onView: (row: Row) => void;
  onDefault: (row: Row) => void;
  onAuthorize: (c: SourceConnection) => void;
  onConnect: (a: NotifyAdapter) => void;
  onDisconnect: (c: SourceConnection) => void;
}>) {
  const several = rows.length > 1;
  return (
    <section aria-label={categoryLabel(category)} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', minWidth: 0 }}>
      {onBack && (
        <RouteLink href={backHref ?? '#'} onFollow={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)', font: 'var(--type-body-ui)', color: 'var(--ink-secondary)' }}>
          <Icon name="arrow-left" size={14} />
          Adapters
        </RouteLink>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minWidth: 0 }}>
          <h3 style={{ font: 'var(--type-h3)', color: 'var(--ink)', margin: 0 }}>{categoryLabel(category)}</h3>
          {categoryNote(category) && <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>{categoryNote(category)}</span>}
        </div>
        {onAdd && (
          <Button variant="secondary" icon={<Icon name="plus" size={14} />} onClick={onAdd}>
            {addLabel(category, rows.length > 0)}
          </Button>
        )}
      </div>
      {rows.length === 0 && <Quiet>Not set up</Quiet>}
      {rows.map((row) => (
        <AdapterCard
          key={row.id}
          row={row}
          several={several}
          canManage={canManage}
          onEdit={() => onEdit(row)}
          onView={() => onView(row)}
          onDefault={() => onDefault(row)}
          onAuthorize={onAuthorize}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
      ))}
    </section>
  );
}

function AdapterCard({
  row,
  several,
  canManage,
  onEdit,
  onView,
  onDefault,
  onAuthorize,
  onConnect,
  onDisconnect,
}: Readonly<{
  row: Row;
  several: boolean;
  canManage: boolean;
  onEdit: () => void;
  onView: () => void;
  onDefault: () => void;
  onAuthorize: (c: SourceConnection) => void;
  onConnect: (a: NotifyAdapter) => void;
  onDisconnect: (c: SourceConnection) => void;
}>) {
  const state = stateOf(row);
  // What can be done here. Declared in the config file, it is read-only here
  // while it is (R-271); a kind Pando sets up itself is shown, not edited.
  const changeable = canManage && !row.declared && row.status !== 'overridden';
  const c = row.connection;
  const authorizable = Boolean(c && (c.capabilities.device_authorization || c.capabilities.web_authorization));
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-4) var(--space-5)',
        background: 'var(--paper-raised)',
        border: 'var(--border-width) solid var(--rule)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2) var(--space-4)' }}>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minWidth: 0 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', font: 'var(--type-label)', color: 'var(--ink)' }}>
            {row.name || row.kindName}
            {several && row.is_default && <Tag>Default</Tag>}
          </span>
          <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>{row.kindName}</span>
        </span>
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
          <StatusIndicator status={state.status} label={state.label} title={state.title} />
          {changeable && several && !row.is_default && row.category !== 'ai' && (
            <Button variant="ghost" onClick={onDefault}>
              Make default
            </Button>
          )}
          {/* A source connection signed in with OAuth is authorized here,
              and disconnected here (R-091). */}
          {changeable && c && authorizable && (
            <Button variant="secondary" onClick={() => onAuthorize(c)}>
              {c.capabilities.authorized ? 'Authorize again' : 'Authorize'}
            </Button>
          )}
          {changeable && row.notify && connectable(row.notify) && (
            <Button variant="secondary" onClick={() => onConnect(row.notify!)}>
              {row.notify.capabilities.authorized ? 'Connect again' : 'Connect'}
            </Button>
          )}
          {changeable && !row.managed && (
            <Button variant="secondary" onClick={onEdit}>
              Edit
            </Button>
          )}
          {row.declared && (
            <Button variant="secondary" onClick={onView}>
              View
            </Button>
          )}
          {changeable && c && (
            <Button variant="ghost" onClick={() => onDisconnect(c)}>
              Disconnect
            </Button>
          )}
        </span>
      </div>
      <Settings row={row} />
    </div>
  );
}

function Settings({ row }: Readonly<{ row: Row }>) {
  const facts = settingsOf(row);
  if (row.declared) facts.push(['Set in', (row.source as { kind?: string } | undefined)?.kind === 'env' ? 'Environment' : 'Config file']);
  return (
    <dl className="pando-facts">
      {facts.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd style={k === 'ID' ? { font: 'var(--type-code-sm)' } : undefined}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** GET /adapters has returned both shapes during this phase; accept either
 *  rather than break the screen on the one that turns out to be current. */
function normalize(data: { adapters: AdapterRow[] } | AdapterRow[] | undefined): AdapterRow[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.adapters ?? [];
}
