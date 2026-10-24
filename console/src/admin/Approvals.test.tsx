// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Approvals, withAnswered } from './Approvals';
import type { ApprovalRow } from './approval';
import { mount, reply, unanswered } from '../ui/testing';
import type { Mounted } from '../ui/testing';

const row = (over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: 'dep_01',
  app_id: 'app_01',
  app_name: 'crewmate',
  app_slug: 'crewmate',
  spec_id: 'spec_15',
  spec_revision: 15,
  trigger: 'manual',
  status: 'awaiting_approval',
  started_at: '2026-10-01T00:00:00Z',
  created_by: 'usr_01',
  requested_by_name: 'Ana Ruiz',
  approvals_required: 2,
  approval_reasons: [{ reason: 'install', message: 'This installation requires approval for every deployment.' }],
  approvals: [],
  can_decide: true,
  ...over,
});

let screen: Mounted | undefined;

/** Waits for the screen to say something: a request or two away. */
async function until(text: string) {
  for (let i = 0; i < 20 && !screen!.text().includes(text); i++) await screen!.settle(() => {});
  expect(screen!.text()).toContain(text);
}
afterEach(() => {
  screen?.unmount();
  screen = undefined;
  vi.unstubAllGlobals();
});

/** A fetch that answers the approvals list, the app, its diff and a decision. */
function server(rows: ApprovalRow[], after?: Partial<ApprovalRow>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    calls.push({ method: init?.method ?? 'GET', url: path, body: init?.body as string | undefined });
    if (path.includes('/approvals')) return reply({ approvals: rows });
    if (path.includes('/diff/')) {
      return reply({
        changes: [
          { class: 'restart', path: 'workloads.web.image', summary: 'a3f9c21 → b71e044' },
          { class: 'destructive', path: 'routing.hostname', summary: 'old.example → new.example' },
        ],
      });
    }
    if (path.endsWith('/approve') || path.endsWith('/reject')) return reply({ ...rows[0], ...after });
    if (path.includes('/apps/app_01')) return reply({ id: 'app_01', pinned_spec_id: 'spec_14' });
    return unanswered();
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

describe('the Approvals screen (R-155, R-156)', () => {
  it('asks only for what this person may decide, and starts each card closed', async () => {
    const calls = server([row()]);
    screen = mount(<Approvals onReview={() => {}} />);
    await until('crewmate');
    expect(calls[0]?.url).toContain('decidable=true');
    expect(screen.text()).toContain('crewmate');
    expect(screen.text()).toContain('Revision 15');
    expect(screen.text()).toContain('Ana Ruiz');
    expect(screen.text()).toContain('Needs 2 approvals');
    expect(screen.text()).toContain('No expiry');
    expect(screen.text()).not.toContain('Why');
  });

  it('opens one card to its reasons and changes, and reviews them on the app', async () => {
    server([row(), row({ id: 'dep_02', app_id: 'app_02', app_name: 'invoice-tool', started_at: '2026-10-02T00:00:00Z' })]);
    const onReview = vi.fn();
    screen = mount(<Approvals onReview={onReview} />);
    await until('invoice-tool');
    await screen.click('crewmate');
    await until('Restarts web');
    expect(screen.text()).toContain('This installation requires approval for every deployment.');
    expect(screen.text()).toContain('Image');
    expect(screen.text()).toContain('a3f9c21 → b71e044');
    expect(screen.text()).toContain('Restarts web');
    expect(screen.text()).toContain('Destructive');

    await screen.press('Review changes');
    expect(onReview).toHaveBeenCalledWith('app_01', 'dep_01');

    // Opening another closes the first.
    await screen.click('invoice-tool');
    expect(document.querySelectorAll('[aria-expanded="true"]')).toHaveLength(1);
    await screen.click('invoice-tool');
    expect(document.querySelectorAll('[aria-expanded="true"]')).toHaveLength(0);
  });

  it('says how far an approval got, and keeps the answered card in place', async () => {
    const calls = server([row()], {
      approvals: [{ principal_id: 'usr_02', principal_name: 'Sam', decision: 'approve', decided_at: '2026-10-01T01:00:00Z' }],
    });
    screen = mount(<Approvals onReview={() => {}} />);
    await until('crewmate');
    await screen.click('crewmate');
    await screen.type('Comment for crewmate', 'looks fine');
    await screen.press('Approve');
    await until('Approved · 1 of 2');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/apps/app_01/deployments/dep_01/approve');
    expect(post?.body).toContain('looks fine');
    expect(screen.text()).toContain('Approved · 1 of 2');
    expect(screen.text()).not.toContain('Reject');
  });

  it('says a rejection', async () => {
    server([row({ approvals_required: 1 })], { status: 'rejected' });
    screen = mount(<Approvals onReview={() => {}} />);
    await until('crewmate');
    await screen.press('Reject');
    await until('Rejected');
    expect(screen.text()).not.toContain('Approve');
  });

  it('says when nothing is waiting', async () => {
    server([]);
    screen = mount(<Approvals onReview={() => {}} />);
    await until('Nothing waiting');
  });

  it('says a first deployment has nothing to compare with, and shows who answered', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/approvals')) {
        return reply({
          approvals: [
            row({
              approvals: [{ principal_id: 'usr_02', principal_name: 'Sam', decision: 'approve', comment: 'Image looks fine.', decided_at: '2026-10-01T01:00:00Z' }],
            }),
          ],
        });
      }
      if (path.includes('/apps/app_01')) return reply({ id: 'app_01' });
      return unanswered();
    });
    vi.stubGlobal('fetch', fetch);
    screen = mount(<Approvals onReview={() => {}} />);
    await until('crewmate');
    await screen.click('crewmate');
    await until('First deployment');
    expect(screen.text()).toContain('Sam approved: “Image looks fine.”');
  });
});

describe('answered requests stay listed', () => {
  it('puts them back among the server rows, oldest first', () => {
    const a = row({ id: 'dep_a', started_at: '2026-10-01T00:00:00Z' });
    const b = row({ id: 'dep_b', started_at: '2026-10-02T00:00:00Z' });
    const c = row({ id: 'dep_c', started_at: '2026-10-03T00:00:00Z' });
    expect(withAnswered([a, c], new Map())).toEqual([a, c]);
    expect(withAnswered([a, c], new Map([['dep_b', b]])).map((r) => r.id)).toEqual(['dep_a', 'dep_b', 'dep_c']);
    expect(withAnswered([a, b], new Map([['dep_b', b]])).map((r) => r.id)).toEqual(['dep_a', 'dep_b']);
  });
});
