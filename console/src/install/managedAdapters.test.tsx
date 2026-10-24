// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { answering, mount, type Mounted, type Seed } from '../ui/testing';
import { Installation } from './Installation';
import { addableKinds, isManaged, type AdapterKind } from './adapters';

// A kind Pando sets up itself, such as its BuildKit, is listed with its status
// and is neither added nor edited from the console. Which kinds those are is
// the server's to say (`managed`), not a name this file knows.

const buildkit: AdapterKind = {
  category: 'builder',
  kind: 'buildkit',
  name: 'BuildKit',
  description: 'Builds images from source in a rootless BuildKit that Pando runs itself.',
  id_prefix: 'bld_',
  managed: true,
  fields: [{ key: 'cache_max_bytes', label: 'Build service cache', type: 'int', advanced: true, default: '10737418240 (10 GiB)' }],
};
const loopback: AdapterKind = {
  category: 'routing',
  kind: 'loopback',
  name: 'Localhost',
  description: 'Reaches apps on this machine.',
  id_prefix: 'rte_',
  fields: null,
};

const seed = (adapters: object[]): Seed => [
  [['me'], { verbs: ['install.adapters.manage'] }],
  [['adapters'], { adapters }],
  [['adapter-kinds'], { kinds: [buildkit, loopback] }],
  [['sources'], { sources: [] }],
];
const builderRow = { id: 'bld_buildkit', category: 'builder', kind: 'buildkit', name: 'BuildKit', is_default: true, healthy: false };
const routingRow = { id: 'rte_loopback', category: 'routing', kind: 'loopback', name: 'Localhost', is_default: true, healthy: true };

let screen: Mounted | undefined;

afterEach(() => {
  screen?.unmount();
  screen = undefined;
  vi.unstubAllGlobals();
});

/** The buttons on the adapter card whose ID reads `id`. */
function rowButtons(id: string): string[] {
  const cell = [...document.querySelectorAll('dd')].find((el) => el.textContent === id);
  const card = cell?.closest('dl')?.parentElement;
  expect(card, `a card for ${id}`).toBeTruthy();
  return [...card!.querySelectorAll('button')].map((b) => String(b.textContent));
}

describe('a kind Pando sets up itself', () => {
  it('is told apart by the server’s marker, not by its name', () => {
    expect(addableKinds([buildkit, loopback])).toEqual([loopback]);
    expect(isManaged([buildkit, loopback], builderRow)).toBe(true);
    expect(isManaged([buildkit, loopback], routingRow)).toBe(false);
    expect(isManaged([{ ...buildkit, managed: false }], builderRow)).toBe(false);
  });

  it('is listed with its status and offers no Edit, while other rows do', () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<Installation category="builder" />, seed([builderRow, routingRow]));
    expect(screen.text()).toContain('BuildKit');
    expect(screen.text()).toContain('bld_buildkit');
    expect(rowButtons('bld_buildkit')).not.toContain('Edit');
    screen.unmount();
    screen = mount(<Installation category="routing" />, seed([builderRow, routingRow]));
    expect(rowButtons('rte_loopback')).toContain('Edit');
  });

  it('is not offered in Add adapter', async () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<Installation category="builder" />, seed([routingRow]));
    // A category whose only kind is managed offers nothing to add.
    expect(screen.text()).not.toContain('Add builder');
    screen.unmount();
    screen = mount(<Installation category="routing" />, seed([routingRow]));
    await screen.press('Add another');
    const dialog = String(document.querySelector('[role="dialog"]')?.textContent);
    expect(dialog).toContain('Add Localhost');
    expect(dialog).not.toContain('BuildKit');
  });
});
