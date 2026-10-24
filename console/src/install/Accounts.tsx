// Accounts — the screen behind install.users.manage and install.view.
//
// This is where an administrator hands over. Until it existed, the only account
// that could administer a Pando install was the one bootstrap created on first
// run: the verbs existed, the role existed, and nothing could write a second
// grant. An install had exactly one administrator forever.
//
// The list is read-only: who each account is, what it signs in with, its
// installation roles and whether it can sign in. A row opens the account's own page (Account.tsx), which
// holds the actions — two separate ones, because they are two separate powers.
// Suspending an account stops it signing in (R-049); changing its role changes
// what it may do. The API keeps them on different routes and different verbs,
// and the console does not merge them back together.
//
// Nobody types a password for somebody else. Adding an account shows one Pando
// generated (GeneratedPassword.tsx), for the administrator to pass on.

import { useContext, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Button, Dialog, Input, Select, StatusIndicator, Tabs, Tag } from '@design';
import { Avatar } from './Avatar';

import { api, RequestFailed } from '@api/client';
import { InstallVerb, useInstallVerb } from '../app/principal';
import { GeneratedPassword } from './GeneratedPassword';
import { SystemTabs } from './systemTabs';
import { Sheet } from '../ui/Sheet';
import { SearchField } from '../ui/SearchField';
import { ShowMore, usePaged, useSettled, type PageOf } from '../ui/paged';
import { Table } from '../ui/Table';
import { useNarrow } from '../ui/narrow';
import { RouteLink } from '../ui/RouteLink';
import { format } from '../app/route';
import './accounts.css';
import { FailedBanner } from '../ui/ErrorCode';

export interface Account {
  id: string;
  adapter_id: string;
  /** The identity provider's name: "Local users" for a local account (R-045). */
  adapter_name?: string;
  external_id: string;
  email?: string;
  display_name?: string;
  status: string;
  must_change_password: boolean;
  /** A local account with an authenticator set up (R-405). */
  two_factor_enabled?: boolean;
  /** The role granted to the account itself; '' for none. What RolePicker sets. */
  install_role_id: string;
  /**
   * Every installation role the account holds, directly and through its
   * groups (issue #221) — what authorization evaluates. Empty for none.
   */
  install_roles?: HeldRole[];
  created_at?: string;
  /** Set on an account whose sign-in identities were moved to another (O-1). */
  alias_of?: string;
}

export interface HeldRole {
  role_id: string;
  /** The role's name, from the account itself: readable without GET /roles. */
  role_name?: string;
  via: {
    kind: 'direct' | 'group';
    group_id?: string;
    name?: string;
    /** The identity provider a synced group comes from, and its name. */
    source?: string;
    source_name?: string;
  };
}

export interface Role {
  id: string;
  name: string;
  builtin: boolean;
  verbs: string[];
}

export function Accounts({ onOpen }: { onOpen: (account: Account) => void }) {
  const manage = useInstallVerb(InstallVerb.UsersManage);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');

  // A page at a time, searched by the server — username, name or email — so
  // the account being looked for is found whichever page it would be on
  // (issue #72). Status and role narrow in the table's own column filters.
  const accounts = usePaged<{ users: Account[] | null } & PageOf, Account>({
    key: ['users', 'list'],
    path: '/users',
    rows: (p) => p.users,
    search: useSettled(query.trim()),
  });
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<{ roles: Role[] }>('/roles'),
  });

  const rows = accounts.rows;
  const narrow = useNarrow();

  return (
    <Screen
      heading="Accounts"
      action={
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)' }}>
          {manage && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add account
            </Button>
          )}
          {(rows.length > 0 || query !== '') && <SearchField value={query} onChange={setQuery} placeholder="Search accounts" />}

        </div>
      }
    >
      {accounts.query.isError && <Quiet>{messageOf(accounts.query.error)}</Quiet>}

      {narrow ? (
        <AccountRows rows={rows} roles={roles.data?.roles ?? []} onOpen={onOpen} />
      ) : (
        <Table
          loading={accounts.query.isPending}
          onRowClick={onOpen}
          rowHref={(a: Account) => format({ view: 'admin', section: 'accounts', userID: a.id })}
          columns={[
            {
              key: 'display_name',
              header: 'Name',
              width: 'minmax(0,1.4fr)',
              filter: 'text',
              filterValue: (row: Account) => [row.display_name ?? '', row.external_id],
              render: (row: Account) => <NameCell account={row} />,
            },
            {
              key: 'email',
              header: 'Email',
              width: 'minmax(0,1fr)',
              muted: true,
              filter: 'text',
              render: (row: Account) => row.email || '—',
            },
            {
              key: 'adapter_name',
              header: 'Signs in with',
              width: 'minmax(0,16ch)',
              filter: 'values',
              filterValue: (row: Account) => providerName(row),
              render: (row: Account) => providerName(row),
            },
            {
              key: 'install_role_id',
              header: 'Role',
              width: 'minmax(0,1fr)',
              filter: 'values',
              // Each role on its own, so the filter offers roles rather than
              // combinations of them.
              filterValue: (row: Account) => heldRoleNames(row.install_roles ?? [], roles.data?.roles ?? []),
              // Read-only here; it changes on the account's page, or on the
              // group a role comes through.
              render: (row: Account) => <RoleTags held={row.install_roles ?? []} roles={roles.data?.roles ?? []} />,
            },
            {
              key: 'status',
              header: 'Status',
              width: '14ch',
              filter: 'values',
              filterValue: (row: Account) => statusLabel(row),
              render: (row: Account) => <AccountStatus account={row} />,
            },
          ]}
          rows={rows}
          empty={query.trim() === '' ? undefined : <Quiet>No accounts match &ldquo;{query.trim()}&rdquo;.</Quiet>}
        />
      )}
      <ShowMore query={accounts.query} label="Show more accounts" />

      {adding && <AddAccount onClose={() => setAdding(false)} />}
    </Screen>
  );
}

/**
 * A held role's name as the console shows it: from the roles list, else the
 * name the account carries — somebody reading their own account cannot read
 * GET /roles — else its ID.
 */
function roleName(h: HeldRole, roles: Role[]): string {
  const name = roles.find((r) => r.id === h.role_id)?.name ?? h.role_name;
  return name ? sentence(name) : h.role_id;
}

/** The distinct names of the roles an account holds, each once, for the Role column's filter; "None" for none. */
export function heldRoleNames(held: HeldRole[], roles: Role[]): string[] {
  const names = [...new Set(held.map((h) => roleName(h, roles)))];
  names.sort((x, y) => x.localeCompare(y));
  return names.length > 0 ? names : ['None'];
}

/**
 * After a group's membership or links change: the groups, and every account
 * view — an account, the list, its apps — since a group carries an
 * installation role and app access to everyone in it (issue #221).
 */
export function refreshMembership(queries: QueryClient) {
  void queries.invalidateQueries({ queryKey: ['groups'] });
  void queries.invalidateQueries({ queryKey: ['users'] });
}

/** The installation roles an account holds, each once, as tags. Where one
 *  comes from — the account, or a group — is the account page's to say. */
export function RoleTags({ held, roles }: Readonly<{ held: HeldRole[]; roles: Role[] }>) {
  const names = [...new Set(held.map((h) => roleName(h, roles)))];
  if (names.length === 0) return <span style={caption}>No role</span>;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1) var(--space-2)', padding: 'var(--space-2) 0' }}>
      {names.map((n) => (
        <Tag key={n}>{n}</Tag>
      ))}
    </span>
  );
}

/** The names of the roles an account holds, each once, joined: "App manager, Auditor". */
export function roleNames(held: HeldRole[], roles: Role[]): string {
  return [...new Set(held.map((h) => roleName(h, roles)))].join(', ');
}

const caption = { font: 'var(--type-caption)', color: 'var(--ink-secondary)' };

/** The identity provider an account signs in with, by name. A local
 *  account signs in with a password. */
export function providerName(a: Pick<Account, 'adapter_id' | 'adapter_name'>): string {
  if (a.adapter_id === LOCAL_PROVIDER) return 'Password';
  return a.adapter_name || a.adapter_id;
}

/** The local identity provider's ID. */
export const LOCAL_PROVIDER = 'idp_local';

function statusLabel(a: Account): string {
  return a.status === 'active' ? 'Active' : 'Suspended';
}

/** Active or Suspended. Suspended is a stopped account, not a failed one:
 *  marker red is for failure and destruction, and an account somebody
 *  deliberately suspended is neither. */
export function AccountStatus({ account }: Readonly<{ account: Account }>) {
  return <StatusIndicator status={account.status === 'active' ? 'running' : 'stopped'} label={statusLabel(account)} />;
}

/** The account's name, with its username under it. */
function NameCell({ account }: Readonly<{ account: Account }>) {
  const name = account.display_name || account.external_id;
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0, padding: 'var(--space-2) 0' }}>
      <Avatar name={name} />
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ font: 'var(--type-label)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
        <span style={{ font: 'var(--type-code-sm)', color: 'var(--ink-secondary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {account.external_id}
        </span>
      </span>
    </span>
  );
}

/** The list at phone width: the name across, then the roles and the status. */
function AccountRows({
  rows,
  roles,
  onOpen,
}: Readonly<{ rows: Account[]; roles: Role[]; onOpen: (a: Account) => void }>) {
  return (
    <ul className="pando-account-rows">
      {rows.map((a) => (
        <li key={a.id}>
          <RouteLink
            href={format({ view: 'admin', section: 'accounts', userID: a.id })}
            onFollow={() => onOpen(a)}
            className="pando-account-row"
          >
            <span className="pando-account-row-name">
              <NameCell account={a} />
            </span>
            <RoleTags held={a.install_roles ?? []} roles={roles} />
            <span className="pando-account-row-status">
              <AccountStatus account={a} />
            </span>
          </RouteLink>
        </li>
      ))}
    </ul>
  );
}

export function RolePicker({
  account,
  roles,
  isSelf,
}: {
  account: Account;
  roles: Role[];
  isSelf: boolean;
}) {
  const queries = useQueryClient();
  const [error, setError] = useState<string>();

  const change = useMutation({
    mutationFn: (roleID: string) =>
      roleID === ''
        ? api.del<void>(`/users/${account.id}/role`)
        : api.put<unknown>(`/users/${account.id}/role`, { role_id: roleID }),
    onSuccess: () => {
      setError(undefined);
      void queries.invalidateQueries({ queryKey: ['users'] });
      // Your own verbs may have just changed, and the sidebar reads them.
      void queries.invalidateQueries({ queryKey: ['me'] });
    },
    // The server's refusal, shown as written — "this is the only account that
    // can manage accounts" is exactly what the person needs to read.
    onError: (e) => setError(messageOf(e)),
  });

  return (
    <Select
      value={account.install_role_id}
      disabled={change.isPending}
      onChange={(e) => change.mutate(e.target.value)}
      options={[
        { value: '', label: isSelf ? 'None (gives up your role)' : 'None' },
        ...roles.map((r) => ({ value: r.id, label: sentence(r.name) })),
      ]}
      helper={error}
    />
  );
}

export function StatusToggle({ account }: { account: Account }) {
  const queries = useQueryClient();
  const suspended = account.status !== 'active';

  const set = useMutation({
    mutationFn: (status: string) => api.patch<void>(`/users/${account.id}`, { status }),
    onSuccess: () => void queries.invalidateQueries({ queryKey: ['users'] }),
  });

  // Suspending ends every session the account holds, immediately (R-048). That
  // is worth saying before it happens rather than after.
  return (
    <Button
      variant="secondary"
      disabled={set.isPending}
      onClick={() => set.mutate(suspended ? 'active' : 'suspended')}
    >
      {suspended ? 'Reinstate' : 'Suspend'}
    </Button>
  );
}

function AddAccount({ onClose }: { onClose: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const queries = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api.post<unknown>('/users', {
        username,
        password,
        display_name: displayName,
        must_change_password: mustChange,
      }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });

  return (
    <Dialog
      open
      title="Add account"
      // The password is only ever on this screen: Pando cannot show it again
      // and sends it nowhere, so handing it over is the administrator's job.
      description="A local account with a password Pando generates. Pando doesn’t send it to them."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={create.isPending || username === '' || password === ''}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Adding' : 'Add account'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Input
          label="Username"
          value={username}
          onChange={(e) => {
            // A refusal ("that username is taken") belongs to the value that
            // caused it.
            if (create.isError) create.reset();
            setUsername(e.target.value);
          }}
        />
        <Input
          label="Name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <GeneratedPassword
          value={password}
          onChange={setPassword}
          mustChange={mustChange}
          onMustChange={setMustChange}
        />
        {create.isError && <FailedBanner error={create.error} remedy />}
      </div>
    </Dialog>
  );
}

/** Every install screen is one sheet. The frame lives in Sheet. */
export function Screen({
  heading,
  action,
  children,
}: {
  heading: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  // Left-aligned and uncapped: the rules under a table run to the window's
  // edge, and the screen's action sits beside its heading rather than at the
  // far end of a measure. Sheet keeps both and adds the neatline.
  const system = useContext(SystemTabs);
  if (system) {
    // A tab of System: System's heading, this screen's action, then the tabs
    // — spaced as an app's tabs are. Pinned, and one height across the tabs
    // whatever each one's action is.
    return (
      <Sheet
        heading="System"
        action={action}
        pinned
        tabs={<Tabs value={system.value} onChange={system.onChange} items={system.items} />}
      >
        {children}
      </Sheet>
    );
  }
  return (
    <Sheet heading={heading} action={action}>
      {children}
    </Sheet>
  );
}

export function Quiet({ children }: { children: React.ReactNode }) {
  return <p style={{ font: 'var(--type-body-ui)', color: 'var(--ink-secondary)' }}>{children}</p>;
}

export function messageOf(error: unknown): string {
  if (error instanceof RequestFailed) return error.message;
  return 'Pando could not reach the server. Reload the page to try again.';
}

/** The server's message and, when it gave one, its remedy (R-105). Most
 *  refusals on these screens are the last-administrator rule (R-088), and the
 *  remedy is the way through it. */
export function refusal(error: unknown): string {
  const remedy = error instanceof RequestFailed ? error.remedy : undefined;
  return remedy ? `${messageOf(error)} ${remedy}` : messageOf(error);
}

/** Role names are stored lowercase; the design system sets everything in
 *  sentence case. */
export function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
