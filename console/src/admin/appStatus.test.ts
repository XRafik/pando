// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { partTitle } from './appStatus';

const db = { name: 'svc-01aa', service: { slot_key: 'DATABASE_URL', type: 'postgres' } };
const analytics = { name: 'svc-01bb', service: { slot_key: 'ANALYTICS_URL', type: 'postgres' } };
const cache = { name: 'svc-01cc', service: { slot_key: 'REDIS_URL', type: 'redis' } };
const web = { name: 'web' };

describe('what a workload is called', () => {
  it('is its own name, or what a service Pando runs is', () => {
    expect(partTitle(web, 'web', [web, db])).toBe('web');
    expect(partTitle(undefined, 'worker')).toBe('worker');
    expect(partTitle(db, db.name, [web, db])).toBe('PostgreSQL');
  });

  it('names the slot when two services are the same kind, so they can be told apart', () => {
    const all = [web, db, analytics, cache];
    expect(partTitle(db, db.name, all)).toBe('PostgreSQL (DATABASE_URL)');
    expect(partTitle(analytics, analytics.name, all)).toBe('PostgreSQL (ANALYTICS_URL)');
    expect(partTitle(cache, cache.name, all)).not.toContain('REDIS_URL');
  });
});
