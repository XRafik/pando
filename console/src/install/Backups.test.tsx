// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackupAttempt } from '@api/types.gen';
import { answering, mount, type Mounted, type Seed } from '../ui/testing';
import { Backups, dailySummary } from './Backups';
import { Overview } from './Overview';
import { stamp } from './stamp';

// Neither list on Backups is drawn in full: the daily app backups are a line
// and the failures, the whole installation's backups the newest three.

const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 2, 15).toISOString();
const attempt = (app: string, outcome: string, message?: string): BackupAttempt => ({
  app_id: `app_${app}`,
  app_name: app,
  attempted_at: today,
  outcome,
  message,
});
const bundle = (n: number) => ({
  id: `bak_${n}`,
  kind: 'dr_bundle',
  adapter_ref: 'bak_s3',
  size_bytes: 2_400_000_000,
  created_at: new Date(Date.UTC(2026, 9, 24 - n, 3)).toISOString(),
});

const seed = (attempts: BackupAttempt[], backups: object[]): Seed => [
  [['backups', '', {}], { pages: [{ backups, attempts }], pageParams: [''] }],
];

let screen: Mounted | undefined;

afterEach(() => {
  screen?.unmount();
  screen = undefined;
  vi.unstubAllGlobals();
});

describe('daily app backups (R-211)', () => {
  it('counts the apps backed up today', () => {
    expect(dailySummary([attempt('a', 'taken'), attempt('b', 'failed')], now)).toBe('1 of 2 apps backed up today');
    expect(dailySummary([attempt('a', 'taken')], now)).toBe('1 of 1 app backed up today');
    expect(dailySummary([{ ...attempt('a', 'taken'), attempted_at: '2020-01-01T00:00:00Z' }], now)).toBe('0 of 1 app backed up today');
  });

  it('lists only the failures, and every app when asked', async () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<Backups />, seed([attempt('crewmate', 'taken'), attempt('invoice-tool', 'failed', 'S3 backups is unreachable.')], [bundle(0)]));
    expect(screen.text()).toContain('1 of 2 apps backed up today');
    expect(screen.text()).toContain('invoice-tool');
    expect(screen.text()).toContain('S3 backups is unreachable.');
    expect(screen.text()).not.toContain('crewmate');
    await screen.press('Show all 2 apps');
    expect(screen.text()).toContain('crewmate');
  });
});

describe('the whole installation’s backups (R-213, R-216)', () => {
  it('shows the newest three, and older ones a click away', async () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<Backups />, seed([], [bundle(0), bundle(1), bundle(2), bundle(3), { ...bundle(9), kind: 'rolling', id: 'bak_app' }]));
    expect(screen.text()).toContain('3 newest of 4');
    const fourth = stamp(bundle(3).created_at);
    expect(screen.text()).not.toContain(fourth);
    await screen.press('Show older backups');
    expect(screen.text()).toContain(fourth);
    // An app's own rolling backup is not the whole installation's.
    expect(screen.text()).not.toContain(stamp(bundle(9).created_at));
    await screen.press('Restore');
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it('says when there are none', () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<Backups />, seed([], []));
    expect(screen.text()).toContain('No backups yet');
  });
});

describe('the startup settings on Overview (R-271)', () => {
  it('say how many are set, and show the table only when asked', async () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<Overview />, [
      [['me'], { verbs: ['install.view'] }],
      [['updates'], { current: '0.4.0', development: false, enabled: false, channel: 'stable', available: false, releases: [], security: false, breaking: false }],
      [['upgrade-last'], { upgrade: null }],
      [['capacity'], { runtimes: [] }],
      [['adapters'], { adapters: [] }],
      [['adapter-kinds'], { kinds: [] }],
      [
        ['config'],
        {
          file: '/etc/pando.yaml',
          policy: [],
          settings: [
            { key: 'log.level', value: 'info', source: { kind: 'default' }, env: 'PANDO_LOG_LEVEL' },
            { key: 'database.url', value: '[redacted]', source: { kind: 'env', name: 'PANDO_DATABASE_URL' }, env: 'PANDO_DATABASE_URL' },
          ],
        },
      ],
    ]);
    expect(screen.text()).toContain('Read once when Pando starts. 1 of 2 are set; the rest are defaults.');
    expect(screen.text()).not.toContain('log.level');
    await screen.press('Show');
    expect(screen.text()).toContain('log.level');
    expect(screen.text()).toContain('[redacted]');
    expect(screen.text()).toContain('/etc/pando.yaml');
    await screen.press('Hide');
    expect(screen.text()).not.toContain('log.level');
  });
});
