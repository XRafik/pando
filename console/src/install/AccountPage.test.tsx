// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountPage } from './Account';
import { Accounts } from './Accounts';
import type { Account } from './Accounts';
import { mount, reply, unanswered } from '../ui/testing';
import type { Mounted, Seed } from '../ui/testing';

const ana: Account = {
  id: 'usr_01',
  adapter_id: 'idp_okta',
  adapter_name: 'Okta',
  external_id: '00u8f2kq1zA7',
  display_name: 'Ana Ruiz',
  email: 'ana@example.com',
  status: 'active',
  must_change_password: false,
  install_role_id: '',
  install_roles: [{ role_id: 'role_app_manager', role_name: 'app manager', via: { kind: 'group', group_id: 'grp_1', name: 'platform-team' } }],
  created_at: '2026-03-04T12:00:00Z',
};

const routes: Record<string, unknown> = {
  '/users/usr_01/identities': {
    identities: [
      { adapter_id: 'idp_okta', adapter_name: 'Okta', adapter_kind: 'oidc', external_id: '00u8f2kq1zA7', user_id: 'usr_01', origin: true, scim: false, created_by: '', created_at: '', last_sign_in_at: new Date(Date.now() - 2 * 3600_000).toISOString() },
      { adapter_id: 'idp_gh', adapter_name: 'GitHub', adapter_kind: 'github', external_id: 'ana', user_id: 'usr_01', origin: false, scim: false, created_by: '', created_at: '' },
    ],
  },
  '/users/usr_01/apps': {
    apps: [
      { app_id: 'app_1', app_name: 'crewmate', owner: true, can_manage: true, control: [], data: [] },
      { app_id: 'app_2', app_name: 'sales-dashboard', owner: false, can_manage: true, control: [{ grant_id: 'gr_1', plane: 'control', role_name: 'operator', via: 'user' }], data: [] },
    ],
  },
  '/users/usr_01/app-limit': { limit: 10, source: 'policy', owned: 2, max_apps: null },
  '/users/usr_01': ana,
  'member=usr_01': { groups: [{ id: 'grp_1', name: 'platform-team' }] },
  '/groups': { groups: [{ id: 'grp_1', name: 'platform-team' }, { id: 'grp_2', name: 'design' }] },
  '/roles': { roles: [{ id: 'role_app_manager', name: 'app manager', builtin: true, verbs: [] }] },
  '/audit': { events: [{ id: 1, occurred_at: '2026-10-24T14:32:00', principal_kind: 'user', principal_id: 'usr_01', action: 'app.deploy', outcome: 'success' }, { id: 2, occurred_at: '2026-10-24T14:40:00', principal_kind: 'user', principal_id: 'usr_01', action: 'app.restart', outcome: 'denied' }], next_before: '' },
};

/** Answers the first route, in order of specificity, whose key the address holds. */
function server(over: Record<string, unknown> = {}) {
  const all = { ...routes, ...over };
  const keys = Object.keys(all).sort((x, y) => y.length - x.length);
  vi.stubGlobal('fetch', async (url: string | URL | Request) => {
    const path = String(url);
    const hit = keys.find((k) => path.includes(k));
    return hit === undefined ? unanswered() : reply(all[hit]);
  });
}

let screen: Mounted | undefined;
afterEach(() => {
  screen?.unmount();
  screen = undefined;
  vi.unstubAllGlobals();
});

async function until(text: string) {
  for (let i = 0; i < 20 && !screen!.text().includes(text); i++) await screen!.settle(() => {});
  expect(screen!.text()).toContain(text);
}

const manager: Seed = [[['me'], { user_id: 'usr_admin', verbs: ['install.users.manage', 'install.audit.read', 'install.view'] }]];

describe('an account’s page', () => {
  it('says who it is, what it holds, its apps and its latest activity', async () => {
    server();
    const onOpenApp = vi.fn();
    screen = mount(<AccountPage userID="usr_01" onBack={() => {}} onAudit={() => {}} onOpenApp={onOpenApp} />, manager);
    await until('sales-dashboard');
    await until('app.restart');
    const text = screen.text();
    expect(text).toContain('Ana Ruiz');
    expect(text).toContain('Active');
    expect(text).toContain('Okta ID');
    expect(text).toContain('March 4, 2026');
    expect(text).toContain('2 hours ago');
    expect(text).toContain('usr_01');
    expect(text).toContain('App manager');
    expect(text).not.toContain('through');
    expect(text).toContain('platform-team');
    expect(text).toContain('Okta, GitHub');
    expect(text).toContain('2 of 10');
    expect(text).toContain('Owner');
    expect(text).toContain('Operator');
    expect(text).toContain('Oct 24 14:32');
    expect(text).toContain('Denied');
    // No password to reset at a provider.
    expect(text).not.toContain('Reset password');

    await screen.click('crewmate');
    expect(onOpenApp).toHaveBeenCalledWith('app_1');
  });

  it('opens its role, groups and sign-in identities from their rows', async () => {
    server();
    screen = mount(<AccountPage userID="usr_01" onBack={() => {}} onAudit={() => {}} />, manager);
    await until('Okta, GitHub');
    await until('platform-team');

    const buttons = (label: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent === label);
    await screen.settle(() => buttons('Change')[0]!.click());
    expect(document.body.textContent).toContain('Role for Ana Ruiz');
    await screen.press('Done');

    await screen.settle(() => buttons('Change')[1]!.click());
    expect(document.body.textContent).toContain('Overrides group limits.');
    await screen.press('Cancel');

    const manage = buttons('Manage');
    await screen.settle(() => manage[0]!.click());
    expect(document.body.textContent).toContain('Groups for Ana Ruiz');
    await screen.press('Done');

    await screen.settle(() => manage[1]!.click());
    expect(document.body.textContent).toContain('Sign-in identities');
    expect(document.body.textContent).toContain('Link identity');
  });

  it('links its activity to the Audit log', async () => {
    server();
    const onAudit = vi.fn();
    screen = mount(<AccountPage userID="usr_01" onBack={() => {}} onAudit={onAudit} />, manager);
    await until('app.deploy');
    await screen.press('Open in audit log');
    expect(onAudit.mock.calls[0]?.[0]).toContain('usr_01');
  });

  it('offers a local account’s resets, and says when nothing is there yet', async () => {
    server({
      '/users/usr_01': { ...ana, adapter_id: 'idp_local', adapter_name: 'Local users', external_id: 'ana.ruiz', two_factor_enabled: true, install_roles: [] },
      '/users/usr_01/identities': { identities: [] },
      '/users/usr_01/apps': { apps: [] },
      '/audit': { events: [], next_before: '' },
    });
    screen = mount(<AccountPage userID="usr_01" onBack={() => {}} onAudit={() => {}} />, manager);
    await until('No events yet');
    await until('No apps');
    const text = screen.text();
    expect(text).toContain('Username');
    expect(text).toContain('ana.ruiz');
    expect(text).toContain('Reset password');
    expect(text).toContain('Reset two-factor');
    expect(text).toContain('No role');
    expect(text).toContain('Never');
  });
});

describe('the Accounts list', () => {
  it('shows each account’s name, username, provider, roles and status', async () => {
    server({
      '/users': {
        users: [ana, { ...ana, id: 'usr_02', adapter_id: 'idp_local', adapter_name: 'Local users', external_id: 'lchen', display_name: 'Lee Chen', status: 'suspended', install_roles: [] }],
      },
    });
    screen = mount(<Accounts onOpen={() => {}} />, manager);
    await until('Lee Chen');
    const text = screen.text();
    expect(text).toContain('AR');
    expect(text).toContain('00u8f2kq1zA7');
    expect(text).toContain('Okta');
    expect(text).toContain('Password');
    expect(text).toContain('App manager');
    expect(text).not.toContain('through');
    expect(text).toContain('No role');
    expect(text).toContain('Suspended');
  });

  it('stacks its rows at phone width', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
    server({ '/users': { users: [ana] } });
    const onOpen = vi.fn();
    screen = mount(<Accounts onOpen={onOpen} />, manager);
    await until('Ana Ruiz');
    expect(document.querySelector('.pando-account-rows')).not.toBeNull();
    await screen.click('Ana Ruiz');
    expect(onOpen).toHaveBeenCalled();
  });
});
