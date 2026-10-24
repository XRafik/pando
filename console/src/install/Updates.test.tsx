import { describe, expect, it, vi } from 'vitest';

// The API client reads the page's address when it loads. Rendered on the
// server here, so there is no page: give it the least it needs.
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= { location: { pathname: '/' } };
});

import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { Attempt, Plan, Status } from '@api/types.gen';
import { UpdateSettings } from './PolicyPages';
import { PandoCard } from './Updates';
import { PolicyDraftContext, usePolicyDraft } from './policyDraft';

const status: Status = {
  current: '0.3.1',
  development: false,
  enabled: true,
  channel: 'stable',
  checked_at: '2026-10-04T06:00:00Z',
  latest: '0.4.0',
  available: true,
  releases: [{ version: '0.4.0', prerelease: false, published_at: '2026-10-03T00:00:00Z', url: '', notes: '### Security\n\nNo new advisories.\n', security: false, breaking: true }],
  security: false,
  breaking: true,
  upgrade: { version: '0.4.0', image: 'trypando/pando:0.4.0', command: 'curl … && docker compose up -d', instructions: 'Download it.' },
};

function render(
  plan: Plan,
  last: Attempt | null = null,
  verbs: string[] = ['install.view', 'install.upgrade'],
  st: Status = status,
) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queries.setQueryData(['me'], { verbs });
  queries.setQueryData(['updates'], st);
  queries.setQueryData(['upgrade-plan', '0.4.0'], plan);
  queries.setQueryData(['upgrade-last'], { upgrade: last });
  // React separates adjacent text with empty comments in server output.
  return renderToString(
    <QueryClientProvider client={queries}>
      <PandoCard settings={<span>settings</span>} />
    </QueryClientProvider>,
  ).replaceAll('<!-- -->', '');
}

const possible: Plan = {
  current: '0.3.1',
  target: '0.4.0',
  possible: true,
  reasons: [],
  tag: 'trypando/pando:latest',
  breaking: [],
  note: 'Every app is unreachable while Pando restarts.',
};

describe('the Pando card (R-349, R-351)', () => {
  it('says what runs, the latest, its status and when Pando checked', () => {
    const html = render(possible);
    for (const k of ['>Running<', '>Latest<', '>Status<', '>Checked<', '0.3.1', '0.4.0', 'Update, with breaking changes']) {
      expect(html).toContain(k);
    }
    expect(html).toContain('Check now');
    expect(html).toContain('Release notes');
    expect(html).toContain('Update settings');
  });

  it('offers a check before the first one', () => {
    const html = render(possible, null, undefined, { ...status, checked_at: undefined, available: false, releases: [] });
    expect(html).toContain('hasn’t checked for releases yet');
    expect(html).toContain('Check now');
  });

  it('offers none while the check is off', () => {
    const html = render(possible, null, undefined, { ...status, enabled: false, available: false, releases: [] });
    expect(html).not.toContain('Check now');
    expect(html).toContain('The update check is off.');
  });

  it('marks a security fix', () => {
    expect(render(possible, null, undefined, { ...status, security: true })).toContain('Security fix');
  });
});

describe('upgrading in place from the Updates screen (R-355 – R-359)', () => {
  it('offers the upgrade when Pando can replace itself', () => {
    const html = render(possible);
    expect(html).toContain('Upgrade to 0.4.0');
    expect(html).toContain('has breaking changes');
    expect(html).not.toContain('docker compose up -d');
  });

  it('says it needs install.upgrade to someone without it', () => {
    const html = render(possible, null, ['install.view']);
    expect(html).toContain('needs install.upgrade');
  });

  it('lists every reason it cannot, each with what to change', () => {
    const html = render({
      ...possible,
      possible: false,
      reasons: [
        'In-place upgrades are off. Turn on "Let Pando upgrade itself" on the Policy screen.',
        "Pando's image is pinned to trypando/pando:0.3.1, an exact version.",
      ],
    });
    expect(html).toContain('Pando can&#x27;t upgrade itself from here');
    expect(html).toContain('pinned to trypando/pando:0.3.1');
    // And the command to upgrade it by hand.
    expect(html).toContain('docker compose up -d');
  });

  it('shows a rollback with why, and the new version’s last lines', () => {
    const html = render(possible, {
      id: 'upg_1',
      from: '0.3.1',
      to: '0.4.0',
      image: '',
      started_at: '2026-10-04T02:00:00Z',
      started_by: 'usr_admin',
      automatic: false,
      skip_backup: false,
      state: 'rolled_back',
      reason: '0.4.0 did not start, so Pando put 0.3.1 back.',
      logs: 'panic: migration 43',
      snapshot_gone: true,
      recorded: true,
    });
    expect(html).toContain('Rolled back: 0.4.0 did not start');
    expect(html).toContain('panic: migration 43');
  });
});

describe('the update settings (R-349, R-355, R-361)', () => {
  function Harness() {
    const draft = usePolicyDraft(true, true);
    return (
      <PolicyDraftContext.Provider value={draft}>
        <UpdateSettings />
      </PolicyDraftContext.Provider>
    );
  }
  function renderSettings(policy: object, fixed: object[] = []) {
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queries.setQueryData(['policy'], policy);
    queries.setQueryData(['config'], { file: '', settings: [], policy: fixed });
    return renderToString(
      <QueryClientProvider client={queries}>
        <Harness />
      </QueryClientProvider>,
    );
  }

  it('says how to turn it on in the deployment, and why the tag matters', () => {
    const html = renderSettings({});
    expect(html).toContain('Upgrade from here');
    expect(html).toContain('PANDO_POLICY_UPGRADE_IN_PLACE');
    expect(html).toContain('trypando/pando:latest');
    expect(html).toContain('A pinned version is put back');
  });

  it('says automatic upgrades take no full backup, and shows the window', () => {
    const html = renderSettings({ upgrade_in_place: true, auto_upgrade_patches: true, maintenance_window: 'sun 02:00 2h' });
    expect(html).toContain('No full backup is taken.');
    expect(html).toContain('Maintenance window, in UTC');
    expect(html).toContain('sun 02:00 2h');
    expect(html).not.toContain('PANDO_POLICY_UPGRADE_IN_PLACE');
  });

  it('reads the check as on unless policy turns it off', () => {
    const check = (html: string) => html.match(/<input[^>]*aria-label="Check for updates"[^>]*>/)?.[0] ?? '';
    expect(check(renderSettings({}))).toContain('checked=""');
    expect(check(renderSettings({ disable_update_check: true }))).not.toContain('checked=""');
  });
});
