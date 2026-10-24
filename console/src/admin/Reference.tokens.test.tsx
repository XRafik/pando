// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount, reply, unanswered, type Seed } from '../ui/testing';
import { Reference } from './Reference';

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

const tokens = [
  { id: 'tok_1', name: 'laptop CLI', expires_at: '2099-01-22T12:00:00Z', last_used_at: '2020-10-24T12:02:00Z' },
  { id: 'tok_2', name: 'Claude Code' },
];

const seed = (verbs: string[] = []): Seed => [
  [['me'], { principal_kind: 'user', id: 'usr_1', verbs }],
  [['tokens'], { tokens }],
  [['tokens', 'service'], { tokens: [{ id: 'tok_3', name: 'ci-bot' }] }],
  [['ai-functions'], { functions: [] }],
];

// R-058, R-060, R-062: your tokens and service tokens, each with when it
// expires and when it was last used.
describe('tokens', () => {
  it('are two cards, service tokens for those who manage them', () => {
    width(false);
    vi.stubGlobal('fetch', unanswered);
    const s = mount(<Reference />, seed(['install.tokens.manage']));
    expect(s.text()).toContain('Your tokens');
    expect(s.text()).toContain('Service tokens');
    expect(s.text()).toContain('ci-bot');
    expect(s.text()).toMatch(/Jan 2[123], 2099/);
    s.unmount();

    const t = mount(<Reference />, seed());
    expect(t.text()).not.toContain('Service tokens');
    t.unmount();
  });

  it('are rows on a phone, their dates under their names', () => {
    width(true);
    vi.stubGlobal('fetch', unanswered);
    const s = mount(<Reference />, seed());
    expect(s.text()).toMatch(/laptop CLIExpires Jan 2[123], 2099 · used Oct 2[345], 2020 \d\d:\d\d/);
    expect(s.text()).toContain('Claude CodeNever expires · never used');
    s.unmount();
  });

  it('revokes one', async () => {
    width(false);
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : unanswered();
    });
    const s = mount(<Reference />, seed());
    await s.press('Revoke');
    expect(calls.some((c) => c.startsWith('DELETE') && c.endsWith('/tokens/tok_2'))).toBe(true);
    s.unmount();
  });

  it('makes a service token, saying what it holds, and shows its secret once', async () => {
    width(false);
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? reply({ secret: 'pando_secret' }) : unanswered(),
    );
    const s = mount(<Reference />, seed(['install.tokens.manage']));
    await s.press('New token');
    expect(s.text()).toContain('New service token');
    expect(s.text()).toContain('Holds nothing until an app is shared with it.');
    await s.fill('Name', 'ci-bot-2');
    await s.press('Create');
    expect(s.text()).toContain('pando_secret');
    s.unmount();
  });
});
