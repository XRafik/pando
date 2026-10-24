// A role's own page (R-082): its details, its permissions, and who holds it.
//
// A built-in role is read only (R-081): no Rename, Delete or Edit. A custom
// one is renamed and its permissions edited here, as checkboxes of every verb
// of its scope (R-080).
//
// Who holds it never says where: not "on <app>", not "through <group>". A
// holder through a group shows a lock, and is changed on the group's page.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Banner, Button, Icon } from '@design';

import { api } from '@api/client';
import { format, type Route } from '../app/route';
import { RouteLink } from '../ui/RouteLink';
import { LineSkeleton } from '../ui/Loading';
import { ShowMore, usePaged, type PageOf } from '../ui/paged';
import { messageOf, refusal } from './Accounts';
import { VERB_NOTES } from './verbNotes';
import { DeleteRole, VerbChecklist, useVerbs } from './Identity';
import { Page } from './GroupPage';
import {
  AddButton,
  Details,
  IdCard,
  Initials,
  Mark,
  PageHeader,
  PickDialog,
  RenameDialog,
  Remove,
  Row,
  findAccounts,
  findGroups,
  roleName,
  scopeLabel,
  type Role,
} from './identityParts';

export interface Holder {
  kind: 'user' | 'group';
  id: string;
  name: string;
  username?: string;
  via: 'direct' | 'group';
}

type HoldersPage = { role: Role; holders: Holder[] | null; groups?: number } & PageOf;

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "3 accounts, 1 group", "Nobody". */
export function heldBy(page?: HoldersPage): string {
  if (!page) return '';
  const groups = page.groups ?? 0;
  const accounts = (page.total ?? 0) - groups;
  const parts = [];
  if (accounts > 0) parts.push(count(accounts, 'account', 'accounts') + (page.total_is_lower_bound ? '+' : ''));
  if (groups > 0) parts.push(count(groups, 'group', 'groups'));
  return parts.length > 0 ? parts.join(', ') : 'Nobody';
}

export function RolePage({
  roleID,
  canEdit,
  go,
}: Readonly<{ roleID: string; canEdit: boolean; go: (route: Route) => void }>) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const back = () => go({ view: 'admin', section: 'identity', tab: 'roles' });

  // The role travels with its holders: one request for the page.
  const holders = usePaged<HoldersPage, Holder>({
    key: ['roles', roleID, 'holders'],
    path: `/roles/${roleID}/holders`,
    rows: (p) => p.holders,
  });
  const first = holders.query.data?.pages[0];
  const role = first?.role;

  if (holders.query.isError) {
    return (
      <Page>
        <PageHeader back={back} icon="key-round" name="" />
        <Banner tone="failed">{messageOf(holders.query.error)}</Banner>
      </Page>
    );
  }
  if (!role) {
    return (
      <Page>
        <PageHeader back={back} icon="key-round" name="" />
        <output aria-label="Loading" style={{ display: 'block' }}>
          <LineSkeleton width="24ch" />
        </output>
      </Page>
    );
  }
  const editable = canEdit && !role.builtin;

  return (
    <Page>
      <PageHeader
        back={back}
        icon="key-round"
        name={roleName(role)}
        onRename={editable ? () => setRenaming(true) : undefined}
        onDelete={editable ? () => setDeleting(true) : undefined}
      />
      <Details
        id={role.id}
        facts={[
          ['Scope', scopeLabel(role)],
          ['Source', role.builtin ? 'Built in' : 'Custom'],
          ['Permissions', role.verbs.length],
          ['Held by', heldBy(first)],
        ]}
      />
      <div className="pando-id-cards">
        <Permissions role={role} editable={editable} />
        <HeldBy role={role} holders={holders} canEdit={canEdit} go={go} />
      </div>
      {renaming && (
        <RenameDialog title="Rename role" current={role.name} path={`/roles/${role.id}`} onClose={() => setRenaming(false)} />
      )}
      {deleting && <DeleteRole role={role} onClose={() => setDeleting(false)} onDeleted={back} />}
    </Page>
  );
}

/** What the role allows, each with its sentence; Edit turns the list into a
 *  checkbox for every verb of its scope. */
function Permissions({ role, editable }: Readonly<{ role: Role; editable: boolean }>) {
  const queries = useQueryClient();
  const [draft, setDraft] = useState<string[] | null>(null);
  const catalog = useVerbs();
  const save = useMutation({
    mutationFn: (verbs: string[]) => api.patch<unknown>(`/roles/${role.id}`, { verbs }),
    onSuccess: () => {
      setDraft(null);
      void queries.invalidateQueries({ queryKey: ['roles'] });
      // Everyone holding it may hold something else now, possibly you.
      void queries.invalidateQueries({ queryKey: ['me'] });
      void queries.invalidateQueries({ queryKey: ['users'] });
    },
  });

  let action: React.ReactNode;
  if (draft) {
    action = (
      <>
        <Button variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={save.isPending || draft.length === 0} onClick={() => save.mutate(draft)}>
          {save.isPending ? 'Saving' : 'Save'}
        </Button>
      </>
    );
  } else if (editable) {
    action = (
      <Button variant="ghost" icon={<Icon name="pencil" />} onClick={() => setDraft(role.verbs)}>
        Edit
      </Button>
    );
  }

  return (
    <IdCard title="Permissions" action={action}>
      {save.isError && <Banner tone="failed">{refusal(save.error)}</Banner>}
      {draft ? (
        <VerbChecklist scope={role.scope ?? 'app'} catalog={catalog} chosen={draft} onChange={setDraft} />
      ) : (
        role.verbs.map((v) => (
          <Row key={v}>
            <Icon name="check" color="var(--vegetation-deep)" />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ font: 'var(--type-body-ui)' }}>{VERB_NOTES[v] ?? v}</span>
              <span style={{ font: 'var(--type-code-sm)', color: 'var(--ink-secondary)' }}>{v}</span>
            </span>
          </Row>
        ))
      )}
    </IdCard>
  );
}

/** Who holds the role: its groups, then its accounts. An installation role's
 *  direct holders are added and removed here; an app role is granted per app,
 *  on the app's own page. */
function HeldBy({
  role,
  holders,
  canEdit,
  go,
}: Readonly<{
  role: Role;
  holders: ReturnType<typeof usePaged<HoldersPage, Holder>>;
  canEdit: boolean;
  go: (route: Route) => void;
}>) {
  const queries = useQueryClient();
  const [adding, setAdding] = useState<'user' | 'group' | null>(null);
  const install = role.scope === 'install';
  const manage = canEdit && install;
  const path = (kind: 'user' | 'group', id: string) => `/${kind === 'user' ? 'users' : 'groups'}/${id}/role`;
  const refresh = () => {
    for (const key of [['roles'], ['groups'], ['users'], ['me']]) void queries.invalidateQueries({ queryKey: key });
  };
  const remove = useMutation({
    mutationFn: (h: Holder) => api.del<void>(path(h.kind, h.id)),
    onSettled: refresh,
  });

  return (
    <IdCard
      title="Held by"
      action={
        manage && (
          <>
            <AddButton label="Account" onClick={() => setAdding('user')} />
            <AddButton label="Group" onClick={() => setAdding('group')} />
          </>
        )
      }
    >
      {remove.isError && <Banner tone="failed">{refusal(remove.error)}</Banner>}
      {holders.rows.length === 0 && (
        <p style={{ font: 'var(--type-body-ui)', color: 'var(--ink-secondary)', margin: 0, padding: 'var(--space-2) 0' }}>Nobody</p>
      )}
      {holders.rows.map((h) => {
        const to: Route =
          h.kind === 'user'
            ? { view: 'admin', section: 'accounts', userID: h.id }
            : { view: 'admin', section: 'identity', groupID: h.id };
        let end: React.ReactNode;
        if (h.via === 'group') {
          end = (
            <span role="img" aria-label="From a group" title="From a group" style={{ display: 'inline-flex', padding: 'var(--space-2)' }}>
              <Icon name="lock" color="var(--ink-tertiary)" />
            </span>
          );
        } else if (manage) {
          end = <Remove what={h.name} disabled={remove.isPending} onRemove={() => remove.mutate(h)} />;
        }
        return (
          <Row key={`${h.kind}-${h.id}`} end={end}>
            {h.kind === 'group' ? <Mark icon="users" /> : <Initials name={h.name} />}
            <RouteLink href={format(to)} onFollow={() => go(to)} style={{ font: 'var(--type-label)', minWidth: 0, overflowWrap: 'anywhere' }}>
              {h.name}
            </RouteLink>
          </Row>
        );
      })}
      <ShowMore query={holders.query} label="Show more" />
      {adding && (
        <PickDialog
          title={adding === 'user' ? 'Add account' : 'Add group'}
          noun={adding === 'user' ? 'accounts' : 'groups'}
          label={adding === 'user' ? 'Account' : 'Group'}
          find={adding === 'user' ? findAccounts : findGroups}
          act={(id) => api.put<unknown>(path(adding, id), { role_id: role.id })}
          onDone={refresh}
          onClose={() => setAdding(null)}
        />
      )}
    </IdCard>
  );
}
