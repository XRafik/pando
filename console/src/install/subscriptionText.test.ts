import { describe, expect, it } from 'vitest';

import {
  NO_FILTERS,
  attemptLine,
  deliveryResult,
  destinationLabel,
  destinationOf,
  eventsSummary,
  filterSubscriptions,
  groupName,
  groupsOf,
  optionsOf,
  requestLine,
  scopeName,
  stateOf,
  subscriptionName,
  type Destination,
  type Subscription,
} from './subscriptionText';

const slack: Destination = { id: 'ntf_slack', kind: 'slack', audience: 'channel', channels: true };
const email: Destination = { id: 'ntf_smtp', kind: 'smtp', audience: 'people' };

const sub = (over: Partial<Subscription>): Subscription => ({
  id: 'sub_1',
  owner_id: 'usr_1',
  events: ['*'],
  destination: 'webhook',
  url: 'https://hooks.example.com/pando',
  description: '',
  enabled: true,
  consecutive_failures: 0,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
});

// R-364: a subscription's events, said in a few words rather than its raw list.
describe('eventsSummary', () => {
  it.each([
    [['*'], 'Everything'],
    [[], 'Nothing'],
    [['deploy.*'], 'Deployments'],
    [['deploy.*', 'security.*'], 'Deployments, security'],
    [['deploy.failed', 'backup.failed'], 'Deploy failed, backup failed'],
    [['app.disk_warning'], 'App disk warning'],
    [['deploy.*', 'security.*', 'app.failed', 'backup.failed'], 'Deployments, security, 2 more'],
    [['widget.*'], 'Widget'],
  ])('%j is %s', (events, said) => {
    expect(eventsSummary(events)).toBe(said);
  });
});

describe('a subscription in words', () => {
  it('is named by its description, or by what it sends', () => {
    expect(subscriptionName(sub({ description: 'SIEM' }))).toBe('SIEM');
    expect(subscriptionName(sub({ description: '  ', events: ['deploy.*'] }))).toBe('Deployments');
  });

  it('is about an app by name, or the installation', () => {
    expect(scopeName(sub({}))).toBe('Installation');
    expect(scopeName(sub({ app_id: 'app_1', app_name: 'crewmate' }))).toBe('crewmate');
    expect(scopeName(sub({ app_id: 'app_1' }))).toBe('app_1');
  });

  it('sends to a webhook by its address, or a channel by its kind', () => {
    expect(destinationOf(sub({}), [])).toEqual({ kind: 'Webhook', target: 'hooks.example.com/pando' });
    expect(destinationOf(sub({ destination: 'notify', adapter_id: 'ntf_slack', channel: 'C1' }), [slack])).toEqual({
      kind: 'Slack',
      target: 'C1',
    });
    expect(destinationOf(sub({ destination: 'notify', adapter_id: 'ntf_gone' }), [])).toEqual({ kind: 'ntf_gone' });
  });

  it('names each destination once, telling two of a kind apart', () => {
    expect(destinationLabel(email, [email])).toBe('Email');
    expect(destinationLabel({ ...slack, name: 'Ops' }, [slack])).toBe('Slack · Ops');
    const other = { ...slack, id: 'ntf_slack2' };
    expect(destinationLabel(slack, [slack, other])).toBe('Slack (ntf_slack)');
  });

  // R-370: off, failing, or on — one word each.
  it('is on, failing or off', () => {
    expect(stateOf(sub({}))).toBe('on');
    expect(stateOf(sub({ consecutive_failures: 2 }))).toBe('failing');
    expect(stateOf(sub({ enabled: false, consecutive_failures: 2 }))).toBe('off');
  });

  // R-375: how a webhook is sent, in a line.
  it('says how a webhook is sent', () => {
    expect(requestLine({})).toBe('POST · JSON');
    expect(requestLine({ method: 'PUT', content_type: 'text/plain', header_names: ['A'], payload_template: 'x' })).toBe(
      'PUT · text/plain · 1 header · Custom body',
    );
    expect(requestLine({ header_names: ['A', 'B'] })).toBe('POST · JSON · 2 headers');
  });

  it('groups the catalog by what its events are about', () => {
    const groups = groupsOf([
      { name: 'deploy.failed', scope: 'app', summary: '', fields: [] },
      { name: 'app.created', scope: 'app', summary: '', fields: [] },
      { name: 'deploy.started', scope: 'app', summary: '', fields: [] },
    ]);
    expect(groups.map(([p, defs]) => [p, defs.length])).toEqual([
      ['deploy', 2],
      ['app', 1],
    ]);
    expect(groupName('pando')).toBe('Upgrades');
  });
});

describe('the filter row', () => {
  const rows = [
    sub({ id: 'a', description: 'SIEM' }),
    sub({ id: 'b', app_id: 'app_1', app_name: 'crewmate', destination: 'notify', adapter_id: 'ntf_slack', events: ['deploy.*'] }),
    sub({ id: 'c', enabled: false, destination: 'notify', adapter_id: 'ntf_smtp' }),
  ];
  const ids = (f: Partial<typeof NO_FILTERS>) => filterSubscriptions(rows, { ...NO_FILTERS, ...f }, [slack, email]).map((s) => s.id);

  it('keeps everything with nothing chosen', () => {
    expect(ids({})).toEqual(['a', 'b', 'c']);
  });

  it('narrows by scope, destination, status and search, together', () => {
    expect(ids({ scope: ['install'] })).toEqual(['a', 'c']);
    expect(ids({ scope: ['app_1'] })).toEqual(['b']);
    expect(ids({ destination: ['Slack', 'Email'] })).toEqual(['b', 'c']);
    expect(ids({ status: ['off'] })).toEqual(['c']);
    expect(ids({ search: 'siem' })).toEqual(['a']);
    expect(ids({ search: 'deploy' })).toEqual(['b']);
    expect(ids({ search: 'crew', status: ['off'] })).toEqual([]);
  });

  it('offers the scopes and destinations present', () => {
    const o = optionsOf(rows, [slack, email]);
    expect(o.scope).toEqual([
      { value: 'install', label: 'Installation' },
      { value: 'app_1', label: 'crewmate' },
    ]);
    expect(o.destination.map((d) => d.value)).toEqual(['Webhook', 'Slack', 'Email']);
  });
});

// R-369: what became of a delivery, and each attempt, in a line.
describe('a delivery in words', () => {
  it.each([
    [{ status: 'pending' as const, attempts: 0 }, 'Sending'],
    [{ status: 'pending' as const, attempts: 2, last_status_code: 503 }, 'Retrying'],
    [{ status: 'failed' as const, attempts: 9, last_status_code: 503 }, '503'],
    [{ status: 'failed' as const, attempts: 9 }, 'Failed'],
    [{ status: 'succeeded' as const, attempts: 1, last_status_code: 200 }, '200'],
    [{ status: 'succeeded' as const, attempts: 1 }, 'Delivered'],
  ])('%j is %s', (d, said) => {
    expect(deliveryResult(d)).toBe(said);
  });

  it('says each attempt: number, time, answer, how long', () => {
    const line = attemptLine({ attempt: 2, attempted_at: '2026-10-24T14:31:02Z', status_code: 503, duration_ms: 1200 });
    expect(line).toMatch(/^2 · \d\d:31:02 · 503 · 1\.2 s$/);
    expect(attemptLine({ attempt: 1, attempted_at: '2026-10-24T14:31:02Z', duration_ms: 300 })).toMatch(/· No answer · 300 ms$/);
  });
});
