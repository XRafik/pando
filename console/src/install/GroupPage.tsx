// A group's own page (R-078): its details, then what it holds (Access), who
// is in it (Members) and the apps it reaches (Apps).
//
// A group an identity provider syncs is the provider's to name and fill: it
// has no Rename, Delete, Add or remove here. What it can do is Pando's, so its
// role, its app limit and its apps are changed here like any group's.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banner, Button, Select } from '@design';

import { api } from '@api/client';
import { format, type Route } from '../app/route';
import { InstallVerb, useInstallVerb } from '../app/principal';
import { RouteLink } from '../ui/RouteLink';
import { LineSkeleton } from '../ui/Loading';
import { ShowMore, usePaged, withParams, type PageOf } from '../ui/paged';
import { GiveAccess } from './AccountApps';
import { GroupAppLimit } from './AppLimit';
import { messageOf, refusal, refreshMembership } from './Accounts';
import { DeleteGroup, LinkGroups } from './Identity';
import {
  AddButton,
  ChooseDialog,
  Details,
  IdCard,
  Initials,
  PageHeader,
  PickDialog,
  RenameDialog,
  Remove,
  Row,
  findAccounts,
  providerOf,
  roleName,
  useAllRoles,
  type Group,
  type Member,
  type Role,
} from './identityParts';

/** Members shown before "Show all". */
const FIRST_MEMBERS = 5;

interface Grant {
  grant_id: string;
  role_id?: string;
}

interface AppAccess {
  app_id: string;
  app_name: string;
  can_manage: boolean;
  control: Grant[];
  data: Grant[];
}

/** The level that is opening an app and no more. */
const OPEN = 'open';

export function GroupPage({
  groupID,
  canEdit,
  go,
}: Readonly<{ groupID: string; canEdit: boolean; go: (route: Route) => void }>) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const back = () => go({ view: 'admin', section: 'identity' });

  const group = useQuery({
    queryKey: ['groups', groupID],
    queryFn: () => api.get<Group>(`/groups/${groupID}`),
  });

  if (group.isError) {
    return (
      <Page>
        <PageHeader back={back} icon="users" name="" />
        <Banner tone="failed">{messageOf(group.error)}</Banner>
      </Page>
    );
  }
  const g = group.data;
  if (!g) {
    return (
      <Page>
        <PageHeader back={back} icon="users" name="" />
        <output aria-label="Loading" style={{ display: 'block' }}>
          <LineSkeleton width="24ch" />
        </output>
      </Page>
    );
  }
  const own = !g.source;

  return (
    <Page>
      <PageHeader
        back={back}
        icon="users"
        name={g.name}
        onRename={canEdit && own ? () => setRenaming(true) : undefined}
        onDelete={canEdit && own ? () => setDeleting(true) : undefined}
      />
      <Details
        id={g.id}
        facts={[
          ['Source', g.source ? g.source_name || g.source : 'Pando'],
          ['Members', (g.member_count ?? 0).toLocaleString('en-US')],
          ['Created', g.created_at ? new Date(g.created_at).toLocaleDateString('en-US', { dateStyle: 'long' }) : '—'],
        ]}
      />
      <div className="pando-id-cards">
        <Access group={g} canEdit={canEdit} />
        <Members group={g} canEdit={canEdit && own} go={go} />
        <Apps group={g} go={go} />
      </div>
      {renaming && (
        <RenameDialog title="Rename group" current={g.name} path={`/groups/${g.id}`} onClose={() => setRenaming(false)} />
      )}
      {deleting && <DeleteGroup group={g} onClose={() => setDeleting(false)} onDeleted={back} />}
    </Page>
  );
}

/** The column a group's or a role's page is laid out in. */
export function Page({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div
      className="pando-id-page"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
        padding: 'var(--space-6) var(--console-padding) var(--space-7)',
      }}
    >
      {children}
    </div>
  );
}

/** A label over its value, with one button at the end. */
function AccessRow({ label, value, action }: Readonly<{ label: string; value: React.ReactNode; action?: React.ReactNode }>) {
  return (
    <Row end={action}>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>{label}</span>
        <span style={{ font: 'var(--type-body-ui)', overflowWrap: 'anywhere' }}>{value}</span>
      </span>
    </Row>
  );
}

function limitText(max: number | null | undefined): string {
  if (max === null || max === undefined) return 'Not set';
  if (max === 0) return 'Unlimited';
  return max === 1 ? '1 app' : `${max} apps`;
}

/** The group's installation role by name, its ID while roles are loading, or none. */
function roleText(id: string | undefined, role: Role | undefined): string {
  if (!id) return 'No role';
  return role ? roleName(role) : id;
}

/** What the group holds: its installation role, its app limit, and on a Pando
 *  group the provider groups counted as its members. */
function Access({ group, canEdit }: Readonly<{ group: Group; canEdit: boolean }>) {
  const queries = useQueryClient();
  const [open, setOpen] = useState<'role' | 'limit' | 'links' | null>(null);
  const roles = useAllRoles();
  const installRoles = (roles.data?.roles ?? []).filter((r) => r.scope === 'install');
  const role = installRoles.find((r) => r.id === group.install_role_id);
  const limit = useQuery({
    queryKey: ['groups', group.id, 'app-limit'],
    queryFn: () => api.get<{ max_apps: number | null }>(`/groups/${group.id}/app-limit`),
  });
  // The provider groups that could be linked: only a Pando group links them.
  const synced = useQuery({
    queryKey: ['groups', 'synced'],
    queryFn: async () =>
      ((await api.get<{ groups: Group[] | null }>(withParams('/groups', { limit: 500 }))).groups ?? []).filter((x) => x.source),
    enabled: !group.source,
  });
  const syncedGroups = synced.data ?? [];
  const linked = group.linked_from ?? [];
  const provider = providerOf(linked.length > 0 ? linked : syncedGroups.map((x) => x.id), syncedGroups);

  const setRole = async (roleID: string) => {
    if (roleID) await api.put<unknown>(`/groups/${group.id}/role`, { role_id: roleID });
    else await api.del<void>(`/groups/${group.id}/role`);
    // Every member's verbs just changed, possibly your own.
    for (const key of [['groups'], ['users'], ['me'], ['roles']]) void queries.invalidateQueries({ queryKey: key });
  };
  const names = { role: 'role', limit: 'app limit', links: 'provider groups' };
  const change = (what: 'role' | 'limit' | 'links', label = 'Change') =>
    canEdit ? (
      <Button variant="ghost" aria-label={`${label} ${names[what]}`} onClick={() => setOpen(what)}>
        {label}
      </Button>
    ) : undefined;

  return (
    <IdCard title="Access">
      <AccessRow label="Role" value={roleText(group.install_role_id, role)} action={change('role')} />
      <AccessRow label="App limit" value={limit.isPending ? <LineSkeleton width="8ch" /> : limitText(limit.data?.max_apps)} action={change('limit')} />
      {!group.source && syncedGroups.length > 0 && (
        <AccessRow
          label={`${provider === 'provider' ? 'Provider' : provider} groups`}
          value={linked.length > 0 ? linked.map((id) => syncedGroups.find((x) => x.id === id)?.name ?? id).join(', ') : 'None'}
          action={change('links', 'Manage')}
        />
      )}
      {open === 'role' && (
        <ChooseDialog
          title="Change role"
          label="Role"
          value={group.install_role_id ?? ''}
          options={[{ value: '', label: 'No role' }, ...installRoles.map((r: Role) => ({ value: r.id, label: roleName(r) }))]}
          save={setRole}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'limit' && <GroupAppLimit groupID={group.id} name={group.name} onClose={() => setOpen(null)} />}
      {open === 'links' && <LinkGroups group={group} synced={syncedGroups} onClose={() => setOpen(null)} />}
    </IdCard>
  );
}

/** Who is in the group directly: the first few, then all of them a page at a time. */
function Members({ group, canEdit, go }: Readonly<{ group: Group; canEdit: boolean; go: (route: Route) => void }>) {
  const queries = useQueryClient();
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const members = usePaged<{ members: Member[] | null } & PageOf, Member>({
    key: ['groups', group.id, 'members'],
    path: `/groups/${group.id}/members`,
    rows: (p) => p.members,
    params: { limit: all ? undefined : FIRST_MEMBERS },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del<void>(`/groups/${group.id}/members/${id}`),
    onSettled: () => refreshMembership(queries),
  });
  const total = members.total ?? 0;

  return (
    <IdCard title="Members" action={canEdit && <AddButton label="Add" onClick={() => setAdding(true)} />}>
      {members.query.isError && <Banner tone="failed">{messageOf(members.query.error)}</Banner>}
      {remove.isError && <Banner tone="failed">{refusal(remove.error)}</Banner>}
      {members.query.isSuccess && members.rows.length === 0 && <Empty>No members yet</Empty>}
      {members.rows.map((m) => {
        const name = m.display_name || m.external_id;
        const to: Route = { view: 'admin', section: 'accounts', userID: m.id };
        return (
          <Row key={m.id} end={canEdit && <Remove what={name} disabled={remove.isPending} onRemove={() => remove.mutate(m.id)} />}>
            <Initials name={name} />
            <RouteLink href={format(to)} onFollow={() => go(to)} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ font: 'var(--type-label)' }}>{name}</span>
              <span style={{ font: 'var(--type-code-sm)', color: 'var(--ink-secondary)' }}>{m.external_id}</span>
            </RouteLink>
          </Row>
        );
      })}
      {!all && total > members.rows.length && (
        <Row>
          <Button variant="ghost" onClick={() => setAll(true)}>
            Show all {total.toLocaleString('en-US')}
          </Button>
        </Row>
      )}
      {all && <ShowMore query={members.query} label="Show more members" />}
      {adding && (
        <PickDialog
          title="Add member"
          noun="accounts"
          label="Account"
          find={findAccounts}
          act={(id) => api.put<void>(`/groups/${group.id}/members/${id}`)}
          onDone={() => refreshMembership(queries)}
          onClose={() => setAdding(false)}
        />
      )}
    </IdCard>
  );
}

function Empty({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <p style={{ font: 'var(--type-body-ui)', color: 'var(--ink-secondary)', margin: 0, padding: 'var(--space-2) 0' }}>
      {children}
    </p>
  );
}

/** The app roles in the order of what they allow: Viewer, Operator, Owner,
 *  then the installation's own. */
function byReach(roles: Role[]): Role[] {
  const builtin = roles.filter((r) => r.builtin).sort((a, b) => a.verbs.length - b.verbs.length);
  const custom = roles.filter((r) => !r.builtin).sort((a, b) => a.name.localeCompare(b.name));
  return [...builtin, ...custom];
}

/**
 * Sets the group's access to an app: opening it, or a role for managing it as
 * well. Every level above opening includes opening it, so each one leaves a
 * grant to open the app in place.
 */
export async function setLevel(groupID: string, row: AppAccess, level: string): Promise<void> {
  const base = `/apps/${row.app_id}/grants`;
  const who = { principal_kind: 'group', principal_id: groupID };
  const control = row.control[0];
  if (level === OPEN) {
    if (control) await api.del<unknown>(`${base}/${control.grant_id}`);
  } else if (control) {
    await api.patch<unknown>(`${base}/${control.grant_id}`, { role_id: level });
  } else {
    await api.post<unknown>(base, { plane: 'control', role_id: level, ...who });
  }
  if (row.data.length === 0) await api.post<unknown>(base, { plane: 'data', ...who });
}

/** Takes away every grant the group has on the app. */
export async function removeApp(row: AppAccess): Promise<void> {
  // Each grant is removed on its own; none depends on another going first.
  await Promise.all([...row.control, ...row.data].map((g) => api.del<unknown>(`/apps/${row.app_id}/grants/${g.grant_id}`)));
}

/** The apps the group reaches, each with its level and a remove, where the
 *  viewer may change that app's access. */
function Apps({ group, go }: Readonly<{ group: Group; go: (route: Route) => void }>) {
  const queries = useQueryClient();
  const [adding, setAdding] = useState(false);
  // Adding offers every app, so only to someone who sees and shares every app.
  const seesEvery = useInstallVerb(InstallVerb.AppsView);
  const sharesEvery = useInstallVerb(InstallVerb.AppsGrantsManage);
  const everyApp = seesEvery && sharesEvery;
  const apps = usePaged<{ apps: AppAccess[] | null } & PageOf, AppAccess>({
    key: ['groups', group.id, 'apps'],
    path: `/groups/${group.id}/apps`,
    rows: (p) => p.apps,
  });
  const roles = useQuery({
    queryKey: ['roles', 'app'],
    queryFn: () => api.get<{ roles: Role[] | null }>('/roles?scope=app'),
  });
  const appRoles = byReach(roles.data?.roles ?? []);
  const options = [{ value: OPEN, label: 'Can open' }, ...appRoles.map((r) => ({ value: r.id, label: roleName(r) }))];
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['groups', group.id, 'apps'] });
    // A group's grant is every member's access.
    void queries.invalidateQueries({ queryKey: ['users'] });
  };
  const change = useMutation({
    mutationFn: ({ row, level }: { row: AppAccess; level: string | null }) =>
      level === null ? removeApp(row) : setLevel(group.id, row, level),
    onSettled: refresh,
  });

  return (
    <IdCard title="Apps" action={everyApp && <AddButton label="Add" onClick={() => setAdding(true)} />}>
      {apps.query.isError && <Banner tone="failed">{messageOf(apps.query.error)}</Banner>}
      {change.isError && <Banner tone="failed">{refusal(change.error)}</Banner>}
      {apps.query.isSuccess && apps.rows.length === 0 && <Empty>No apps yet</Empty>}
      {apps.rows.map((row) => {
        const to: Route = { view: 'admin', section: 'apps', appID: row.app_id };
        const level = row.control[0]?.role_id ?? OPEN;
        return (
          <Row
            key={row.app_id}
            end={
              row.can_manage ? (
                <>
                  <Select
                    aria-label={`Access to ${row.app_name}`}
                    value={level}
                    disabled={change.isPending}
                    options={options}
                    onChange={(e) => change.mutate({ row, level: e.target.value })}
                  />
                  <Remove what={row.app_name} disabled={change.isPending} onRemove={() => change.mutate({ row, level: null })} />
                </>
              ) : (
                <span style={{ color: 'var(--ink-secondary)' }}>{options.find((o) => o.value === level)?.label ?? level}</span>
              )
            }
          >
            <RouteLink
              href={format(to)}
              onFollow={() => go(to)}
              style={{ font: 'var(--type-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {row.app_name}
            </RouteLink>
          </Row>
        );
      })}
      <ShowMore query={apps.query} label="Show more apps" />
      {adding && (
        <GiveAccess
          principal={{ kind: 'group', id: group.id, name: group.name }}
          has={new Set(apps.rows.map((r) => r.app_id))}
          roles={appRoles}
          onClose={() => setAdding(false)}
        />
      )}
    </IdCard>
  );
}
