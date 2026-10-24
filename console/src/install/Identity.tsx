// Groups and roles — R-078 and R-082.
//
// One page, two tabs: a group is *who*, a set of accounts granted access as a
// unit; a role is *what*, a named set of verbs. Each tab is a plain table, and
// a row opens its group's or role's own page, where it is changed. Nothing is
// changed from the table itself.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banner, Button, Checkbox, Dialog, Icon, Input, Select, Tabs, Tag } from '@design';

import { api } from '@api/client';
import { format, type Route } from '../app/route';
import { messageOf, refusal, refreshMembership, sentence } from './Accounts';
import { VERB_NOTES } from './verbNotes';
import { NoMatches, SearchField } from '../ui/SearchField';
import { matches } from '../ui/search';
import { ShowMore, usePaged, useSettled, type PageOf } from '../ui/paged';
import { Table } from '../ui/Table';
import { Sheet } from '../ui/Sheet';
import { useNarrow } from '../ui/narrow';
import { RouteLink } from '../ui/RouteLink';
import { LineSkeleton, Loading } from '../ui/Loading';
import { AIButton } from '../ui/AskAI';
import { AccessAI } from './AccessAI';
import { useAIFunctionOn } from './AIFunctions';
import {
  Mark,
  permissionCount,
  roleName,
  scopeLabel,
  sourceLabel,
  useAllRoles,
  type Group,
  type Role,
} from './identityParts';

interface VerbRow {
  verb: string;
  scope: string;
}

export type IdentityTab = 'groups' | 'roles';

const groupRoute = (id: string): Route => ({ view: 'admin', section: 'identity', groupID: id });
const roleRoute = (id: string): Route => ({ view: 'admin', section: 'identity', roleID: id });

export function Identity({
  canEdit,
  tab = 'groups',
  onTab = () => {},
  go = () => {},
}: Readonly<{
  canEdit: boolean;
  tab?: IdentityTab;
  onTab?: (tab: IdentityTab) => void;
  /** Opens a group's or a role's page. */
  go?: (route: Route) => void;
}>) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  // Drafting with AI (R-343): shown to whoever can create groups and roles,
  // and only when access drafting is assigned to an adapter.
  const draftOn = useAIFunctionOn('draft_access');
  const [drafting, setDrafting] = useState(false);
  const narrow = useNarrow();

  const groups = usePaged<{ groups: Group[] | null } & PageOf, Group>({
    key: ['groups', 'list'],
    path: '/groups',
    rows: (p) => p.groups,
    search: useSettled(tab === 'groups' ? query.trim() : ''),
  });
  const roles = useAllRoles();
  const allRoles = roles.data?.roles ?? [];

  const onGroups = tab === 'groups';
  const add = canEdit && (
    <Button variant="primary" icon={<Icon name="plus" />} onClick={() => setAdding(true)}>
      {onGroups ? 'Add group' : 'Add role'}
    </Button>
  );
  const search = (
    <SearchField
      value={query}
      onChange={setQuery}
      placeholder={onGroups ? 'Search groups' : 'Search roles'}
      width={narrow ? '100%' : undefined}
    />
  );
  const count = (n: number | string | undefined) =>
    n === undefined ? undefined : <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>{n}</span>;

  return (
    <div className="pando-id-page">
      <Sheet
        heading="Groups and roles"
        action={
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)', flex: narrow ? '1 1 100%' : undefined }}>
            {canEdit && draftOn && <AIButton onClick={() => setDrafting(true)} />}
            {!narrow && add}
            {!narrow && search}
          </div>
        }
        tabs={
          <Tabs
            value={tab}
            onChange={(v) => {
              setQuery('');
              onTab(v as IdentityTab);
            }}
            items={[
              { value: 'groups', label: 'Groups', trailing: count(groups.query.isSuccess ? groups.totalLabel : undefined) },
              { value: 'roles', label: 'Roles', trailing: count(roles.data ? allRoles.length : undefined) },
            ]}
          />
        }
      >
        {drafting && <AccessAI onClose={() => setDrafting(false)} />}
        {narrow && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>{search}</div>
            {add}
          </div>
        )}
        {onGroups ? (
          <GroupsTable groups={groups} roles={allRoles} query={query} go={go} />
        ) : (
          <RolesTable roles={roles} query={query} go={go} />
        )}
      </Sheet>
      {adding && onGroups && <AddGroup onClose={() => setAdding(false)} onAdded={(id) => go(groupRoute(id))} />}
      {adding && !onGroups && <AddRole onClose={() => setAdding(false)} onAdded={(id) => go(roleRoute(id))} />}
    </div>
  );
}

// --- groups ----------------------------------------------------------------

function RoleTag({ roleID, roles }: Readonly<{ roleID?: string; roles: Role[] }>) {
  if (!roleID) return <span style={{ color: 'var(--ink-secondary)' }}>No role</span>;
  const role = roles.find((r) => r.id === roleID);
  return <Tag>{role ? roleName(role) : roleID}</Tag>;
}

function GroupsTable({
  groups,
  roles,
  query,
  go,
}: Readonly<{
  groups: ReturnType<typeof usePaged<{ groups: Group[] | null } & PageOf, Group>>;
  roles: Role[];
  query: string;
  go: (route: Route) => void;
}>) {
  const narrow = useNarrow();
  const all = groups.rows;
  const empty = query.trim() ? <NoMatches what="groups" query={query} /> : <Quiet>No groups yet</Quiet>;
  const roleOf = (g: Group) => {
    const role = roles.find((r) => r.id === g.install_role_id);
    if (!g.install_role_id) return 'No role';
    return role ? roleName(role) : g.install_role_id;
  };

  return (
    <>
      {groups.query.isError && <Banner tone="failed">{messageOf(groups.query.error)}</Banner>}
      {narrow ? (
        <ItemList
          loading={groups.query.isPending}
          empty={empty}
          items={all.map((g) => ({
            id: g.id,
            href: format(groupRoute(g.id)),
            follow: () => go(groupRoute(g.id)),
            icon: 'users' as const,
            name: g.name,
            line: sourceLabel(g, all),
            start: <RoleTag roleID={g.install_role_id} roles={roles} />,
            end: members(g.member_count ?? 0),
          }))}
        />
      ) : (
        <Table
          loading={groups.query.isPending}
          skeletonRows={3}
          onRowClick={(row: Group) => go(groupRoute(row.id))}
          rowHref={(row: Group) => format(groupRoute(row.id))}
          columns={[
            {
              key: 'name',
              header: 'Name',
              width: 'minmax(16ch,2fr)',
              render: (row: Group) => <Named icon="users" name={row.name} />,
            },
            {
              key: 'role',
              header: 'Role',
              width: 'minmax(0,1fr)',
              filter: 'values',
              filterValue: roleOf,
              render: (row: Group) => <RoleTag roleID={row.install_role_id} roles={roles} />,
            },
            {
              key: 'members',
              header: 'Members',
              width: '12ch',
              render: (row: Group) => (row.member_count ?? 0).toLocaleString('en-US'),
            },
            {
              key: 'source',
              header: 'Source',
              width: 'minmax(0,1fr)',
              muted: true,
              filter: 'values',
              filterValue: (row: Group) => (row.source ? row.source_name || row.source : 'Pando'),
              render: (row: Group) => sourceLabel(row, all),
            },
          ]}
          rows={all}
          empty={empty}
        />
      )}
      <div style={{ marginTop: 'var(--space-3)' }}>
        <ShowMore query={groups.query} label="Show more groups" />
      </div>
    </>
  );
}

/** A count of members, as said: 1 member, 3 members. */
const members = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'member' : 'members'}`;

function Quiet({ children }: Readonly<{ children: React.ReactNode }>) {
  return <p style={{ font: 'var(--type-body-ui)', color: 'var(--ink-secondary)', margin: 'var(--space-3) 0' }}>{children}</p>;
}

/** A table's first cell: the mark and the name. */
function Named({ icon, name }: Readonly<{ icon: 'users' | 'key-round'; name: string }>) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
      <Mark icon={icon} />
      <span title={name} style={{ font: 'var(--type-label)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {name}
      </span>
    </span>
  );
}

interface Item {
  id: string;
  href: string;
  follow: () => void;
  icon: 'users' | 'key-round';
  name: string;
  line: string;
  start: React.ReactNode;
  end: string;
}

/** The phone's list: one stacked row each, the whole row a link. */
function ItemList({ items, loading, empty }: Readonly<{ items: Item[]; loading: boolean; empty: React.ReactNode }>) {
  if (loading && items.length === 0) {
    return (
      <Loading>
        {[0, 1, 2].map((n) => (
          <LineSkeleton key={n} width={`${24 - n * 4}ch`} />
        ))}
      </Loading>
    );
  }
  if (items.length === 0) return <>{empty}</>;
  return (
    <div className="pando-id-list">
      {items.map((it) => (
        <RouteLink key={it.id} href={it.href} onFollow={it.follow} className="pando-id-item">
          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
            <Mark icon={it.icon} />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ font: 'var(--type-label)' }}>{it.name}</span>
              <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>{it.line}</span>
            </span>
          </span>
          <span style={{ paddingLeft: 'calc(var(--control-console) + var(--space-3))' }}>{it.start}</span>
          <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)', justifySelf: 'end' }}>{it.end}</span>
        </RouteLink>
      ))}
    </div>
  );
}

/** Adds a Pando group by name, then opens it, where its members are added. */
function AddGroup({ onClose, onAdded }: Readonly<{ onClose: () => void; onAdded: (id: string) => void }>) {
  const queries = useQueryClient();
  const [name, setName] = useState('');
  const save = useMutation({
    mutationFn: () => api.post<{ id: string }>('/groups', { name: name.trim() }),
    onSuccess: (group) => {
      void refreshMembership(queries);
      onClose();
      onAdded(group.id);
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add group"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={save.isPending || !name.trim()} onClick={() => save.mutate()}>
            {save.isPending ? 'Adding' : 'Add group'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        {save.isError && <Banner tone="failed">{messageOf(save.error)}</Banner>}
      </div>
    </Dialog>
  );
}

// --- roles -----------------------------------------------------------------

function RolesTable({
  roles,
  query,
  go,
}: Readonly<{ roles: ReturnType<typeof useAllRoles>; query: string; go: (route: Route) => void }>) {
  const narrow = useNarrow();
  // By name, by scope, by source, and by any permission it holds — so
  // "secrets" finds every role that can touch them.
  const rows = (roles.data?.roles ?? []).filter((r) =>
    matches(query, r.name, scopeLabel(r), r.builtin ? 'Built in' : 'Custom', ...r.verbs),
  );
  const empty = query.trim() ? <NoMatches what="roles" query={query} /> : undefined;
  const source = (r: Role) => (r.builtin ? 'Built in' : 'Custom');

  return (
    <>
      {roles.isError && <Banner tone="failed">{messageOf(roles.error)}</Banner>}
      {narrow ? (
        <ItemList
          loading={roles.isPending}
          empty={empty}
          items={rows.map((r) => ({
            id: r.id,
            href: format(roleRoute(r.id)),
            follow: () => go(roleRoute(r.id)),
            icon: 'key-round' as const,
            name: roleName(r),
            line: `${scopeLabel(r)} · ${source(r)}`,
            start: null,
            end: permissionCount(r.verbs.length),
          }))}
        />
      ) : (
        <Table
          loading={roles.isPending}
          skeletonRows={5}
          onRowClick={(row: Role) => go(roleRoute(row.id))}
          rowHref={(row: Role) => format(roleRoute(row.id))}
          columns={[
            {
              key: 'name',
              header: 'Name',
              width: 'minmax(16ch,2fr)',
              render: (row: Role) => <Named icon="key-round" name={roleName(row)} />,
            },
            {
              key: 'scope',
              header: 'Scope',
              width: 'minmax(0,1fr)',
              filter: 'values',
              filterValue: scopeLabel,
              // R-080: the two scopes are never conflated.
              render: scopeLabel,
            },
            {
              key: 'verbs',
              header: 'Permissions',
              width: '14ch',
              render: (row: Role) => row.verbs.length,
            },
            {
              key: 'builtin',
              header: 'Source',
              width: 'minmax(0,1fr)',
              muted: true,
              filter: 'values',
              filterValue: source,
              render: source,
            },
          ]}
          rows={rows}
          empty={empty}
        />
      )}
    </>
  );
}

/** Composes a custom role from the verb list (R-082), then opens it. */
function AddRole({ onClose, onAdded }: Readonly<{ onClose: () => void; onAdded: (id: string) => void }>) {
  const queries = useQueryClient();
  const [name, setName] = useState('');
  const [scope, setScope] = useState('app');
  const [verbs, setVerbs] = useState<string[]>([]);

  const catalog = useVerbs();
  const existing = useAllRoles();
  // A name already taken is said while it is typed. The server refuses it
  // too, ignoring case and spaces, built-ins included (R-082).
  const clash = (existing.data?.roles ?? []).find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase());
  let taken: string | undefined;
  if (name.trim() && clash) {
    taken = clash.builtin
      ? `Pando already has a built-in role called ${sentence(clash.name)}. Choose a different name.`
      : `There is already a role called ${clash.name}. Choose a different name.`;
  }

  const save = useMutation({
    mutationFn: () => api.post<{ id: string }>('/roles', { name: name.trim(), scope, verbs }),
    onSuccess: (role) => {
      void queries.invalidateQueries({ queryKey: ['roles'] });
      onClose();
      onAdded(role.id);
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add role"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={save.isPending || !name.trim() || Boolean(taken) || verbs.length === 0}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving' : 'Add role'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <Input label="Name" value={name} error={taken} onChange={(e) => setName(e.target.value)} />
        <Select
          label="Scope"
          value={scope}
          options={[
            { value: 'app', label: 'App' },
            { value: 'install', label: 'Installation' },
          ]}
          onChange={(e) => {
            setScope(e.target.value);
            setVerbs([]);
          }}
        />
        {/* Only the verbs of the chosen scope: a role mixing the two is
            refused (R-080). */}
        <VerbChecklist scope={scope} catalog={catalog} chosen={verbs} onChange={setVerbs} />
        {save.isError && <Banner tone="failed">{messageOf(save.error)}</Banner>}
      </div>
    </Dialog>
  );
}

/** The verb catalog, for composing or editing a role. */
export function useVerbs() {
  return useQuery({
    queryKey: ['verbs'],
    queryFn: () => api.get<{ verbs: VerbRow[] | null }>('/verbs'),
  });
}

/** Every verb of a scope, each a checkbox with what it lets somebody do. */
export function VerbChecklist({
  scope,
  catalog,
  chosen,
  onChange,
}: Readonly<{
  scope: string;
  catalog: ReturnType<typeof useVerbs>;
  chosen: string[];
  onChange: (verbs: string[]) => void;
}>) {
  const available = (catalog.data?.verbs ?? []).filter((v) => v.scope === scope);
  const toggle = (verb: string) =>
    onChange(chosen.includes(verb) ? chosen.filter((v) => v !== verb) : [...chosen, verb]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {catalog.isPending && (
        <Loading>
          {[0, 1, 2, 3].map((n) => (
            <LineSkeleton key={n} width={`${22 - (n % 2) * 6}ch`} />
          ))}
        </Loading>
      )}
      {available.map((v) => (
        <Checkbox
          key={v.verb}
          checked={chosen.includes(v.verb)}
          label={VERB_NOTES[v.verb] ?? v.verb}
          description={v.verb}
          onChange={() => toggle(v.verb)}
        />
      ))}
    </div>
  );
}

// --- deleting ----------------------------------------------------------------
//
// Both take access away from people who may not know it is happening, so each
// says whose access goes and whose stays. The server refuses the one case that
// would lock the installation (R-088) and says why; that message is shown
// as-is.

function DeleteDialog({
  title,
  description,
  path,
  kept,
  label,
  onClose,
  onDeleted,
}: Readonly<{
  title: string;
  description: string;
  path: string;
  kept: string;
  label: string;
  onClose: () => void;
  onDeleted: () => void;
}>) {
  const queries = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.del<void>(path),
    onSuccess: () => {
      void queries.invalidateQueries();
      onClose();
      onDeleted();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? 'Deleting' : label}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <p style={{ font: 'var(--type-body-ui)', margin: 0 }}>{kept}</p>
        <p style={{ font: 'var(--type-body-ui)', color: 'var(--ink-secondary)', margin: 0 }}>This can&rsquo;t be undone.</p>
        {remove.isError && <Banner tone="failed">{refusal(remove.error)}</Banner>}
      </div>
    </Dialog>
  );
}

export function DeleteGroup({
  group,
  onClose,
  onDeleted,
}: Readonly<{ group: Group; onClose: () => void; onDeleted: () => void }>) {
  const people = group.member_count ?? 0;
  return (
    <DeleteDialog
      title={`Delete the ${group.name} group`}
      description="Everyone in it loses the access the group gave them."
      path={`/groups/${group.id}`}
      kept={`${people === 1 ? 'The one member keeps their account' : `The ${people} members keep their accounts`} and any access given to them directly or through another group.`}
      label="Delete group"
      onClose={onClose}
      onDeleted={onDeleted}
    />
  );
}

export function DeleteRole({
  role,
  onClose,
  onDeleted,
}: Readonly<{ role: Role; onClose: () => void; onDeleted: () => void }>) {
  return (
    <DeleteDialog
      title={`Delete the ${role.name} role`}
      description="Anyone given this role loses what it allowed."
      path={`/roles/${role.id}`}
      kept="They keep any access they hold another way."
      label="Delete role"
      onClose={onClose}
      onDeleted={onDeleted}
    />
  );
}

/**
 * Which identity provider groups count as members of a Pando group (R-078).
 * Everyone in a linked provider group holds what this group holds, for as long
 * as the provider keeps them in it (R-079).
 */
export function LinkGroups({ group, synced, onClose }: Readonly<{ group: Group; synced: Group[]; onClose: () => void }>) {
  const queries = useQueryClient();
  const linked = new Set(group.linked_from ?? []);
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? api.put(`/groups/${group.id}/links/${id}`) : api.del(`/groups/${group.id}/links/${id}`),
    onSettled: () => refreshMembership(queries),
  });
  return (
    <Dialog
      open
      title={`Provider groups in ${group.name}`}
      description="Members of a chosen group count as members of this one."
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {synced.map((g) => (
          <Checkbox
            key={g.id}
            label={g.name}
            description={`${g.source_name ?? g.source}, ${members(g.member_count ?? 0)}`}
            checked={linked.has(g.id)}
            disabled={toggle.isPending}
            onChange={(e) => toggle.mutate({ id: g.id, on: e.target.checked })}
          />
        ))}
        {toggle.isError && <Banner tone="failed">{refusal(toggle.error)}</Banner>}
      </div>
    </Dialog>
  );
}
