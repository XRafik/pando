import { describe, expect, it } from 'vitest';

import { actorName, deploymentOf, fieldOf, nearEnd, outcomeOf, timeOf, type FeedItem } from './eventFeed';

const item = (id: string, occurred_at: string, type = 'app.restarted'): FeedItem => ({
  id,
  type,
  occurred_at,
  subject: id,
  actor: { kind: 'system' },
});

// R-378: an app's events, a line each.
describe('an event’s symbol', () => {
  it('is a success only for what finished well', () => {
    expect(outcomeOf('deploy.succeeded')).toBe('success');
    expect(outcomeOf('backup.created')).toBe('success');
    expect(outcomeOf('security.recovered')).toBe('success');
  });

  it('is a failure for what failed', () => {
    expect(outcomeOf('deploy.failed')).toBe('failure');
    expect(outcomeOf('backup.failed')).toBe('failure');
    expect(outcomeOf('security.scan_failed')).toBe('failure');
    expect(outcomeOf('adapter.unhealthy')).toBe('failure');
  });

  it('is nothing for everything else', () => {
    for (const t of ['app.restarted', 'deploy.started', 'grant.created', 'app.secret_written', 'security.scanned']) {
      expect(outcomeOf(t)).toBeNull();
    }
  });
});

describe('an event’s time', () => {
  const now = new Date(2026, 9, 24, 15, 0);

  it('carries its date, with no divider rows between days', () => {
    const date = new Date(2026, 9, 24, 14, 32).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(timeOf(new Date(2026, 9, 24, 14, 32).toISOString(), now)).toBe(`${date} 14:32`);
  });

  it('carries the year only when it is not this one', () => {
    expect(timeOf(new Date(2025, 11, 30, 9, 5).toISOString(), now)).toContain('2025');
    expect(timeOf(new Date(2026, 0, 2, 9, 5).toISOString(), now)).not.toContain('2026');
  });
});

describe('an event’s actor', () => {
  it('is Pando for the system, You for the signed-in person, a name when the feed gives one, and an ID otherwise', () => {
    expect(actorName({ kind: 'system' })).toBe('Pando');
    expect(actorName({ kind: 'user', id: 'usr_1' }, { id: 'usr_1' })).toBe('You');
    expect(actorName({ kind: 'user', id: 'usr_1' }, { id: 'ses_1', user_id: 'usr_1' })).toBe('You');
    expect(actorName({ kind: 'user', id: 'usr_2' }, { id: 'usr_1' }, 'Ada Lovelace')).toBe('Ada Lovelace');
    expect(actorName({ kind: 'token', id: 'tok_9', on_behalf_of: 'usr_2' }, { id: 'usr_1' }, 'Ada Lovelace')).toBe('Ada Lovelace');
    expect(actorName({ kind: 'token', id: 'tok_9' }, { id: 'usr_1' })).toBe('tok_9');
  });
});

describe('what an event opens', () => {
  it('names a deployment only for a deploy that carries one', () => {
    expect(deploymentOf({ ...item('a', ''), type: 'deploy.failed', data: { deployment_id: 'dep_1' } })).toBe('dep_1');
    expect(deploymentOf({ ...item('a', ''), type: 'deploy.started', data: { spec_revision: 3 } })).toBeUndefined();
    expect(deploymentOf({ ...item('a', ''), type: 'backup.failed', data: { deployment_id: 'dep_1' } })).toBeUndefined();
  });

  it('reads a field’s label and value', () => {
    expect(fieldOf({ label: 'Workload', value: 'web' })).toEqual({ label: 'Workload', value: 'web' });
    expect(fieldOf({})).toEqual({ label: '', value: '' });
  });
});

describe('paging as the box scrolls', () => {
  it('reads the next page near the end, and not before', () => {
    expect(nearEnd({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500 })).toBe(false);
    expect(nearEnd({ scrollTop: 1350, scrollHeight: 2000, clientHeight: 500 })).toBe(true);
    // Nothing to scroll is the end.
    expect(nearEnd({ scrollTop: 0, scrollHeight: 300, clientHeight: 500 })).toBe(true);
  });

});
