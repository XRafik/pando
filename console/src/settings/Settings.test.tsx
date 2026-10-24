// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount, reply, unanswered, type Seed } from '../ui/testing';
import { Settings } from './Settings';
import { initials } from './parts';

/** The window is a phone's width, or not. */
function width(narrow: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: q.includes('max-width') ? narrow : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const prefs = {
  kinds: [
    { kind: 'approval', label: 'Deployments waiting for my approval', description: '', default_on: true },
    { kind: 'failed', label: 'My apps failing', description: '', default_on: true },
  ],
  channels: [
    { id: 'console', kind: 'console' },
    { id: 'ntf_smtp', kind: 'smtp' },
  ],
  choices: [
    { kind: 'approval', channel: 'console', enabled: true },
    { kind: 'approval', channel: 'ntf_smtp', enabled: false },
  ],
};

const seed = (): Seed => [
  [['me'], { principal_kind: 'user', id: 'usr_1', display_name: 'Ben Meeker', email: 'ben@example.com' }],
  [['notification-preferences'], prefs],
];

describe('initials', () => {
  it.each([
    ['Ben Meeker', 'BM'],
    ['dana', 'D'],
    ['ada.lovelace@example.com', 'AL'],
    ['  ', ''],
  ])('%s is %s', (name, said) => {
    expect(initials(name)).toBe(said);
  });
});

describe('your settings', () => {
  it('shows the account, appearance and notifications as cards', () => {
    width(false);
    vi.stubGlobal('fetch', unanswered);
    const s = mount(<Settings onBack={() => {}} />, seed());
    const text = s.text();
    expect(text).toContain('BM');
    expect(text).toContain('Ben Meeker');
    expect(text).toContain('ben@example.com');
    expect(text).toContain('Sign out');
    expect(text).toContain('This browser only.');
    expect(text).toContain('Notify me about');
    expect(text).toContain('My apps failing');
    expect(text).not.toContain('add a subscription under Events');
    s.unmount();
  });

  it('chooses the theme from three', async () => {
    width(false);
    vi.stubGlobal('fetch', unanswered);
    const s = mount(<Settings onBack={() => {}} />, seed());
    await s.press('Dark');
    expect(document.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await s.press('System');
    expect(document.querySelector('button[aria-pressed="true"]')?.textContent).toBe('System');
    s.unmount();
  });

  // R-373: one box per kind and channel; ticking one sends that choice alone.
  it('turns one kind on for one channel', async () => {
    width(false);
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        sent.push(JSON.parse(String(init.body)));
        return reply(prefs);
      }
      return unanswered();
    });
    const s = mount(<Settings onBack={() => {}} />, seed());
    const box = document.querySelector<HTMLInputElement>('input[aria-label="My apps failing: Email"]')!;
    expect(box.checked).toBe(false);
    await s.settle(() => box.click());
    expect(sent).toEqual([{ choices: [{ kind: 'failed', channel: 'ntf_smtp', enabled: true }] }]);
    s.unmount();
  });

  it('puts each kind’s boxes under its label on a phone, named for their channel', () => {
    width(true);
    vi.stubGlobal('fetch', unanswered);
    const s = mount(<Settings onBack={() => {}} />, seed());
    expect(s.text()).not.toContain('Notify me about');
    expect(s.text()).toContain('My apps failingConsoleEmail');
    s.unmount();
  });

  it('says why the preferences could not be read', async () => {
    width(false);
    vi.stubGlobal('fetch', async () => reply({ code: 'INTERNAL', message: 'Pando could not read them.' }, 500));
    const s = mount(<Settings onBack={() => {}} />, seed().slice(0, 1));
    await s.settle(() => {});
    await s.settle(() => {});
    expect(s.text()).toContain('Pando could not read them.');
    s.unmount();
  });
});
