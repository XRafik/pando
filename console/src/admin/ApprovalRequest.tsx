// One deployment waiting for approval, and the way to answer it (R-154 – R-156).
//
// Shown on the Approvals screen, one card per request, and on the app's
// overview. The same component in both places, so a request reads the same
// wherever it is found and Approve does the same thing.
//
// The card's summary is what a person deciding scans: the app, the revision,
// who asked and when, how far it has got and when it stops waiting, with
// Approve and Reject beside it. Opening it shows why it needs approval in the
// server's words (R-105), what it changes from the running revision, and what
// anybody has said so far. Approve and Reject are offered only to somebody the
// server says may decide (`can_decide`); the endpoint checks the verb either
// way.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banner, Button, Icon, Input, StatusIndicator } from '@design';

import { api } from '@api/client';
import type { App } from '@api/types.gen';
import { refusal } from '../install/Accounts';
import { LineSkeleton, Loading } from '../ui/Loading';
import { TopoTile } from '../ui/TopoBackground';
import { relative } from '../ui/time';
import { invalidateApp } from './appList';
import { answeredLabel, changeEffect, changeKind, decider, expiry, progress } from './approval';
import type { ApprovalDeployment, SpecChange } from './approval';
import './approvals.css';

type Verb = 'approve' | 'reject';

export function ApprovalRequest({
  deployment,
  appName,
  expanded = true,
  onToggle,
  onReview,
  onAnswered,
}: Readonly<{
  deployment: ApprovalDeployment;
  /** The app the request is for, on the Approvals screen. Absent on the
   *  app's own screen, which already says. */
  appName?: string;
  /** Whether the details show. Always, where there is no onToggle. */
  expanded?: boolean;
  /** The summary opens and closes the details. */
  onToggle?: () => void;
  /** Opens the app's Deployments panel on this request. */
  onReview?: () => void;
  /** This person answered it. */
  onAnswered?: () => void;
}>) {
  const queries = useQueryClient();
  const [comment, setComment] = useState('');
  const [answered, setAnswered] = useState<{ verb: Verb; label: string } | null>(null);
  const d = deployment;
  const path = `/apps/${d.app_id}/deployments/${d.id}`;

  const decide = useMutation({
    mutationFn: (verb: Verb) =>
      api.post<ApprovalDeployment>(`${path}/${verb}`, comment.trim() ? { comment: comment.trim() } : {}),
    onSuccess: (after, verb) => {
      setComment('');
      setAnswered({ verb, label: answeredLabel(verb, after) });
      onAnswered?.();
      // The app moves to deploying once enough people approve, so its record
      // and the list both change, as well as this request.
      void invalidateApp(queries, d.app_id);
      void queries.invalidateQueries({ queryKey: ['approvals'] });
    },
  });

  const open = expanded || !onToggle;
  const canAnswer = Boolean(d.can_decide) && !answered;
  const requester = d.requested_by_name || d.created_by;
  const meta = [requester, relative(d.started_at), progress(d), expiry(d.approval_expires_at)].join(' · ');
  const revision = d.spec_revision === undefined ? d.spec_id : `Revision ${d.spec_revision}`;

  const summary = (
    <>
      {appName !== undefined && (
        <span className="pando-approval-tile" aria-hidden="true">
          <TopoTile seed={d.app_id} />
        </span>
      )}
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' }}>
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--space-2) var(--space-3)' }}>
          <span className="pando-approval-name">{appName ?? 'Waiting for approval'}</span>
          <span style={{ font: 'var(--type-code-sm)', color: 'var(--ink-secondary)' }}>{revision}</span>
        </span>
        <span style={CAPTION}>{meta}</span>
      </span>
      {onToggle && (
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} />
      )}
    </>
  );

  return (
    <section
      className={open ? 'pando-approval pando-approval-open' : 'pando-approval'}
      aria-label={appName ?? 'Waiting for approval'}
    >
      <div className="pando-approval-head">
        {onToggle ? (
          <button type="button" className="pando-approval-sum" aria-expanded={open} onClick={onToggle}>
            {summary}
          </button>
        ) : (
          <div className="pando-approval-sum">{summary}</div>
        )}
        {canAnswer && <Answer pending={decide.isPending} onAnswer={(verb) => decide.mutate(verb)} className="pando-approval-quick" />}
        {answered && (
          <StatusIndicator
            status={answered.verb === 'reject' ? 'failed' : 'running'}
            label={answered.label}
            style={{ color: answered.verb === 'reject' ? 'var(--marker-deep)' : 'var(--status-running)' }}
          />
        )}
      </div>

      {decide.isError && (
        <div style={{ padding: '0 var(--space-4) var(--space-3)' }}>
          <Banner tone="failed">{refusal(decide.error)}</Banner>
        </div>
      )}

      {open && (
        <div className={appName === undefined ? 'pando-approval-body pando-approval-body-flush' : 'pando-approval-body'}>
          <Why reasons={d.approval_reasons ?? []} />
          <Changes deployment={d} onReview={onReview} />
          <Answers decisions={d.approvals ?? []} />
          {canAnswer && (
            <div className="pando-approval-decide">
              <Input
                aria-label={appName ? `Comment for ${appName}` : 'Comment'}
                placeholder="Comment (optional)"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <Answer pending={decide.isPending} onAnswer={(verb) => decide.mutate(verb)} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Answer({
  pending,
  onAnswer,
  className,
}: Readonly<{ pending: boolean; onAnswer: (verb: Verb) => void; className?: string }>) {
  return (
    <span className={className ? `pando-approval-buttons ${className}` : 'pando-approval-buttons'}>
      <Button variant="secondary" icon={<Icon name="check" size={14} color="var(--ink)" />} disabled={pending} onClick={() => onAnswer('approve')}>
        Approve
      </Button>
      <Button variant="ghost" disabled={pending} onClick={() => onAnswer('reject')} style={{ color: 'var(--marker-deep)' }}>
        Reject
      </Button>
    </span>
  );
}

function Why({ reasons }: Readonly<{ reasons: { reason: string; message: string }[] }>) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      <span style={LABEL}>Why</span>
      {reasons.map((r) => (
        <span key={r.reason + r.message} style={BODY}>
          {r.message}
        </span>
      ))}
    </div>
  );
}

/** What the requested revision changes from the one the app runs. */
function Changes({ deployment, onReview }: Readonly<{ deployment: ApprovalDeployment; onReview?: () => void }>) {
  const app = useQuery({
    queryKey: ['apps', deployment.app_id],
    queryFn: () => api.get<App>(`/apps/${deployment.app_id}`),
  });
  const pinned = app.data?.pinned_spec_id;
  const diff = useQuery({
    queryKey: ['apps', deployment.app_id, 'spec-diff', pinned, deployment.spec_id],
    queryFn: () =>
      api.get<{ changes?: SpecChange[] | null }>(`/apps/${deployment.app_id}/specs/${pinned}/diff/${deployment.spec_id}`),
    enabled: Boolean(pinned),
  });
  const changes = diff.data?.changes ?? [];

  let body: React.ReactNode;
  if (app.isPending || (pinned && diff.isPending)) {
    body = (
      <Loading gap="var(--space-2)">
        <LineSkeleton width="32ch" />
        <LineSkeleton width="24ch" />
      </Loading>
    );
  } else if (app.isError || diff.isError) {
    body = <span style={CAPTION}>{refusal(app.error ?? diff.error)}</span>;
  } else if (!pinned) {
    body = <span style={BODY}>First deployment</span>;
  } else if (changes.length === 0) {
    body = <span style={BODY}>No changes</span>;
  } else {
    body = changes.map((c) => (
      <div key={c.path + c.summary} className="pando-approval-change">
        <span style={CAPTION}>{changeKind(c.path)}</span>
        <span className="pando-approval-what">{c.summary}</span>
        <span style={{ ...CAPTION, whiteSpace: 'nowrap', color: c.class === 'destructive' ? 'var(--marker-deep)' : 'var(--ink-secondary)' }}>
          {changeEffect(c)}
        </span>
      </div>
    ));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 'var(--space-1)' }}>
        <span style={LABEL}>Changes</span>
        {onReview && (
          <Button variant="ghost" onClick={onReview} style={{ font: 'var(--type-caption)' }}>
            Review changes
          </Button>
        )}
      </div>
      {body}
    </div>
  );
}

function Answers({ decisions }: Readonly<{ decisions: NonNullable<ApprovalDeployment['approvals']> }>) {
  if (decisions.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      <span style={LABEL}>Answers</span>
      {decisions.map((a) => {
        const yes = a.decision === 'approve';
        return (
          <span key={a.principal_id} style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--space-2)', ...BODY }}>
            <Icon name={yes ? 'check' : 'x'} size={12} color={yes ? 'var(--status-running)' : 'var(--marker-deep)'} />
            <span>
              {decider(a)} {yes ? 'approved' : 'rejected'}
              {a.comment ? `: “${a.comment}”` : ''}
            </span>
            <span style={CAPTION}>{relative(a.decided_at)}</span>
          </span>
        );
      })}
    </div>
  );
}

const BODY: React.CSSProperties = { font: 'var(--type-body-ui)', color: 'var(--ink)' };
const CAPTION: React.CSSProperties = { font: 'var(--type-caption)', color: 'var(--ink-secondary)' };
const LABEL: React.CSSProperties = { font: 'var(--type-caption)', fontWeight: 500, color: 'var(--ink-secondary)' };
