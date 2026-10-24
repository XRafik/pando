// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount, reply, unanswered, type Mounted } from '../ui/testing';
import { Audit } from './AuditLog';
import type { AuditRecord } from './AuditLog';
import { NO_FILTERS, auditQuery, filtersFrom, linkQuery } from './audit';
import { fullStamp, isToday, stamp } from './stamp';

// The audit log (R-379): each event a sentence, filters behind buttons that
// round-trip through the address, and a row opening the whole record.

const denied: AuditRecord = {
  id: 7,
  occurred_at: '2026-10-24T13:05:00Z',
  principal_kind: 'user',
  principal_id: 'usr_lee',
  action: 'app.secrets.write',
  app_id: 'app_inv',
  app_name: 'invoice-tool',
  target_kind: 'app',
  target_id: 'app_inv',
  target_name: 'invoice-tool',
  request_id: 'req_01',
  outcome: 'denied',
  source_ip: '192.0.2.44',
  peer_ip: '10.0.0.2',
  user_agent: 'pando CLI 0.14.0',
  actor_name: 'Lee Chen',
  actor_email: 'lee@example.com',
  summary: 'Changed secrets on invoice-tool',
};

let screen: Mounted | undefined;

afterEach(() => {
  screen?.unmount();
  screen = undefined;
  vi.unstubAllGlobals();
});

/** Mounts the log answering with `events`, and records the API paths asked. */
function open(onFilters = vi.fn(), initial = NO_FILTERS) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url);
    asked.push(path);
    if (path.includes('/audit?') || path.endsWith('/audit')) return reply({ events: [denied], next_before: '' });
    if (path.includes('/audit/archives')) return reply({ archives: [] });
    if (path.includes('/audit/sinks')) return reply({ audit_sinks: [] });
    return unanswered();
  });
  screen = mount(<Audit initial={initial} onFilters={onFilters} onAdapters={() => {}} />, [[['me'], { verbs: ['install.audit.read'] }]]);
  return { asked, onFilters };
}

async function settle() {
  await screen!.settle(() => {});
  await screen!.settle(() => {});
}

describe('the audit log', () => {
  it('reads each event as a sentence, its action under it, and an outcome only when it was not a success', async () => {
    open();
    await settle();
    const text = screen!.text();
    expect(text).toContain('Changed secrets on invoice-tool');
    expect(text).toContain('app.secrets.write');
    expect(text).toContain('Denied');
    expect(text).toContain('Lee Chen');
    expect(text).toContain(stamp(denied.occurred_at));
  });

  it('opens an event’s whole record, and its actor’s events', async () => {
    const { onFilters } = open();
    await settle();
    await screen!.click('Changed secrets on invoice-tool');
    const panel = String(document.querySelector('aside[role="dialog"]')?.textContent);
    for (const fact of ['Actor ID', 'usr_lee', 'lee@example.com', 'Source IP', '192.0.2.44', 'Through', '10.0.0.2', 'Client', 'pando CLI 0.14.0', 'Request ID', 'req_01', 'Record']) {
      expect(panel, fact).toContain(fact);
    }
    expect(panel).toContain(fullStamp(denied.occurred_at));
    await screen!.press('Events by Lee');
    expect(document.querySelector('aside[role="dialog"]')).toBeNull();
    expect(onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, actor: 'usr_lee' });
  });

  it('copies the record', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    open();
    await settle();
    await screen!.click('Changed secrets on invoice-tool');
    await screen!.press('Copy record');
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"action": "app.secrets.write"'));
    expect(screen!.text()).toContain('Copied');
  });

  it('narrows by outcome from its button, and asks the server', async () => {
    const { asked, onFilters } = open();
    await settle();
    await screen!.press('Outcome');
    await screen!.click('Failed');
    expect(onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, outcome: 'failed' });
    await settle();
    expect(asked.some((p) => p.includes('outcome=failed'))).toBe(true);
    expect(screen!.text()).toContain('Outcome · 1');
    await screen!.press('Clear filters');
    expect(onFilters).toHaveBeenLastCalledWith(NO_FILTERS);
  });

  it('reads at phone width as the sentence, its actor and the time, opening a screen of its own', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    open();
    await settle();
    expect(screen!.text()).toContain('Lee Chen');
    expect(screen!.text()).not.toContain('app.secrets.write');
    await screen!.click('Changed secrets on invoice-tool');
    const back = [...document.querySelectorAll('aside button')].find((b) => b.textContent?.trim() === 'Audit log');
    expect(back).toBeTruthy();
    await screen!.settle(() => (back as HTMLButtonElement).click());
    expect(document.querySelector('aside[role="dialog"]')).toBeNull();
  });

  it('opens the archived months from one line', async () => {
    open();
    await settle();
    expect(screen!.text()).not.toContain('No months archived');
    await screen!.press('Archived months');
    await settle();
    expect(screen!.text()).toContain('No months archived');
  });
});

describe('the filters, as an address and as a query', () => {
  it('carries search and outcome both ways', () => {
    const f = { ...NO_FILTERS, q: 'crewmate', outcome: 'denied' };
    expect(filtersFrom(linkQuery(f))).toEqual(f);
    const q = new URLSearchParams(auditQuery(f));
    expect(q.get('q')).toBe('crewmate');
    expect(q.get('outcome')).toBe('denied');
  });
});

describe('a time in a list', () => {
  it('carries its date', () => {
    expect(stamp('2026-10-24T14:32:00')).toBe('Oct 24 14:32');
    expect(stamp('not a time')).toBe('not a time');
    expect(fullStamp('2026-10-24T13:05:00Z')).toBe('October 24, 2026 at 13:05 UTC');
    expect(fullStamp('nope')).toBe('nope');
    expect(isToday('2026-10-24T09:00:00', new Date('2026-10-24T20:00:00'))).toBe(true);
    expect(isToday('2026-10-23T09:00:00', new Date('2026-10-24T20:00:00'))).toBe(false);
  });
});
