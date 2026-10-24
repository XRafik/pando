// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount, reply, type Mounted, type Seed } from '../ui/testing';
import { Identity } from './Identity';
import { GroupPage, removeApp, setLevel } from './GroupPage';
import { RolePage, heldBy } from './RolePage';
import { providerOf, sourceLabel } from './identityParts';

// Groups and roles (R-078, R-082): the two tabs, a group's page and a role's.

let screen: Mounted | undefined;
const open = (...args: Parameters<typeof mount>) => (screen = mount(...args));

afterEach(() => {
  screen?.unmount();
  screen = undefined;
  vi.unstubAllGlobals();
});

/** One page of a paged list, as the cache holds it. */
const page = (rows: object) => ({ pages: [rows], pageParams: [''] });

/** A fetch that answers every request with `body`, or the body of the first
 *  of `routes` its address holds, and remembers each one. */
function recording(body: unknown = {}, routes: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      path: String(url).replace(/^.*\/api\/v1/, ''),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const match = Object.keys(routes).find((part) => String(url).includes(part));
    return reply(match === undefined ? body : routes[match]);
  });
  return calls;
}

const okta = { id: 'grp_okta', name: 'eng', source: 'idp_okta', source_name: 'Okta', member_count: 4 };
const ops = { id: 'grp_ops', name: 'ops', member_count: 2, linked_from: ['grp_okta'], install_role_id: 'role_admin' };
const roles = [
  { id: 'role_admin', name: 'administrator', scope: 'install', builtin: true, verbs: ['install.view', 'install.users.manage'] },
  { id: 'role_viewer', name: 'viewer', scope: 'app', builtin: true, verbs: ['app.view'] },
  { id: 'role_rel', name: 'Releasers', scope: 'install', builtin: false, verbs: ['install.deploys.approve'] },
];

const listSeed: Seed = [
  [['groups', 'list', '', {}], page({ groups: [ops, okta], total: 2 })],
  [['roles', 'all'], { roles }],
  [['ai-functions'], { functions: [] }],
];

describe('groups and roles', () => {
  it('lists groups by role, members and source, and opens one', async () => {
    const go = vi.fn();
    const s = open(<Identity canEdit go={go} />, listSeed);
    expect(s.text()).toContain('Administrator');
    expect(s.text()).toContain('No role');
    expect(s.text()).toContain('Pando · 1 Okta group');
    expect(s.text()).toContain('Okta');
    await s.click('ops');
    expect(go).toHaveBeenCalledWith({ view: 'admin', section: 'identity', groupID: 'grp_ops' });
  });

  it('lists roles by scope, permissions and source on its tab', async () => {
    const onTab = vi.fn();
    const go = vi.fn();
    const s = open(<Identity canEdit tab="roles" onTab={onTab} go={go} />, listSeed);
    expect(s.text()).toContain('Built in');
    expect(s.text()).toContain('Custom');
    expect(s.text()).toContain('Installation');
    expect(s.text()).toContain('Add role');
    await s.click('Releasers');
    expect(go).toHaveBeenCalledWith({ view: 'admin', section: 'identity', roleID: 'role_rel' });
    await s.settle(() => document.querySelector<HTMLElement>('[role="tab"]')!.click());
    expect(onTab).toHaveBeenCalledWith('groups');
  });

  it('adds a group by name and opens it', async () => {
    const calls = recording({ id: 'grp_new' });
    const go = vi.fn();
    const s = open(<Identity canEdit go={go} />, listSeed);
    await s.press('Add group');
    await s.fill('Name', ' platform ');
    await s.press('Add group');
    expect(calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', path: '/groups', body: { name: 'platform' } });
    expect(go).toHaveBeenCalledWith({ view: 'admin', section: 'identity', groupID: 'grp_new' });
  });

  it('adds a role from the verbs of its scope and opens it', async () => {
    const calls = recording({ id: 'role_new' });
    const go = vi.fn();
    const s = open(<Identity canEdit tab="roles" go={go} />, [
      ...listSeed,
      [['verbs'], { verbs: [{ verb: 'app.view', scope: 'app' }, { verb: 'install.view', scope: 'install' }] }],
    ]);
    await s.press('Add role');
    expect(s.text()).not.toContain('install.view');
    await s.fill('Name', 'Readers');
    await s.click('app.view');
    await s.press('Add role');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Readers', scope: 'app', verbs: ['app.view'] });
    expect(go).toHaveBeenCalledWith({ view: 'admin', section: 'identity', roleID: 'role_new' });
  });

  it('stacks the rows at phone width', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
    const s = open(<Identity canEdit />, listSeed);
    const links = [...document.querySelectorAll('a.pando-id-item')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/admin/identity/groups/grp_ops', '/admin/identity/groups/grp_okta']);
    expect(s.text()).toContain('2 members');
  });

  it('names where a group comes from', () => {
    expect(sourceLabel({ id: 'g', name: 'g' }, [])).toBe('Pando');
    expect(sourceLabel(okta, [])).toBe('Okta');
    expect(sourceLabel({ ...ops, linked_from: ['a', 'b'] }, [])).toBe('Pando · 2 provider groups');
    expect(providerOf(['grp_okta'], [okta])).toBe('Okta');
  });
});

const groupSeed = (group: object, members: object[] = [], total = members.length): Seed => [
  [['groups', 'grp_ops'], group],
  [['roles', 'all'], { roles }],
  [['groups', 'grp_ops', 'app-limit'], { max_apps: 0 }],
  [['groups', 'synced'], [okta]],
  [['groups', 'grp_ops', 'members', '', { limit: 5 }], page({ members, total })],
  [['groups', 'grp_ops', 'apps', '', {}], page({ apps: [{ app_id: 'app_1', app_name: 'wiki', can_manage: true, control: [{ grant_id: 'gr_c', role_id: 'role_viewer' }], data: [] }] })],
  [['roles', 'app'], { roles: roles.filter((r) => r.scope === 'app') }],
  [['me'], { verbs: [] }],
];

describe('a group’s page', () => {
  const dana = { id: 'usr_1', display_name: 'Dana K', external_id: 'dana' };

  it('shows its details, access, members and apps', async () => {
    const go = vi.fn();
    const s = open(<GroupPage groupID="grp_ops" canEdit go={go} />, groupSeed({ ...ops, created_at: '2026-01-12T12:00:00Z' }, [dana], 7));
    for (const said of ['Details', 'Pando', 'January 12, 2026', 'grp_ops', 'Administrator', 'Unlimited', 'Okta groups', 'eng', 'Dana K', 'Show all 7', 'wiki', 'Rename', 'Delete']) {
      expect(s.text()).toContain(said);
    }
    expect(document.querySelector<HTMLSelectElement>('select[aria-label="Access to wiki"]')?.value).toBe('role_viewer');
    await s.click('Dana K');
    expect(go).toHaveBeenCalledWith({ view: 'admin', section: 'accounts', userID: 'usr_1' });
    await s.press('Groups and roles');
    expect(go).toHaveBeenCalledWith({ view: 'admin', section: 'identity' });
  });

  it('leaves a synced group’s name and members to its provider', () => {
    const s = open(<GroupPage groupID="grp_ops" canEdit go={() => {}} />, groupSeed({ ...okta, id: 'grp_ops' }, [dana]));
    expect(s.text()).toContain('Okta');
    expect(s.text()).not.toContain('Rename');
    expect(s.text()).not.toContain('Delete');
    expect(document.querySelector('[aria-label="Remove Dana K"]')).toBeNull();
    expect(s.text()).not.toContain('Okta groups');
  });

  it('removes a member, and changes its role', async () => {
    const calls = recording({}, { '/groups/grp_ops': ops });
    const s = open(<GroupPage groupID="grp_ops" canEdit go={() => {}} />, groupSeed(ops, [dana]));
    await s.toggle('Remove Dana K');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/groups/grp_ops/members/usr_1')).toBe(true);
    await s.toggle('Change role');
    await s.fill('Role', 'role_rel');
    await s.press('Save');
    expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/groups/grp_ops/role', body: { role_id: 'role_rel' } });
  });

  it('renames a Pando group', async () => {
    const calls = recording();
    const s = open(<GroupPage groupID="grp_ops" canEdit go={() => {}} />, groupSeed(ops));
    await s.press('Rename');
    await s.fill('Name', 'platform');
    await s.press('Rename');
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/groups/grp_ops', body: { name: 'platform' } });
  });

  it('deletes a Pando group, saying whose access goes, and links provider groups', async () => {
    const calls = recording({}, { '/groups/grp_ops': ops });
    const go = vi.fn();
    const s = open(<GroupPage groupID="grp_ops" canEdit go={go} />, groupSeed(ops));
    await s.toggle('Manage provider groups');
    expect(s.text()).toContain('Okta, 4 members');
    await s.click('eng');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/groups/grp_ops/links/grp_okta')).toBe(true);
    await s.press('Done');
    await s.press('Delete');
    expect(s.text()).toContain('The 2 members keep their accounts');
    await s.press('Delete group');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/groups/grp_ops')).toBe(true);
    expect(go).toHaveBeenCalledWith({ view: 'admin', section: 'identity' });
  });

  it('changes an app’s level from its row', async () => {
    const apps = (groupSeed(ops)[5]![1] as { pages: object[] }).pages[0];
    const calls = recording({}, { '/groups/grp_ops/apps': apps, '/groups/grp_ops': ops });
    const s = open(<GroupPage groupID="grp_ops" canEdit go={() => {}} />, groupSeed(ops));
    await s.settle(() => {
      const select = document.querySelector<HTMLSelectElement>('select[aria-label="Access to wiki"]')!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'open');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/apps/app_1/grants/gr_c')).toBe(true);
    await s.toggle('Remove wiki');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
  });

  it('sets an app’s level: a role includes opening it, and remove takes every grant', async () => {
    const calls = recording();
    const row = { app_id: 'app_1', app_name: 'wiki', can_manage: true, control: [] as { grant_id: string; role_id?: string }[], data: [] as { grant_id: string }[] };
    await setLevel('grp_ops', row, 'role_viewer');
    expect(calls).toEqual([
      { method: 'POST', path: '/apps/app_1/grants', body: { plane: 'control', role_id: 'role_viewer', principal_kind: 'group', principal_id: 'grp_ops' } },
      { method: 'POST', path: '/apps/app_1/grants', body: { plane: 'data', principal_kind: 'group', principal_id: 'grp_ops' } },
    ]);
    calls.length = 0;
    const held = { ...row, control: [{ grant_id: 'gr_c', role_id: 'role_viewer' }], data: [{ grant_id: 'gr_d' }] };
    await setLevel('grp_ops', held, 'role_owner');
    expect(calls).toEqual([{ method: 'PATCH', path: '/apps/app_1/grants/gr_c', body: { role_id: 'role_owner' } }]);
    calls.length = 0;
    await setLevel('grp_ops', held, 'open');
    expect(calls).toEqual([{ method: 'DELETE', path: '/apps/app_1/grants/gr_c', body: undefined }]);
    calls.length = 0;
    await removeApp(held);
    expect(calls.map((c) => c.path)).toEqual(['/apps/app_1/grants/gr_c', '/apps/app_1/grants/gr_d']);
  });
});

const holdersSeed = (role: object, holders: object[], groups = 0): Seed => [
  [['roles', String((role as { id: string }).id), 'holders', '', {}], page({ role, holders, total: holders.length, groups })],
  [['verbs'], { verbs: [{ verb: 'install.view', scope: 'install' }, { verb: 'install.deploys.approve', scope: 'install' }, { verb: 'app.view', scope: 'app' }] }],
];

describe('a role’s page', () => {
  const holders = [
    { kind: 'group', id: 'grp_rel', name: 'release-approvers', via: 'direct' },
    { kind: 'user', id: 'usr_1', name: 'Sam Okafor', username: 'sam', via: 'direct' },
    { kind: 'user', id: 'usr_2', name: 'Ben Meeker', username: 'ben', via: 'group' },
  ];

  it('lists who holds it, a holder through a group with a lock and no remove, and never where', () => {
    const s = open(<RolePage roleID="role_rel" canEdit go={() => {}} />, holdersSeed(roles[2]!, holders, 1));
    expect(s.text()).toContain('2 accounts, 1 group');
    expect(document.querySelector('[aria-label="Remove Sam Okafor"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Remove release-approvers"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Remove Ben Meeker"]')).toBeNull();
    expect(document.querySelector('[title="From a group"]')).not.toBeNull();
    expect(s.text()).not.toMatch(/through|on release/);
    expect(s.text()).toContain('Approve or reject deploys on any app');
  });

  it('edits a custom role’s permissions as checkboxes of its scope', async () => {
    const calls = recording();
    const s = open(<RolePage roleID="role_rel" canEdit go={() => {}} />, holdersSeed(roles[2]!, []));
    expect(s.text()).toContain('Nobody');
    await s.press('Edit');
    expect(s.text()).not.toContain('app.view');
    await s.click('install.view');
    await s.press('Save');
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: '/roles/role_rel',
      body: { verbs: ['install.deploys.approve', 'install.view'] },
    });
  });

  it('adds and removes a direct holder of an installation role', async () => {
    const calls = recording({ users: [{ id: 'usr_9', external_id: 'ada' }] });
    const s = open(<RolePage roleID="role_rel" canEdit go={() => {}} />, holdersSeed(roles[2]!, holders, 1));
    await s.press('Group');
    expect(s.text()).toContain('Add group');
    await s.press('Cancel');
    await s.press('Account');
    expect(s.text()).toContain('Add account');
    await s.press('Cancel');
    await s.toggle('Remove Sam Okafor');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/users/usr_1/role')).toBe(true);
  });

  it('renames and deletes a custom role', async () => {
    const calls = recording({}, { '/holders': page({ role: roles[2], holders: [] }).pages[0] });
    const go = vi.fn();
    const s = open(<RolePage roleID="role_rel" canEdit go={go} />, holdersSeed(roles[2]!, []));
    await s.press('Rename');
    await s.fill('Name', 'Approvers');
    await s.press('Rename');
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/roles/role_rel', body: { name: 'Approvers' } });
    await s.press('Delete');
    expect(s.text()).toContain('They keep any access they hold another way.');
    await s.press('Delete role');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/roles/role_rel')).toBe(true);
    expect(go).toHaveBeenCalledWith({ view: 'admin', section: 'identity', tab: 'roles' });
  });

  it('keeps a built-in role read only', () => {
    const s = open(<RolePage roleID="role_admin" canEdit go={() => {}} />, holdersSeed(roles[0]!, holders, 1));
    expect(s.text()).toContain('Built in');
    for (const unsaid of ['Rename', 'Delete', 'Edit']) expect(s.text()).not.toContain(unsaid);
  });

  it('adds no holders to an app role here: it is granted per app', () => {
    const s = open(<RolePage roleID="role_viewer" canEdit go={() => {}} />, holdersSeed(roles[1]!, holders, 1));
    expect(s.text()).toContain('App');
    expect(document.querySelector('[aria-label="Remove Sam Okafor"]')).toBeNull();
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Account')).toBe(false);
  });

  it('says who holds it in a few words', () => {
    expect(heldBy()).toBe('');
    expect(heldBy({ role: roles[0]!, holders: [], total: 0, groups: 0 })).toBe('Nobody');
    expect(heldBy({ role: roles[0]!, holders: [], total: 1, groups: 0 })).toBe('1 account');
    expect(heldBy({ role: roles[0]!, holders: [], total: 10000, groups: 2, total_is_lower_bound: true })).toBe('9,998 accounts+, 2 groups');
  });
});
