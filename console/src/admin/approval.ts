// Deploy approval, as the console reads it (R-154 – R-159).
//
// The shapes are the server's own, generated from the Go types: a deployment
// carries its approval fields, and `GET /approvals` adds the app it is for.

import type {
  ApprovalDecision,
  AwaitingApproval,
  Deployment,
} from '@api/types.gen';

export type { ApprovalDecision };

export type ApprovalDeployment = Deployment;

/** One row of `GET /approvals`: a waiting deployment and the app it is for. */
export type ApprovalRow = AwaitingApproval;

export function isAwaiting(d: { status: string } | undefined): boolean {
  return d?.status === 'awaiting_approval';
}

/** How many approvals a request needs: one unless policy says more. */
function required(d: ApprovalDeployment): number {
  return d.approvals_required && d.approvals_required > 0 ? d.approvals_required : 1;
}

function approvedCount(d: ApprovalDeployment): number {
  return (d.approvals ?? []).filter((a) => a.decision === 'approve').length;
}

/** How far a request has got, as a phrase. */
export function progress(d: ApprovalDeployment): string {
  const need = required(d);
  const yes = approvedCount(d);
  if (need === 1) return yes === 0 ? 'Needs one approval' : 'Approved';
  if (yes === 0) return `Needs ${need} approvals`;
  return `${yes} of ${need} approvals`;
}

/**
 * When a request stops waiting, as a phrase. No expiry is a request that
 * waits until somebody answers (policy expiry zero, R-156).
 */
export function expiry(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return 'No expiry';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return `Expires at ${iso}`;
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return 'Expired';
  if (minutes < 60) return minutes === 1 ? 'Expires in 1 minute' : `Expires in ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? 'Expires in 1 hour' : `Expires in ${hours} hours`;
  return `Expires in ${Math.round(hours / 24)} days`;
}

/** Who decided, by name where the server gave one. */
export function decider(a: ApprovalDecision): string {
  return a.principal_name || a.principal_id;
}

/**
 * What a request says once this person has answered it: "Approved",
 * "Approved · 1 of 2" while it still needs more, or "Rejected".
 */
export function answeredLabel(verb: 'approve' | 'reject', after: ApprovalDeployment | undefined): string {
  if (verb === 'reject') return 'Rejected';
  if (after && isAwaiting(after)) return `Approved · ${approvedCount(after)} of ${required(after)}`;
  return 'Approved';
}

/** One change between two revisions, as `GET …/diff/…` returns it. */
export interface SpecChange {
  class: string;
  path: string;
  summary: string;
}

const KINDS: Record<string, string> = {
  source: 'Source',
  build: 'Build',
  runtime: 'Runtime',
  routing: 'Address',
  volumes: 'Storage',
  slots: 'Services',
  resources: 'Resources',
  health: 'Health check',
  deploy: 'Deployment',
  egress: 'Egress',
  retention: 'Retention',
};

const WORKLOAD_PARTS: Record<string, string> = {
  env: 'Variables',
  command: 'Command',
  image: 'Image',
  mounts: 'Storage',
  exposed: 'Address',
  primary: 'Workload',
};

/** What part of the app a change is to, in a word or two. */
export function changeKind(path: string): string {
  const [head, , part] = path.split('.');
  if (head === 'workloads') return (part && WORKLOAD_PARTS[part]) || 'Workload';
  return (head && KINDS[head]) || head || path;
}

/** What deploying a change does to the running app. */
export function changeEffect(c: SpecChange): string {
  const [head, workload] = c.path.split('.');
  switch (c.class) {
    case 'restart':
      return head === 'workloads' && workload ? `Restarts ${workload}` : 'Restarts';
    case 'rebuild':
      return 'Rebuilds';
    case 'destructive':
      return 'Destructive';
    default:
      return 'No restart';
  }
}
