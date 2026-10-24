// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { answering, mount, reply, unanswered, type Mounted, type Seed } from '../ui/testing';
import { Installation, settingsOf, stateOf, worstOf } from './Installation';
import type { AdapterKind } from './adapters';

// Adapters as a list and a detail: each category with its worst status, the
// chosen one's adapters as cards with their settings, and what can be done
// to each — Edit, View, Make default.

const docker: AdapterKind = {
  category: 'runtime',
  kind: 'docker',
  name: 'Docker',
  description: '',
  id_prefix: 'rt_',
  fields: [
    { key: 'socket', label: 'Socket', type: 'string' },
    { key: 'token', label: 'Token', type: 'string', credential: true },
  ],
};
const s3: AdapterKind = { category: 'backup', kind: 's3', name: 'Amazon S3', description: '', id_prefix: 'bak_', fields: [] };

const local = { id: 'rt_local', category: 'runtime', kind: 'docker', name: 'Local Docker', is_default: true, healthy: true, config: { socket: 'unix:///run/docker.sock' } };
const gpu = { id: 'rt_gpu', category: 'runtime', kind: 'docker', name: 'GPU host', is_default: false, healthy: true, enabled: true, config: { socket: 'ssh://gpu' } };
const backups = { id: 'bak_s3', category: 'backup', kind: 's3', name: 'S3 backups', healthy: false, declared: true, source: { kind: 'file', name: 'pando.yaml', key: 'adapters[2]' } };

const seed = (adapters: object[], extra: Partial<{ restart_needed: boolean }> = {}): Seed => [
  [['me'], { verbs: ['install.view', 'install.adapters.manage'] }],
  [['adapters'], { adapters, ...extra }],
  [['adapter-kinds'], { kinds: [docker, s3] }],
  [['sources'], { sources: [] }],
  [['notify'], { adapters: [] }],
];

let screen: Mounted | undefined;

afterEach(() => {
  screen?.unmount();
  screen = undefined;
  vi.unstubAllGlobals();
});

describe('the categories', () => {
  it('each show their worst status and, holding several, how many', () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<Installation />, seed([local, gpu, backups]));
    const cats = [...document.querySelectorAll('nav[aria-label="Adapter categories"] a')].map((a) => a.getAttribute('aria-label'));
    expect(cats).toContain('Runtime: Working');
    expect(cats).toContain('Backup: Unreachable');
    const runtime = document.querySelector('nav[aria-label="Adapter categories"] a[aria-current="true"]');
    expect(runtime?.textContent).toContain('Runtime');
    expect(runtime?.textContent).toContain('2');
  });

  it('open the one picked', async () => {
    vi.stubGlobal('fetch', answering({}));
    const onCategory = vi.fn();
    screen = mount(<Installation onCategory={onCategory} />, seed([local, gpu, backups]));
    await screen.click('Backup');
    expect(onCategory).toHaveBeenCalledWith('backup');
    expect(screen.text()).toContain('S3 backups');
  });
});

describe('an adapter’s card', () => {
  it('shows its settings but never a credential, and tags the default when there are several', () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<Installation category="runtime" />, seed([local, gpu]));
    const text = screen.text();
    expect(text).toContain('unix:///run/docker.sock');
    expect(text).toContain('Default');
    expect(text).toContain('Make default');
    expect(text).not.toContain('Token');
  });

  it('makes another the default, naming the one it replaces, keeping its settings', async () => {
    const posted: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return reply({ id: 'rt_gpu' });
      }
      return unanswered();
    });
    screen = mount(<Installation category="runtime" />, seed([local, gpu]));
    await screen.press('Make default');
    expect(screen.text()).toContain('Make GPU host the default?');
    expect(screen.text()).toContain('in place of Local Docker');
    await screen.press('Make default');
    expect(posted).toEqual([
      { id: 'rt_gpu', category: 'runtime', kind: 'docker', name: 'GPU host', config: { socket: 'ssh://gpu' }, is_default: true, enabled: true },
    ]);
    expect(screen.text()).toContain('GPU host is saved. Restart Pando to apply it.');
  });

  it('is viewed, not edited, when the config file declares it', async () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<Installation category="backup" />, seed([backups]));
    expect(screen.text()).toContain('Config file');
    expect([...document.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Edit');
    await screen.press('View');
    expect(screen.text()).toContain('Set in pando.yaml, at adapters[2]. Change it there, then restart Pando.');
  });

  it('asks for a restart, with the button beside it', () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<Installation category="runtime" />, seed([local], { restart_needed: true }));
    expect(screen.text()).toContain('Adapter changes are saved. Restart Pando to apply them.');
    expect([...document.querySelectorAll('button')].filter((b) => b.textContent === 'Restart Pando')).toHaveLength(2);
  });
});

describe('at phone width', () => {
  const phone = () =>
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }));

  it('lists the categories with their adapters and problem, and a category opens on its own', async () => {
    phone();
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<Installation />, seed([local, gpu, backups]));
    expect(screen.text()).toContain('Local Docker, GPU host');
    expect(screen.text()).toContain('S3 backups · Unreachable');
    expect(screen.text()).not.toContain('unix:///run/docker.sock');
    screen.unmount();

    const onCategory = vi.fn();
    screen = mount(<Installation category="runtime" onCategory={onCategory} />, seed([local, gpu, backups]));
    expect(screen.text()).toContain('unix:///run/docker.sock');
    expect(document.querySelector('nav[aria-label="Adapter categories"]')).toBeNull();
    const back = [...document.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'Adapters');
    await screen.settle(() => back!.click());
    expect(onCategory).toHaveBeenCalledWith(undefined);
  });
});

describe('an adapter’s state', () => {
  it('reads as a symbol and a word, and a category as its worst', () => {
    expect(stateOf({ status: 'overridden' }).label).toBe('Replaced by config file');
    expect(stateOf({ pending_restart: true }).status).toBe('info');
    expect(stateOf({ healthy: true, edge: { running: false, message: 'port taken' } })).toEqual({ status: 'failed', label: 'Not running', title: 'port taken' });
    expect(stateOf({ healthy: false }).label).toBe('Unreachable');
    expect(stateOf({ healthy: true }).label).toBe('Working');
    const source = (caps: object, problem?: string) => ({ id: 's', name: 's', kind: 'github', capabilities: caps, problem }) as never;
    expect(stateOf({ connection: source({ authorized: false }) }).label).toBe('Not authorized');
    expect(stateOf({ connection: source({}, 'Its key is gone') }).label).toBe('Cannot be used');
    const notify = (caps: object, problem?: string) => ({ id: 'n', name: 'n', kind: 'slack', capabilities: caps, problem }) as never;
    expect(stateOf({ notify: notify({}, 'No token') }).label).toBe('Cannot be used');
    expect(stateOf({ notify: notify({ authorized: true }) }).label).toBe('Ready');

    expect(worstOf([])).toBeUndefined();
    expect(worstOf([{ status: 'running', label: 'Working' }, { status: 'failed', label: 'Unreachable' }, { status: 'info', label: 'Restart to apply' }])?.label).toBe(
      'Unreachable',
    );
  });

  it('summarizes its settings without a credential or an empty value', () => {
    expect(settingsOf({ id: 'rt_1', config: { socket: 's', token: 'x', tls: true, port: '' }, fields: [
      ...(docker.fields ?? []),
      { key: 'tls', label: 'TLS', type: 'bool' },
      { key: 'port', label: 'Port', type: 'int' },
    ] })).toEqual([
      ['ID', 'rt_1'],
      ['Socket', 's'],
      ['TLS', 'On'],
    ]);
  });
});
