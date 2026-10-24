import { describe, expect, it, vi } from 'vitest';

// The API client reads the page's address when it loads. Rendered on the
// server here, so there is no page: give it the least it needs.
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= { location: { pathname: '/' } };
});

import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { RoleRow, accessLevel, eventTime, lastSignIn } from './Account';
import { RoleTags, heldRoleNames, providerName, refreshMembership, roleNames } from './Accounts';
import type { Account, HeldRole, Role } from './Accounts';
import { initials } from './Avatar';

const roles: Role[] = [
  { id: 'role_administrator', name: 'administrator', builtin: true, verbs: [] },
  { id: 'role_auditor', name: 'audit readers', builtin: false, verbs: [] },
];

const direct: HeldRole = { role_id: 'role_auditor', via: { kind: 'direct' } };
const okta: HeldRole = {
  role_id: 'role_administrator',
  via: { kind: 'group', group_id: 'grp_01', name: 'pando-administrator', source: 'idp_okta', source_name: 'Okta' },
};
const ops: HeldRole = { role_id: 'role_auditor', via: { kind: 'group', group_id: 'grp_02', name: 'Ops' } };

describe('heldRoleNames', () => {
  it('is each role once, alphabetically, each a value of its own for the column filter', () => {
    expect(heldRoleNames([okta, direct, ops], roles)).toEqual(['Administrator', 'Audit readers']);
  });

  it('is None only for an account holding nothing by any route', () => {
    expect(heldRoleNames([], roles)).toEqual(['None']);
    expect(heldRoleNames([ops], roles)).toEqual(['Audit readers']);
  });

  it('names a role from the account when the roles list cannot be read, else shows its ID', () => {
    expect(heldRoleNames([{ ...direct, role_name: 'audit readers' }], [])).toEqual(['Audit readers']);
    expect(heldRoleNames([direct], [])).toEqual(['role_auditor']);
  });
});

// The user's rule: a role held through a group stands alone, never "through <group>".
describe('the Role column', () => {
  it('shows every role once, and never where a group-held one comes from', () => {
    const html = renderToString(<RoleTags held={[direct, okta, ops]} roles={roles} />);
    expect(html).toContain('Audit readers');
    expect(html).toContain('Administrator');
    expect(html).not.toContain('through');
    expect(html.match(/Audit readers/g)).toHaveLength(1);
  });

  it('says No role for an account holding nothing', () => {
    expect(renderToString(<RoleTags held={[]} roles={roles} />)).toContain('No role');
  });
});

describe('Signs in with', () => {
  it('says Password for a local account, and the provider by name otherwise', () => {
    expect(providerName({ adapter_id: 'idp_local', adapter_name: 'Local users' })).toBe('Password');
    expect(providerName({ adapter_id: 'idp_okta', adapter_name: 'Okta' })).toBe('Okta');
    expect(providerName({ adapter_id: 'idp_okta' })).toBe('idp_okta');
  });
});

describe('initials', () => {
  it('takes up to two words', () => {
    expect(initials('Ana Ruiz')).toBe('AR');
    expect(initials('ci-bot')).toBe('CB');
    expect(initials('pando')).toBe('P');
    expect(initials('Mary Ann Smith')).toBe('MA');
    expect(initials('  ')).toBe('');
  });
});

const account: Account = {
  id: 'usr_01',
  adapter_id: 'idp_okta',
  external_id: '00ueve',
  status: 'active',
  must_change_password: false,
  install_role_id: '',
  install_roles: [okta],
};

function roleRow(a: Account, manage: boolean, known?: Role[]) {
  return renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <RoleRow account={a} roles={known} manage={manage} isSelf={false} />
    </QueryClientProvider>,
  );
}

describe('refreshMembership', () => {
  it('refreshes the groups and every account view, which show what a group carries', () => {
    const client = new QueryClient();
    const refreshed: unknown[] = [];
    client.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
      refreshed.push(filters?.queryKey);
      return Promise.resolve();
    }) as QueryClient['invalidateQueries'];
    refreshMembership(client);
    expect(refreshed).toEqual([['groups'], ['users']]);
  });
});

describe('the account page role', () => {
  it('names a group-held role as a role, without a picker or where it comes from', () => {
    const html = roleRow(account, true, roles);
    expect(html).toContain('Administrator');
    expect(html).not.toContain('through');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('No role');
    expect(html).toContain('Change');
  });

  it('says No role when the account holds nothing, and names every role held', () => {
    expect(roleRow({ ...account, install_roles: [] }, false, roles)).toContain('No role');
    expect(roleNames([direct, okta], roles)).toBe('Audit readers, Administrator');
  });

  it('offers Change only to somebody who manages accounts, once the roles arrive', () => {
    expect(roleRow(account, false, roles)).not.toContain('Change');
    expect(roleRow(account, true, undefined)).not.toContain('Change');
  });

  it('names your own role without the roles list, which needs install.view', () => {
    const own = { ...account, install_roles: [{ ...direct, role_name: 'audit readers' }] };
    expect(roleRow(own, false, undefined)).toContain('Audit readers');
  });
});

describe('the account page cards', () => {
  it('says what the account may do on an app in a word or two', () => {
    const base = { app_id: 'app_1', app_name: 'crewmate', owner: false, control: [], data: [] };
    expect(accessLevel({ ...base, owner: true })).toBe('Owner');
    expect(accessLevel({ ...base, control: [{ role_name: 'operator' }] })).toBe('Operator');
    expect(accessLevel({ ...base, data: [{}] })).toBe('Can open');
    expect(accessLevel(base)).toBe('—');
  });

  it('says when the account last signed in by any identity, or never', () => {
    expect(lastSignIn([])).toBe('Never');
    const at = new Date(Date.now() - 3 * 3600_000).toISOString();
    const older = new Date(Date.now() - 30 * 86400_000).toISOString();
    const id = { adapter_id: 'idp_local', adapter_name: 'Local users', adapter_kind: 'local', external_id: 'x', user_id: 'usr_1', origin: true, scim: false, created_by: '', created_at: '' };
    expect(lastSignIn([{ ...id, last_sign_in_at: older }, { ...id, last_sign_in_at: at }, id])).toBe('3 hours ago');
  });

  it('dates each event in its own row', () => {
    expect(eventTime('2026-10-24T14:32:00')).toBe('Oct 24 14:32');
  });
});
