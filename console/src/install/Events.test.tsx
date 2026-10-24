// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';

import { Events } from './Events';
import { mount, reply, unanswered, type Seed } from '../ui/testing';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const tick = () => act(async () => new Promise((r) => setTimeout(r, 30)));

const siem = {
  id: 'sub_1',
  owner_id: 'usr_me',
  owner_name: 'Ben Meeker',
  events: ['*'],
  destination: 'webhook',
  url: 'https://hooks.example.com/pando',
  description: 'SIEM',
  enabled: true,
  consecutive_failures: 3,
  last_delivery_at: '2026-10-24T14:30:00Z',
  created_at: '2026-10-01T00:00:00Z',
  method: 'POST',
  content_type: 'application/json',
};
const deploys = {
  ...siem,
  id: 'sub_2',
  app_id: 'app_1',
  app_name: 'crewmate',
  events: ['deploy.*'],
  destination: 'notify',
  url: undefined,
  adapter_id: 'ntf_slack',
  channel: 'C1',
  description: '',
  consecutive_failures: 0,
  last_delivery_at: undefined,
};
const quiet = { ...deploys, id: 'sub_3', app_id: undefined, app_name: undefined, adapter_id: 'ntf_smtp', channel: undefined, enabled: false, events: ['security.*'] };

const catalog = {
  events: [
    { name: 'deploy.failed', scope: 'app', summary: 'A deploy failed.', fields: [] },
    { name: 'deploy.succeeded', scope: 'app', summary: 'A deploy finished.', fields: [] },
    { name: 'policy.updated', scope: 'install', summary: 'Host policy changed.', fields: [] },
  ],
  destinations: [
    { id: 'ntf_slack', kind: 'slack', audience: 'channel', channels: true },
    { id: 'ntf_smtp', kind: 'smtp', audience: 'people' },
  ],
};

const seed = (subscriptions: unknown[] = [siem, deploys, quiet]): Seed => [
  [['subscriptions', '', {}], { pages: [{ subscriptions }], pageParams: [''] }],
  [['events'], catalog],
];

/** A fetch that records each request and answers by method and path. */
function serve(answer: (method: string, path: string, body?: unknown) => unknown) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://pando.test').pathname.replace('/api/v1', '');
    const search = new URL(String(url), 'http://pando.test').search;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: path + search, body });
    const got = answer(method, path, body);
    return got === undefined ? unanswered() : reply(got);
  });
  return calls;
}

/** What the topmost dialog says. */
const dialogText = () => [...document.querySelectorAll('[role="dialog"]')].at(-1)?.textContent ?? '';

/** Ticks the box labeled `label` in the open filter `filter`. */
const pick = (s: ReturnType<typeof mount>, filter: string, label: string) =>
  s.settle(() => {
    const group = document.querySelector(`[role="group"][aria-label="${filter}"]`)!;
    [...group.querySelectorAll('label')].find((l) => l.textContent === label)!.click();
  });

const button = (label: string) =>
  [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label).at(-1);

// R-367, R-370: the subscriptions, a row each, narrowed by one filter row.
describe('the subscriptions table', () => {
  it('says each one’s name, scope, events, destination, status and last delivery', () => {
    serve(() => undefined);
    const s = mount(<Events canManageAll={false} apps={[]} />, seed());
    const text = s.text();
    expect(text).toContain('SIEM');
    expect(text).toContain('Installation');
    expect(text).toContain('Everything');
    expect(text).toContain('hooks.example.com/pando');
    expect(text).toContain('Failing');
    expect(text).toMatch(/Oct 2[45] \d\d:30/);
    expect(text).toContain('Deployments');
    expect(text).toContain('crewmate');
    expect(text).toContain('Slack');
    expect(text).toContain('Never');
    expect(text).toContain('Off');
    expect(text).not.toContain('Send Pando events');
    s.unmount();
  });

  it('narrows by search and by status', async () => {
    serve(() => undefined);
    const s = mount(<Events canManageAll={false} apps={[]} />, seed());
    await s.type('Search subscriptions', 'siem');
    expect(s.text()).toContain('SIEM');
    expect(s.text()).not.toContain('crewmate');
    await s.type('Search subscriptions', 'nothing like it');
    expect(s.text()).toContain('No subscriptions match.');
    await s.type('Search subscriptions', '');

    await s.press('Status');
    await pick(s, 'Status', 'Off');
    expect(button('Status · 1')).toBeDefined();
    expect(s.text()).not.toContain('SIEM');
    expect(s.text()).toContain('Security');

    await s.press('Scope');
    await pick(s, 'Scope', 'crewmate');
    expect(s.text()).toContain('No subscriptions match.');
    s.unmount();
  });

  // R-368: everybody's, for somebody who manages them all.
  it('shows everybody’s when asked, in place of a checkbox', async () => {
    const calls = serve((_, path) => (path === '/subscriptions' ? { subscriptions: [] } : undefined));
    const s = mount(<Events canManageAll apps={[]} />, seed());
    expect(s.text()).not.toContain('Show everybody');
    await s.toggle('Whose: Mine');
    await pick(s, 'Whose', 'Everyone');
    await tick();
    expect(calls.some((c) => c.method === 'GET' && c.path.startsWith('/subscriptions?') && c.path.includes('everyone=true'))).toBe(true);
    expect(document.querySelector('[aria-label="Whose: Everyone"]')).not.toBeNull();
    s.unmount();
  });

  it('is a row each on a phone, opening the subscription', async () => {
    window.matchMedia = ((q: string) => ({
      matches: q.includes('max-width'),
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as never;
    const calls = serve((_, path) => (path === '/subscriptions/sub_2' ? deploys : undefined));
    const s = mount(<Events canManageAll={false} apps={[]} />, seed());
    expect(s.text()).toContain('crewmate · Slack');
    expect(s.text()).toContain('Installation · Email');
    expect(s.text()).not.toContain('Last delivery');
    await s.settle(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Deployments'))!.click());
    expect(calls.some((c) => c.path === '/subscriptions/sub_2')).toBe(true);
    s.unmount();
    window.matchMedia = undefined as never;
  });

  it('says there are none', () => {
    serve(() => undefined);
    const s = mount(<Events canManageAll={false} apps={[]} />, seed([]));
    expect(s.text()).toContain('No subscriptions yet');
    s.unmount();
  });
});

// R-369, R-371: a subscription in the side panel, and its deliveries.
describe('the subscription panel', () => {
  const delivery = {
    id: 'dlv_1',
    event_id: 'evt_1',
    event: 'deploy.failed',
    status: 'failed',
    attempts: 2,
    last_status_code: 503,
    created_at: '2026-10-24T14:30:00Z',
  };
  const detail = {
    ...delivery,
    attempt_log: [
      { attempt: 1, attempted_at: '2026-10-24T14:30:02Z', status_code: 503, duration_ms: 1200 },
      { attempt: 2, attempted_at: '2026-10-24T14:31:02Z', error: 'Timed out.', duration_ms: 10000 },
    ],
    payload: { type: 'deploy.failed' },
  };
  const answer = (method: string, path: string) => {
    if (path === '/subscriptions/sub_1' && method === 'GET') return siem;
    if (path === '/subscriptions/sub_1' && method === 'PATCH') return siem;
    if (path === '/subscriptions/sub_1' && method === 'DELETE') return {};
    if (path === '/subscriptions/sub_1/deliveries') return { deliveries: [delivery] };
    if (path === '/subscriptions/sub_1/deliveries/dlv_1') return detail;
    if (path.endsWith('/redeliver')) return { ...delivery, status: 'pending' };
    if (path.endsWith('/test')) return { id: 'dlv_2', status: 'pending' };
    if (path.endsWith('/signing-key')) return { ...siem, signing_key: 'whsec_new' };
    if (path === '/subscriptions') return { subscriptions: [siem] };
    return undefined;
  };

  it('opens from a row with its details and deliveries, each opening to its attempts', async () => {
    const calls = serve(answer);
    const s = mount(<Events canManageAll={false} apps={[]} />, seed());
    await s.click('SIEM');
    await tick();
    const text = s.text();
    expect(text).toContain('POST · JSON');
    expect(text).toContain('Ben Meeker');
    expect(text).toContain('https://hooks.example.com/pando');
    expect(text).toContain('deploy.failed');
    expect(text).toContain('503');

    await s.click('deploy.failed');
    await tick();
    expect(s.text()).toMatch(/1 · \d\d:30:02 · 503 · 1\.2 s/);
    expect(s.text()).toContain('No answer · 10.0 s · Timed out.');

    await s.press('Payload');
    expect(s.text()).toContain('"type": "deploy.failed"');
    await s.press('Redeliver');
    await tick();
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/dlv_1/redeliver'))).toBe(true);

    await s.press('Send test');
    expect(calls.some((c) => c.method === 'POST' && c.path === '/subscriptions/sub_1/test')).toBe(true);
    expect(s.text()).toContain('Test sent.');

    await s.press('Turn off');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: false });

    await s.press('Rotate');
    await tick();
    expect(s.text()).toContain('whsec_new');
    await s.press('I’ve saved it');
    s.unmount();
  });

  it('deletes after asking', async () => {
    const calls = serve(answer);
    const s = mount(<Events canManageAll={false} apps={[]} />, seed());
    await s.click('SIEM');
    await tick();
    await s.press('Delete');
    expect(s.text()).toContain('Delete this subscription?');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await s.press('Delete');
    await tick();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/subscriptions/sub_1')).toBe(true);
    expect(s.text()).not.toContain('Recent deliveries');
    s.unmount();
  });

  it('edits its name, events and address in the same dialog that makes one', async () => {
    const calls = serve(answer);
    const s = mount(<Events canManageAll={false} apps={[]} />, seed());
    await s.click('SIEM');
    await tick();
    await s.press('Edit');
    expect(dialogText()).toContain('Edit subscription');
    expect(dialogText()).not.toContain('Scope');
    await s.fill('Name', 'Audit');
    await s.press('Choose');
    await s.click('deploy.failed');
    await s.fill('URL', 'https://siem.example.com/in');
    await s.press('Save');
    await tick();
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({
      description: 'Audit',
      events: ['deploy.failed'],
      url: 'https://siem.example.com/in',
      method: 'POST',
      content_type: 'application/json',
      payload_template: '',
    });
    s.unmount();
  });

  it('moves a channel subscription to another channel adapter', async () => {
    const calls = serve((method, path) => {
      if (path === '/subscriptions/sub_2') return deploys;
      if (path === '/subscriptions/sub_2/deliveries') return { deliveries: [] };
      if (path === '/subscriptions') return { subscriptions: [] };
      return method === 'GET' ? undefined : deploys;
    });
    const s = mount(<Events canManageAll={false} apps={[]} />, seed());
    await s.click('Deployments');
    await tick();
    expect(s.text()).toContain('No deliveries yet.');
    await s.press('Edit');
    expect(dialogText()).not.toContain('Webhook');
    await s.fill('Send to', 'notify:ntf_smtp');
    await s.press('Save');
    await tick();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      description: '',
      events: ['deploy.*'],
      adapter_id: 'ntf_smtp',
      channel: '',
    });
    s.unmount();
  });
});

// R-364, R-371: one dialog makes one, and a webhook's key is shown once.
describe('a new subscription', () => {
  it('sends what was chosen, then shows the signing key', async () => {
    const calls = serve((method, path) =>
      method === 'POST' && path === '/subscriptions' ? { ...siem, id: 'sub_9', signing_key: 'whsec_once' } : undefined,
    );
    const s = mount(<Events canManageAll apps={[]} />, seed([]));
    await s.press('New subscription');
    expect(button('Create')?.disabled).toBe(true);
    await s.fill('Name', 'Deploys');
    await s.press('Choose');
    expect(s.text()).toContain('Policy');
    expect(s.text()).not.toContain('A deploy failed.');
    await s.click('Deployments');
    expect(s.text()).not.toContain('deploy.succeeded');
    await s.fill('URL', 'https://example.com/hook');
    await s.press('Create');
    await tick();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      description: 'Deploys',
      events: ['deploy.*'],
      url: 'https://example.com/hook',
      method: 'POST',
      content_type: 'application/json',
      payload_template: '',
      headers: {},
      destination: 'webhook',
    });
    expect(s.text()).toContain('Save the signing key');
    expect(s.text()).toContain('whsec_once');
    s.unmount();
  });

  it('offers only app events for an app, and sends to a channel adapter', async () => {
    const app = { id: 'app_1', name: 'crewmate' } as never;
    const calls = serve((method, path) => (method === 'POST' && path === '/subscriptions' ? deploys : undefined));
    const s = mount(<Events canManageAll={false} apps={[app]} />, seed([]));
    await s.press('New subscription');
    expect(s.text()).not.toContain('Installation');
    await s.press('Choose');
    expect(s.text()).not.toContain('Policy');
    await s.click('deploy.failed');
    await s.fill('Send to', 'notify:ntf_smtp');
    await s.press('Create');
    await tick();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      description: '',
      events: ['deploy.failed'],
      adapter_id: 'ntf_smtp',
      app_id: 'app_1',
      destination: 'notify',
    });
    expect(s.text()).not.toContain('Save the signing key');
    s.unmount();
  });
});
