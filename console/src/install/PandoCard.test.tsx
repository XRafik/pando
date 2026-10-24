// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Plan, Status } from '@api/types.gen';
import { answering, mount, type Mounted } from '../ui/testing';
import { PandoCard } from './Updates';

// The Pando card on Overview: release notes and update settings open in
// place, and Upgrade opens the in-place upgrade's confirmation (R-358).

const status: Status = {
  current: '0.4.0',
  development: false,
  enabled: true,
  channel: 'stable',
  checked_at: new Date().toISOString(),
  latest: '0.5.0',
  available: true,
  releases: [{ version: '0.5.0', prerelease: true, published_at: '2026-10-13T23:38:00Z', url: 'https://example.com/r', notes: '### Changed\n\n- Faster `pando deploy`.\n  Wrapped.\n\nA **plain** line.\n', security: true, breaking: true }],
  security: true,
  breaking: true,
  upgrade: { version: '0.5.0', image: 'trypando/pando:0.5.0', command: 'docker compose up -d', instructions: 'Pull it.' },
};
const plan: Plan = {
  current: '0.4.0',
  target: '0.5.0',
  possible: true,
  reasons: [],
  breaking: [{ version: '0.5.0', prerelease: false, published_at: '', url: '', notes: '- Renamed a field.', security: false, breaking: true }],
  note: 'Every app is unreachable while Pando restarts.',
};

let screen: Mounted | undefined;

afterEach(() => {
  screen?.unmount();
  screen = undefined;
  vi.unstubAllGlobals();
});

describe('the Pando card', () => {
  it('opens the release notes and the update settings in place', async () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<PandoCard settings={<p>The settings</p>} />, [
      [['me'], { verbs: ['install.view', 'install.upgrade'] }],
      [['updates'], status],
      [['upgrade-plan', '0.5.0'], plan],
      [['upgrade-last'], { upgrade: { id: 'u', from: '0.3.0', to: '0.4.0', state: 'running', started_at: '', started_by: '', automatic: false, skip_backup: false, image: '', snapshot_gone: false, recorded: true } }],
    ]);
    expect(screen.text()).toContain('Security fix');
    expect(screen.text()).toContain('Upgrading from 0.3.0 to 0.4.0');
    expect(screen.text()).not.toContain('Faster');
    await screen.press('Release notes');
    expect(screen.text()).toContain('Faster pando deploy. Wrapped.');
    expect(screen.text()).toContain('A plain line.');
    expect(screen.text()).toContain('Release candidate');
    await screen.press('Release notes');
    expect(screen.text()).not.toContain('Faster');

    expect(screen.text()).not.toContain('The settings');
    await screen.press('Update settings');
    expect(screen.text()).toContain('The settings');
  });

  it('asks before upgrading, with the version typed for a breaking one', async () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<PandoCard />, [
      [['me'], { verbs: ['install.view', 'install.upgrade'] }],
      [['updates'], status],
      [['upgrade-plan', '0.5.0'], plan],
      [['upgrade-last'], { upgrade: null }],
    ]);
    await screen.press('Upgrade to 0.5.0');
    expect(screen.text()).toContain('Upgrade Pando to 0.5.0');
    expect(screen.text()).toContain('0.5.0 has breaking changes');
    expect(screen.text()).toContain('Type 0.5.0 to upgrade anyway');
    await screen.press('Cancel');
    expect(screen.text()).not.toContain('Upgrade Pando to 0.5.0');
  });
});
