// Approvals: the deployments waiting for this person's sign-off (R-154 – R-156).
//
// The approver's inbox. `GET /approvals?decidable=true` answers with the
// waiting requests this caller may approve or reject — install.deploys.approve,
// or app.deploy.approve on the app — so the screen holds nothing it cannot act
// on. A request waiting on somebody else is shown on its app instead.
//
// Each request is a card that starts closed: the summary and Approve and
// Reject. One opens at a time. A request answered here stays on the screen
// with its answer until the screen is next opened, so the answer is seen
// rather than the card vanishing under the pointer.

import { useState } from 'react';
import { usePolledHead, type HeadShape } from '../ui/headPoll';
import { EmptyState } from '@design';

import { api } from '@api/client';
import { Quiet, Screen, messageOf } from '../install/Accounts';
import { LineSkeleton, Loading } from '../ui/Loading';
import { ShowMore, withParams } from '../ui/paged';
import { ApprovalRequest } from './ApprovalRequest';
import type { ApprovalRow } from './approval';

/**
 * The waiting requests this caller may decide. One query key for the
 * sidebar's count and this screen, so the two cannot disagree. A caller the
 * endpoint refuses has nothing waiting for them, which is an answer rather
 * than an error, so it is not retried.
 */
type ApprovalsPage = { approvals: ApprovalRow[] | null; next_cursor?: string };

const APPROVALS_SHAPE: HeadShape<ApprovalsPage, ApprovalRow> = {
  rowsOf: (p) => p.approvals ?? [],
  withRows: (p, approvals) => ({ ...p, approvals }),
  idOf: (r) => r.id,
  hasMore: (p) => Boolean(p.next_cursor),
};

export function useApprovals(enabled: boolean) {
  const query = usePolledHead({
    key: ['approvals'],
    headKey: ['approvals-head'],
    fetchPage: (cursor) => api.get<ApprovalsPage>(withParams('/approvals', { decidable: 'true', cursor })),
    // A page at a time (issue #72). A page can be short and still have a
    // next one, when the requests it read were ones this caller can't decide.
    nextParam: (last) => last.next_cursor || undefined,
    shape: APPROVALS_SHAPE,
    enabled,
    retry: false,
    // Somebody else's answer, or a new request, changes this list. Every open
    // console asks, and each ask checks access app by app, so not often: a
    // request waits hours for an answer, not seconds. The first page only —
    // a request answered further down goes when this screen is next opened.
    interval: 60_000,
  });
  return { query, rows: query.data?.pages.flatMap((p) => p.approvals ?? []) ?? [] };
}

/** The rows from the server, and the ones answered here that it no longer
 *  lists, in the order they were requested. */
export function withAnswered(rows: ApprovalRow[], answered: ReadonlyMap<string, ApprovalRow>): ApprovalRow[] {
  const ids = new Set(rows.map((r) => r.id));
  const kept = [...answered.values()].filter((r) => !ids.has(r.id));
  if (kept.length === 0) return rows;
  return [...rows, ...kept].sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
}

export function Approvals({
  onReview,
}: Readonly<{
  /** Opens the app's Deployments panel on a request. */
  onReview: (appID: string, deploymentID: string) => void;
}>) {
  const { query: approvals, rows } = useApprovals(true);
  const [open, setOpen] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ReadonlyMap<string, ApprovalRow>>(new Map());
  const shown = withAnswered(rows, answered);

  return (
    <Screen heading="Approvals">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {approvals.isPending && (
          <Loading gap="var(--space-3)">
            <LineSkeleton width="24ch" font="var(--type-h4)" />
            <LineSkeleton width="52ch" />
            <LineSkeleton width="40ch" />
          </Loading>
        )}
        {approvals.isError && <Quiet>{messageOf(approvals.error)}</Quiet>}

        {approvals.isSuccess && shown.length === 0 && !approvals.hasNextPage && <EmptyState heading="Nothing waiting" />}

        {shown.map((row) => (
          <ApprovalRequest
            key={row.id}
            deployment={row}
            appName={row.app_name}
            expanded={open === row.id}
            onToggle={() => setOpen(open === row.id ? null : row.id)}
            onReview={() => onReview(row.app_id, row.id)}
            onAnswered={() => setAnswered((all) => new Map(all).set(row.id, row))}
          />
        ))}
        <ShowMore query={approvals} label="Show more requests" />
      </div>
    </Screen>
  );
}
