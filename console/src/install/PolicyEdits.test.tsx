// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';

import { mount, reply, unanswered, type Mounted } from '../ui/testing';
import type { PolicyPage } from '../app/route';
import { PolicyPageView, SaveBar, UpdateSettings } from './PolicyPages';
import { PolicyDraftContext, usePolicyDraft } from './policyDraft';

// Every control on every page of Policy edits the one draft, turned over at
// the boundary where a switch reads as what is on: what is saved is the API's
// own field, with the API's own sense.

function Harness({ page }: Readonly<{ page: PolicyPage | 'updates' }>) {
  const draft = usePolicyDraft(true, true);
  return (
    <PolicyDraftContext.Provider value={draft}>
      {page === 'updates' ? <UpdateSettings /> : <PolicyPageView page={page} />}
      <SaveBar />
    </PolicyDraftContext.Provider>
  );
}

let screen: Mounted | undefined;
let saved: Record<string, unknown> | undefined;

afterEach(() => {
  screen?.unmount();
  screen = undefined;
  saved = undefined;
  vi.unstubAllGlobals();
});

function open(page: PolicyPage | 'updates', policy: object) {
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      saved = JSON.parse(String(init.body));
      return reply(saved);
    }
    return unanswered();
  });
  screen = mount(<Harness page={page} />, [
    [['policy'], policy],
    [['config'], { file: '', settings: [], policy: [] }],
    [['apps', 'approval-policy', 'picked', []], []],
    [['apps', 'approval-policy', 'search', ''], [{ id: 'app_01', name: 'crewmate' }]],
  ]);
}

/** Flips every switch on the page, once each. */
async function flipAll() {
  for (const el of [...document.querySelectorAll<HTMLInputElement>('input[role="switch"]')]) {
    if (!el.disabled) await screen!.settle(() => el.click());
  }
}

/** Sets a field by its accessible name, as typing or choosing would. */
async function set(label: string, value: string) {
  const el = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  expect(el, label).toBeTruthy();
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function save() {
  await screen!.press('Save policy');
  expect(saved).toBeDefined();
  return saved!;
}

describe('editing each page of policy', () => {
  it('Sources and builds', async () => {
    open('sources', { min_security_score: 50, insecure_action: 'stop' });
    await set('Allowed sources', 'github.com/acme/*\n\n gitlab.com/x ');
    await set('Build isolation', '20');
    await set('Runtime isolation', '30');
    await set('Grace period, in hours', '12');
    await flipAll();
    await set('Minimum security score', '400');
    expect(await save()).toMatchObject({
      source_allowlist: ['github.com/acme/*', 'gitlab.com/x'],
      min_build_isolation: 20,
      min_runtime_isolation: 30,
      min_security_score: 100,
      insecure_grace_hours: 12,
      insecure_action: 'warn',
      ignore_unfixable_findings: true,
      disable_ai_screening: true,
    });
  });

  it('Access', async () => {
    open('access', { disabled_verbs: ['app.logs.read'] });
    await screen!.click('Not allowed');
    await flipAll();
    expect(await save()).toMatchObject({
      public_sharing: 'none',
      disabled_verbs: ['app.logs.read', 'app.exec'],
      disable_password_sign_in: true,
      disable_jit_provisioning: true,
      require_local_two_factor: true,
      disable_anonymous_use_audit: true,
      disable_anonymous_denial_audit: true,
    });
  });

  it('Egress', async () => {
    open('egress', {});
    await set('Destinations', 'allowlist');
    await set('Loosening by an app', 'forbidden');
    await flipAll();
    expect(await save()).toMatchObject({ egress_mode: 'allowlist', egress_loosening: 'forbidden', egress_block_private: true, allow_private_webhooks: true });
  });

  it('Deployments', async () => {
    open('deployments', {});
    await set('Approvals needed', '0');
    await set('Request expiry, in hours', '48');
    await set('Concurrent deployments per replica', '4');
    await flipAll();
    expect(await save()).toMatchObject({
      deploy_approval_required: true,
      deploy_approval_count: 1,
      deploy_approval_expiry_hours: 48,
      max_concurrent_deploys: 4,
      allow_cpu_oversubscription: true,
      allow_memory_oversubscription: true,
    });
  });

  it('Tokens', async () => {
    open('tokens', {});
    await set('Longest token lifetime, in days', '30');
    await set('Verbs tokens can\'t use', 'app.exec\napp.delete');
    expect(await save()).toMatchObject({ max_token_lifetime_days: 30, agent_disabled_verbs: ['app.exec', 'app.delete'] });
  });

  it('Apps', async () => {
    open('apps', {});
    await set('Stop idle apps after, in days', '30');
    await set('Delete idle apps after, in days', '90');
    await set('Apps per person', '5');
    await set('Disk for app logs, in megabytes', '200');
    await flipAll();
    expect(await save()).toMatchObject({
      idle_stop_days: 30,
      idle_delete_days: 90,
      max_apps_per_user: 5,
      max_log_disk_bytes: 200_000_000,
      stop_orphaned_apps: false,
      require_backup_before_destroy: true,
    });
  });

  it('Audit log', async () => {
    open('audit', {});
    await set('Months to keep', '1');
    await set('Archive', 'export');
    await set('Backup destination', ' bak_s3 ');
    expect(await save()).toMatchObject({ audit_retention_months: 3, audit_archive: 'export', audit_archive_destination: 'bak_s3' });
  });

  it('the update settings', async () => {
    open('updates', {});
    await screen!.click('With release candidates');
    await flipAll();
    expect(screen!.text()).toContain('Maintenance window, in UTC');
    await set('Maintenance window, in UTC', 'daily 03:30 1h');
    expect(await save()).toMatchObject({
      update_channel: 'prerelease',
      disable_update_check: true,
      upgrade_in_place: true,
      auto_upgrade_patches: true,
      maintenance_window: 'daily 03:30 1h',
    });
  });

  it('says why a save was refused', async () => {
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? reply({ code: 'VALID_INVALID', message: 'Password sign-in can’t be turned off while no identity provider is on.' }, 400) : unanswered(),
    );
    screen = mount(<Harness page="access" />, [
      [['policy'], {}],
      [['config'], { file: '', settings: [], policy: [] }],
    ]);
    await screen.toggle('Password sign-in');
    await screen.press('Save policy');
    expect(screen.text()).toContain('Password sign-in can’t be turned off while no identity provider is on.');
  });
});
