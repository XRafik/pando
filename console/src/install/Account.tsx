// One account: who it is, what it can do here, the actions on it, and its
// latest activity — audit events where it is the actor or the target — with a
// link to the Audit log narrowed to it, for anything deeper.
//
// The header holds the actions on the account itself: suspend, reset a local
// account's password or two-factor, delete. The Details card says who it is.
// Then three cards side by side: Access (its role, groups, app limit and how
// it signs in, each changed from its own row), Apps and Activity.
//
// A role held through a group is named with the rest and not attributed: the
// group's page says what the group carries. Change sets the role granted to
// the account itself.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banner, Button, Card, Dialog, Icon, IconButton, Input, Select, Tag } from '@design';

import { api } from '@api/client';
import type { Identity } from '@api/types.gen';
import { InstallVerb, useInstallVerb, usePrincipal } from '../app/principal';
import { format } from '../app/route';
import { Sheet } from '../ui/Sheet';
import { CopyInline } from '../ui/CopyField';
import { HeadingSkeleton, LineSkeleton } from '../ui/Loading';
import { RouteLink } from '../ui/RouteLink';
import { relative } from '../ui/time';
import { usePaged, withParams, type PageOf } from '../ui/paged';
import { Identities } from './Identities';
import { AppsDialog } from './AccountApps';
import { AccountAppLimit } from './AppLimit';
import { AccessRow } from './AccessRow';
import { Avatar } from './Avatar';
import { GeneratedPassword, PasswordToCopy } from './GeneratedPassword';
import type { Account, Role } from './Accounts';
import {
  AccountStatus,
  LOCAL_PROVIDER,
  providerName,
  refreshMembership,
  Quiet,
  RolePicker,
  StatusToggle,
  messageOf,
  refusal,
  roleNames,
  sentence,
} from './Accounts';
import { NO_FILTERS, linkQuery } from './audit';
import type { AuditFilters } from './audit';
import { useAuditLog } from './Installation';
import './accounts.css';

/** Groups read for the account page: the most one request returns. */
const GROUPS_LIMIT = 500;

/** Events shown in the Activity card; the rest are in the Audit log. */
const ACTIVITY_SHOWN = 6;

/** Apps shown in the Apps card; Manage lists every one. */
const APPS_SHOWN = 8;

interface Group {
  id: string;
  name: string;
  /** Set when an identity provider owns the membership (R-078). */
  source?: string;
  source_name?: string;
  members?: string[];
  install_role_id?: string;
}

export function AccountPage({
  userID,
  onBack,
  onAudit,
  onGroups,
  onOpenApp,
}: {
  userID: string;
  onBack: () => void;
  /** Opens the Audit log with these filters. */
  onAudit: (query: string) => void;
  /** Opens Groups and roles, where groups are made. */
  onGroups?: () => void;
  /** Opens an app's screen. */
  onOpenApp?: (appID: string) => void;
}) {
  const manage = useInstallVerb(InstallVerb.UsersManage);
  const canReadAudit = useInstallVerb(InstallVerb.AuditRead);
  const me = usePrincipal();
  const isSelf = userID === me.data?.user_id;

  const account = useQuery({
    queryKey: ['users', userID],
    queryFn: () => api.get<Account>(`/users/${userID}`),
  });
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<{ roles: Role[] }>('/roles'),
  });
  const identities = useQuery({
    queryKey: ['users', userID, 'identities'],
    queryFn: () => api.get<{ identities: Identity[] | null }>(`/users/${userID}/identities`),
  });

  const back = (
    <Button variant="ghost" icon={<Icon name="arrow-left" />} onClick={onBack} style={{ alignSelf: 'flex-start' }}>
      Accounts
    </Button>
  );

  if (account.isError) {
    return (
      <Sheet heading={back}>
        <Banner tone="failed">{messageOf(account.error)}</Banner>
      </Sheet>
    );
  }

  // The page's own shape while the account loads: its name and status in the
  // header, and the details with their labels and no values. The labels are
  // the same for every account, so they are real text now rather than later.
  if (!account.data) {
    return (
      <Sheet
        heading={
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--space-3)' }}>
            {back}
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3) var(--space-4)' }}>
              <HeadingSkeleton />
              <LineSkeleton width="8ch" />
            </div>
          </div>
        }
      >
        <Card padding="md" role="status" aria-label="Loading">
          <CardHeading>Details</CardHeading>
          <dl className="pando-account-facts">
            {['Name', 'Email', 'Created', 'Last signed in', 'ID'].map((term) => (
              <Fact key={term} term={term}>
                <LineSkeleton width={term === 'ID' ? '28ch' : '16ch'} />
              </Fact>
            ))}
          </dl>
        </Card>
      </Sheet>
    );
  }

  const a = account.data;
  const name = a.display_name || a.external_id;
  const ids = identities.data?.identities ?? [];

  return (
    <Sheet
      heading={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', width: '100%' }}>
          {back}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 'var(--space-3) var(--space-4)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', minWidth: 0 }}>
              <Avatar name={name} large />
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2) var(--space-3)' }}>
                <h3 style={{ font: 'var(--type-h3)', margin: 0 }}>{name}</h3>
                <AccountStatus account={a} />
              </div>
            </div>
            {manage && !isSelf && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                <StatusToggle account={a} />
                {/* An external provider holds its accounts' passwords; Pando has
                    nothing to reset. */}
                <LocalResets account={a} />
                <DeleteAccount account={a} onDeleted={onBack} />
              </div>
            )}
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Card padding="md">
          <CardHeading
            action={
              // Your own name and email need no permission; everything else
              // here takes install.users.manage, and the dialog says which.
              (manage || isSelf) && <EditDetails account={a} manage={manage} isSelf={isSelf} />
            }
          >
            Details
          </CardHeading>
          <dl className="pando-account-facts">
            {/* An external account's external_id is the provider's ID for the
                person, not a name anyone signs in with. */}
            <Fact term={a.adapter_id === LOCAL_PROVIDER ? 'Username' : `${providerName(a)} ID`} mono>
              {a.external_id}
            </Fact>
            <Fact term="Name">{a.display_name || '—'}</Fact>
            <Fact term="Email">{a.email || '—'}</Fact>
            {a.alias_of && (
              <Fact term="Replaced by" mono>
                {a.alias_of}
              </Fact>
            )}
            <LocalCredentials account={a} />
            <Fact term="Created">{a.created_at ? longDate(a.created_at) : '—'}</Fact>
            <Fact term="Last signed in">
              {identities.isPending ? <LineSkeleton width="12ch" /> : lastSignIn(ids)}
            </Fact>
            <Fact term="ID">
              <CopyInline value={a.id} />
            </Fact>
          </dl>
        </Card>

        <div className="pando-account-cards">
          <Card padding="md">
            <CardHeading>Access</CardHeading>
            <RoleRow account={a} roles={roles.data?.roles} manage={manage} isSelf={isSelf} />
            <GroupsRow account={a} manage={manage} isSelf={isSelf} onGroups={onGroups} />
            <AccountAppLimit userID={a.id} manage={manage} />
            <SignInRow userID={a.id} identities={identities} manage={manage} />
          </Card>
          <AppsCard account={a} manage={manage} onOpenApp={onOpenApp} />
          {canReadAudit && <Activity userID={a.id} onAudit={onAudit} />}
        </div>
      </div>
    </Sheet>
  );
}

/** "March 4, 2026". */
function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** When the account last signed in, by any of its identities. */
export function lastSignIn(ids: Identity[]): string {
  const times = ids.map((i) => i.last_sign_in_at).filter((t): t is string => Boolean(t));
  if (times.length === 0) return 'Never';
  return relative(times.reduce((x, y) => (x > y ? x : y), ''));
}

/** "Oct 24 14:32": an event's time, the date in the row rather than a divider above it. */
export function eventTime(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} ${time}`;
}

/**
 * The roles the account holds, by name, and Change for the role granted to
 * the account itself. A role through a group is named with the rest; it is
 * changed on the group.
 */
export function RoleRow({
  account,
  roles,
  manage,
  isSelf,
}: Readonly<{ account: Account; roles?: Role[]; manage: boolean; isSelf: boolean }>) {
  const [open, setOpen] = useState(false);
  // Named from the account itself, so this does not wait on GET /roles,
  // which somebody reading their own account may not be allowed.
  const held = roleNames(account.install_roles ?? [], roles ?? []);
  return (
    <AccessRow
      label="Role"
      action={
        manage &&
        roles && (
          <Button variant="ghost" onClick={() => setOpen(true)}>
            Change
          </Button>
        )
      }
    >
      {held || 'No role'}
      {open && roles && (
        <Dialog
          open
          title={`Role for ${account.display_name || account.external_id}`}
          onClose={() => setOpen(false)}
          footer={
            <Button variant="primary" onClick={() => setOpen(false)}>
              Done
            </Button>
          }
        >
          <RolePicker account={account} roles={roles} isSelf={isSelf} />
        </Dialog>
      )}
    </AccessRow>
  );
}

/** The groups the account is in, and Manage to add or remove it. */
function GroupsRow({
  account,
  manage,
  isSelf,
  onGroups,
}: Readonly<{ account: Account; manage: boolean; isSelf: boolean; onGroups?: () => void }>) {
  const [open, setOpen] = useState(false);
  // The groups this account is in, asked of the server (`member`), and the
  // groups it could be added to. The list counts each group's members rather
  // than carrying them (issue #72), so membership is marked here from the
  // first answer: `members` holds this account alone when it is in the group.
  const groups = useQuery({
    queryKey: ['groups', 'of', account.id],
    queryFn: async () => {
      const [mine, every] = await Promise.all([
        api.get<{ groups: Group[] | null }>(withParams('/groups', { member: account.id, limit: GROUPS_LIMIT })),
        api.get<{ groups: Group[] | null }>(withParams('/groups', { limit: GROUPS_LIMIT })),
      ]);
      const inGroup = new Set((mine.groups ?? []).map((g) => g.id));
      const mark = (g: Group): Group => ({ ...g, members: inGroup.has(g.id) ? [account.id] : [] });
      const rest = (every.groups ?? []).filter((g) => !inGroup.has(g.id));
      return { groups: [...(mine.groups ?? []), ...rest].map(mark) };
    },
  });
  const all = groups.data?.groups ?? [];
  const memberOf = all.filter((g) => g.members?.includes(account.id));

  let value: React.ReactNode = 'None';
  // Not "None" before the groups have arrived.
  if (groups.isPending) value = <LineSkeleton width="16ch" />;
  else if (memberOf.length > 0) value = memberOf.map((g) => g.name).join(', ');

  return (
    <AccessRow
      label="Groups"
      action={
        manage && (
          <Button variant="ghost" disabled={groups.isPending} onClick={() => setOpen(true)}>
            Manage
          </Button>
        )
      }
    >
      {value}
      {open && (
        <Dialog
          open
          title={`Groups for ${account.display_name || account.external_id}`}
          onClose={() => setOpen(false)}
          footer={
            <Button variant="primary" onClick={() => setOpen(false)}>
              Done
            </Button>
          }
        >
          <GroupMembership account={account} groups={all} isSelf={isSelf} onGroups={onGroups} />
        </Dialog>
      )}
    </AccessRow>
  );
}

/** The identity providers the account signs in with, and Manage to link or unlink one. */
function SignInRow({
  userID,
  identities,
  manage,
}: Readonly<{
  userID: string;
  identities: { isPending: boolean; data?: { identities: Identity[] | null } };
  manage: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const ids = identities.data?.identities ?? [];
  const names = [...new Set(ids.map((i) => providerName({ adapter_id: i.adapter_id, adapter_name: i.adapter_name })))];

  let value: React.ReactNode = names.join(', ') || 'None';
  if (identities.isPending) value = <LineSkeleton width="12ch" />;

  return (
    <AccessRow
      label="Signs in with"
      action={
        manage && (
          <Button variant="ghost" onClick={() => setOpen(true)}>
            Manage
          </Button>
        )
      }
    >
      {value}
      {open && (
        <Dialog
          open
          title="Sign-in identities"
          onClose={() => setOpen(false)}
          footer={
            <Button variant="primary" onClick={() => setOpen(false)}>
              Done
            </Button>
          }
        >
          <Identities userID={userID} manage={manage} bare />
        </Dialog>
      )}
    </AccessRow>
  );
}

/** GET /users/{id}/apps, the part this card reads. */
interface AppAccess {
  app_id: string;
  app_name: string;
  owner: boolean;
  control: { role_name?: string; role_id?: string }[];
  data: unknown[];
}

/** What the account may do on an app, in a word or two. */
export function accessLevel(a: AppAccess): string {
  if (a.owner) return 'Owner';
  const roles = [...new Set(a.control.map((g) => sentence(g.role_name || g.role_id || '')).filter(Boolean))];
  if (roles.length > 0) return roles.join(', ');
  return a.data.length > 0 ? 'Can open' : '—';
}

/** The apps the account has something on, each linking to its app. */
function AppsCard({
  account,
  manage,
  onOpenApp,
}: Readonly<{ account: Account; manage: boolean; onOpenApp?: (appID: string) => void }>) {
  const [open, setOpen] = useState(false);
  const apps = usePaged<{ apps: AppAccess[] | null } & PageOf, AppAccess>({
    key: ['users', account.id, 'apps'],
    path: `/users/${account.id}/apps`,
    rows: (p) => p.apps,
  });
  const shown = apps.rows.slice(0, APPS_SHOWN);
  const more = apps.rows.length > APPS_SHOWN || apps.query.hasNextPage;

  return (
    <Card padding="md">
      <CardHeading
        action={
          (manage || more) && (
            <Button variant="ghost" onClick={() => setOpen(true)}>
              {manage ? 'Manage' : 'Show all'}
            </Button>
          )
        }
      >
        Apps
      </CardHeading>
      {apps.query.isPending && <LineSkeleton width="20ch" />}
      {apps.query.isError && <Quiet>{messageOf(apps.query.error)}</Quiet>}
      {apps.query.isSuccess && shown.length === 0 && <Quiet>No apps</Quiet>}
      {shown.map((app) => {
        const href = format({ view: 'admin', section: 'apps', appID: app.app_id });
        return (
          <ListRow key={app.app_id}>
            {onOpenApp ? (
              <RouteLink href={href} onFollow={() => onOpenApp(app.app_id)} style={{ font: 'var(--type-label)', color: 'var(--ink)' }}>
                {app.app_name}
              </RouteLink>
            ) : (
              <span style={{ font: 'var(--type-label)' }}>{app.app_name}</span>
            )}
            <span>{accessLevel(app)}</span>
          </ListRow>
        );
      })}
      {open && (
        <AppsDialog
          principal={{ kind: 'user', id: account.id, name: account.display_name || account.external_id }}
          onClose={() => setOpen(false)}
        />
      )}
    </Card>
  );
}

/** The account's latest audit events: where it is the actor or the target. */
function Activity({ userID, onAudit }: { userID: string; onAudit: (query: string) => void }) {
  const filters: AuditFilters = { ...NO_FILTERS, involving: userID, when: '30d' };
  const { log, events } = useAuditLog(filters);

  return (
    <Card padding="md">
      <CardHeading
        action={
          <Button variant="ghost" onClick={() => onAudit(linkQuery(filters))}>
            Open in audit log
          </Button>
        }
      >
        Activity
      </CardHeading>
      {log.isPending && <LineSkeleton width="24ch" />}
      {log.isError && <Quiet>{messageOf(log.error)}</Quiet>}
      {log.isSuccess && events.length === 0 && <Quiet>No events yet</Quiet>}
      {events.slice(0, ACTIVITY_SHOWN).map((e) => (
        <ListRow key={e.id}>
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--space-2)', minWidth: 0 }}>
            <span style={{ font: 'var(--type-code-sm)', overflowWrap: 'anywhere' }}>{e.action}</span>
            {e.outcome && e.outcome !== 'success' && (
              <span style={{ font: 'var(--type-caption)', color: 'var(--marker-deep)' }}>{sentence(e.outcome)}</span>
            )}
          </span>
          <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>
            {eventTime(e.occurred_at)}
          </span>
        </ListRow>
      ))}
    </Card>
  );
}

function CardHeading({ children, action }: Readonly<{ children: React.ReactNode; action?: React.ReactNode }>) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 'var(--space-3)',
        paddingBottom: 'var(--space-3)',
        minHeight: 'var(--control-console)',
      }}
    >
      <h4 style={{ font: 'var(--type-h4)', margin: 0 }}>{children}</h4>
      {action}
    </div>
  );
}

function ListRow({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 'var(--space-3)',
        padding: 'var(--space-2) 0',
        borderTop: 'var(--border-width) solid var(--rule)',
        font: 'var(--type-body-ui)',
      }}
    >
      {children}
    </div>
  );
}

function Fact({ term, mono, children }: Readonly<{ term: string; mono?: boolean; children: React.ReactNode }>) {
  return (
    <div>
      <dt style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>{term}</dt>
      <dd style={{ font: mono ? 'var(--type-code)' : 'var(--type-body-ui)' }}>{children}</dd>
    </div>
  );
}

/**
 * Username, name and email. An identity provider's account takes its username
 * and email from the provider, which would put them back at the next sign-in,
 * so those two are shown but not editable. A username is how someone signs in,
 * so changing one — even your own — takes install.users.manage.
 */
function EditDetails({ account, manage, isSelf }: { account: Account; manage: boolean; isSelf: boolean }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState(account.external_id);
  const [name, setName] = useState(account.display_name ?? '');
  const [email, setEmail] = useState(account.email ?? '');
  const queries = useQueryClient();
  const local = account.adapter_id === LOCAL_PROVIDER;

  // Only what changed: a PATCH naming the username of an IdP account is
  // refused even when the value is the same.
  const changes: Record<string, string> = {};
  if (username !== account.external_id) changes.username = username;
  if (name !== (account.display_name ?? '')) changes.display_name = name;
  if (email !== (account.email ?? '')) changes.email = email;

  const save = useMutation({
    mutationFn: () => api.patch<unknown>(`/users/${account.id}`, changes),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['users'] });
      void queries.invalidateQueries({ queryKey: ['users', account.id] });
      if (isSelf) void queries.invalidateQueries({ queryKey: ['me'] });
      setOpen(false);
    },
  });

  const start = () => {
    setUsername(account.external_id);
    setName(account.display_name ?? '');
    setEmail(account.email ?? '');
    save.reset();
    setOpen(true);
  };
  // A refusal belongs to the value that caused it.
  const edit = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    if (save.isError) save.reset();
    set(e.target.value);
  };
  const atProvider = `Set by ${account.adapter_id}.`;

  return (
    <>
      <Button variant="ghost" icon={<Icon name="pencil" size={14} />} onClick={start}>
        Edit
      </Button>
      {open && (
        <Dialog
          open
          title={`Edit ${account.external_id}`}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={save.isPending || Object.keys(changes).length === 0}
                onClick={() => save.mutate()}
              >
                {save.isPending ? 'Saving' : 'Save'}
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <Input
              label="Username"
              mono
              value={username}
              disabled={!local || !manage}
              helper={
                !local
                  ? atProvider
                  : !manage
                    ? 'Changing a username takes permission to manage accounts.'
                    : undefined
              }
              onChange={edit(setUsername)}
            />
            <Input label="Name" value={name} onChange={edit(setName)} />
            <Input
              label="Email"
              type="email"
              value={email}
              disabled={!local}
              helper={local ? undefined : atProvider}
              onChange={edit(setEmail)}
            />
            {save.isError && <Banner tone="failed">{refusal(save.error)}</Banner>}
          </div>
        </Dialog>
      )}
    </>
  );
}

/**
 * The groups an account is in, for someone who manages accounts: remove it from
 * one, or add it to another. A group an identity provider syncs is the
 * provider's to change (R-078), so it is listed without a remove and is not
 * offered to add to.
 */
function GroupMembership({
  account,
  groups,
  isSelf,
  onGroups,
}: {
  account: Account;
  groups: Group[];
  isSelf: boolean;
  /** Groups and roles, where a group is made. */
  onGroups?: () => void;
}) {
  const queries = useQueryClient();
  const [error, setError] = useState<string>();
  const memberOf = groups.filter((g) => g.members?.includes(account.id));
  const offered = groups.filter((g) => !g.source && !g.members?.includes(account.id));

  const change = useMutation({
    mutationFn: ({ group, add }: { group: string; add: boolean }) => {
      const path = `/groups/${group}/members/${account.id}`;
      return add ? api.put<unknown>(path) : api.del<unknown>(path);
    },
    onSuccess: () => setError(undefined),
    // Shown as written: removing the last person who can manage accounts is
    // refused (R-088), and the remedy says what to do instead.
    onError: (e) => setError(refusal(e)),
    onSettled: () => {
      refreshMembership(queries);
      if (isSelf) void queries.invalidateQueries({ queryKey: ['me'] });
    },
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', maxWidth: '48ch' }}>
      {memberOf.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2) var(--space-3)' }}>
          {memberOf.map((g) => (
            <span key={g.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
              {/* A provider's group says where it comes from: its members are
                  changed there, not here (R-078). */}
              <Tag>{g.source_name ? `${g.name} · ${g.source_name}` : g.name}</Tag>
              {!g.source && (
                <IconButton
                  label={`Remove from ${g.name}`}
                  size={24}
                  disabled={change.isPending}
                  onClick={() => change.mutate({ group: g.id, add: false })}
                >
                  <Icon name="x" size={14} />
                </IconButton>
              )}
            </span>
          ))}
        </div>
      )}
      {offered.length > 0 ? (
        <Select
          aria-label="Add to group"
          value=""
          disabled={change.isPending}
          onChange={(e) => e.target.value && change.mutate({ group: e.target.value, add: true })}
          options={[{ value: '', label: 'Add to group' }, ...offered.map((g) => ({ value: g.id, label: g.name }))]}
        />
      ) : (
        // Said, rather than an empty row: with no groups to offer, a bare
        // "None" read as a row that could not be edited.
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2) var(--space-3)' }}>
          <span style={{ color: 'var(--ink-secondary)' }}>
            {groups.some((g) => !g.source)
              ? 'Already in every group.'
              : memberOf.length > 0
                ? 'No Pando groups to add to yet.'
                : 'No groups yet.'}
          </span>
          {onGroups && (
            <Button variant="secondary" onClick={onGroups}>
              {groups.length === 0 ? 'Create a group' : 'Groups and roles'}
            </Button>
          )}
        </span>
      )}
      {error && <span style={{ font: 'var(--type-caption)', color: 'var(--marker-deep)' }}>{error}</span>}
    </div>
  );
}

/**
 * A local account's password and two-factor authentication, as details. An
 * external provider's account has neither in Pando, so nothing is shown.
 */
function LocalCredentials({ account }: Readonly<{ account: Account }>) {
  if (account.adapter_id !== LOCAL_PROVIDER) return null;
  return (
    <>
      <Fact term="Password">
        {account.must_change_password ? 'Must be changed at next sign-in' : 'Set by the account holder'}
      </Fact>
      <Fact term="Two-factor">{account.two_factor_enabled ? 'On' : 'Off'}</Fact>
    </>
  );
}

/**
 * What an administrator can reset on a local account: its password, and its
 * two-factor authentication when it has some. An external provider's account
 * has neither in Pando.
 */
function LocalResets({ account }: Readonly<{ account: Account }>) {
  if (account.adapter_id !== LOCAL_PROVIDER) return null;
  return (
    <>
      <ResetPassword account={account} />
      {account.two_factor_enabled && <ResetTwoFactor account={account} />}
    </>
  );
}

/**
 * Remove somebody else's authenticator and recovery codes (R-405), for a
 * person who lost both. Like a password reset, it signs them out everywhere;
 * they sign in with their password, and set it up again then if host policy
 * requires it. Your own is turned off in your settings.
 */
export function ResetTwoFactor({ account }: Readonly<{ account: Account }>) {
  const [open, setOpen] = useState(false);
  const queries = useQueryClient();

  const reset = useMutation({
    mutationFn: () => api.del<void>(`/users/${account.id}/two-factor`),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['users', account.id] });
      void queries.invalidateQueries({ queryKey: ['users'] });
      void queries.invalidateQueries({ queryKey: ['audit'] });
      setOpen(false);
    },
  });

  const close = () => {
    setOpen(false);
    reset.reset();
  };

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Reset two-factor
      </Button>
      {open && (
        <Dialog
          open
          title={`Reset two-factor for ${account.external_id}`}
          description="Pando removes their authenticator and recovery codes and signs the account out everywhere."
          onClose={close}
          footer={
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" disabled={reset.isPending} onClick={() => reset.mutate()}>
                {reset.isPending ? 'Resetting' : 'Reset two-factor'}
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <Quiet>
              {account.external_id} signs in with their password alone. If this installation requires two-factor
              authentication, they set it up again at their next sign-in.
            </Quiet>
            {reset.isError && <Banner tone="failed">{messageOf(reset.error)}</Banner>}
          </div>
        </Dialog>
      )}
    </>
  );
}

/**
 * A new password for somebody else's local account, generated rather than typed
 * (see GeneratedPassword). Not offered on your own page: the API refuses it
 * there, because changing your own password takes your current one
 * (POST /me/password).
 */
function ResetPassword({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const queries = useQueryClient();

  const reset = useMutation({
    mutationFn: () =>
      api.post<void>(`/users/${account.id}/password`, { password, must_change_password: mustChange }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['users', account.id] });
      void queries.invalidateQueries({ queryKey: ['users'] });
      void queries.invalidateQueries({ queryKey: ['audit'] });
    },
  });

  const close = () => {
    setOpen(false);
    // The next reset starts from a fresh password, not this one.
    setPassword('');
    setMustChange(true);
    reset.reset();
  };

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Reset password
      </Button>
      {open &&
        (reset.isSuccess ? (
          <Dialog
            open
            title={`Password reset for ${account.external_id}`}
            // Last sight of it: Pando cannot show it again once this closes.
            description="Copy the password now. Pando doesn’t show it again."
            onClose={close}
            footer={
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              <PasswordToCopy value={password} />
              <Quiet>
                {account.external_id} is signed out everywhere.
                {mustChange ? ' They choose a new password at their next sign-in.' : ''}
              </Quiet>
            </div>
          </Dialog>
        ) : (
          <Dialog
            open
            title={`Reset password for ${account.external_id}`}
            // What happens to the sessions is said before, not after (R-282).
            description="Pando replaces the password with the one below and signs the account out everywhere."
            onClose={close}
            footer={
              <>
                <Button variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={reset.isPending || password === ''}
                  onClick={() => reset.mutate()}
                >
                  {reset.isPending ? 'Resetting' : 'Reset password'}
                </Button>
              </>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              <GeneratedPassword
                value={password}
                onChange={(p) => {
                  if (reset.isError) reset.reset();
                  setPassword(p);
                }}
                mustChange={mustChange}
                onMustChange={setMustChange}
              />
              {reset.isError && <Banner tone="failed">{messageOf(reset.error)}</Banner>}
            </div>
          </Dialog>
        ))}
    </>
  );
}

function DeleteAccount({ account, onDeleted }: { account: Account; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const queries = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.del<void>(`/users/${account.id}`),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['users'] });
      void queries.invalidateQueries({ queryKey: ['groups'] });
      onDeleted();
    },
  });

  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Delete
      </Button>
      {open && (
        <Dialog
          open
          title={`Delete ${account.external_id}`}
          // What goes with it, before it goes (R-282). Suspending is the
          // reversible one, and the dialog says so.
          description="The account is signed out everywhere and loses its installation role, groups, app access and tokens. This can’t be undone. To keep the account, suspend it instead."
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
                {remove.isPending ? 'Deleting' : 'Delete account'}
              </Button>
            </>
          }
        >
          {remove.isError && <Banner tone="failed">{messageOf(remove.error)}</Banner>}
        </Dialog>
      )}
    </>
  );
}
