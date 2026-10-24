// Backups — the page behind install.backup.manage (Sequence D).
//
// The one thing this page has to get right is R-214: Pando never stores the
// passphrase, and a lost one makes the bundle unusable. The requirement says
// that must be stated **at creation, not in documentation** — so it is in the
// dialog, above the field, in body text.
//
// Restore is deliberately awkward. It replaces every app, account and secret in
// the installation, and a page that made it feel routine would be lying about
// what it does.
//
// Neither list is drawn in full. Daily app backups is a line saying how many
// apps were backed up today, and only the ones that failed; the whole
// installation's backups are the newest three, with older ones a click away.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Banner, Button, Dialog, EmptyState, Input, StatusIndicator } from '@design';

import { api } from '@api/client';
import type { BackupAttempt } from '@api/types.gen';
import { Quiet, messageOf } from './Accounts';
import { Table } from '../ui/Table';
import { ShowMore, usePaged, type PageOf } from '../ui/paged';
import { attemptDetail, attemptLabel, attemptSymbol } from '../ui/backupAttempt';
import { SystemCard } from './Updates';
import { SystemPage } from './SystemPage';
import { isToday, stamp } from './stamp';

interface BackupRow {
  id: string;
  kind: string;
  adapter_ref: string;
  size_bytes: number;
  created_at: string;
  retain_until?: string;
  manifest?: { counts?: Record<string, number>; created_at?: string };
}

/** How many of the newest whole-installation backups are shown at first. */
const NEWEST = 3;

/** "8 of 9 apps backed up today". */
export function dailySummary(attempts: BackupAttempt[], now = new Date()): string {
  const done = attempts.filter((a) => a.outcome === 'taken' && isToday(a.attempted_at, now)).length;
  const n = attempts.length;
  return `${done} of ${n} ${n === 1 ? 'app' : 'apps'} backed up today`;
}

export function Backups() {
  const [taking, setTaking] = useState(false);
  const [acting, setActing] = useState<{ row: BackupRow; mode: 'verify' | 'restore' } | null>(null);
  const [older, setOlder] = useState(false);
  const [allApps, setAllApps] = useState(false);

  // Newest first, a page at a time (issue #72). The first page carries the
  // most recent apps' last scheduled attempts.
  const paged = usePaged<{ backups: BackupRow[] | null; attempts?: BackupAttempt[] } & PageOf, BackupRow>({
    key: ['backups'],
    path: '/backups',
    rows: (p) => p.backups,
  });
  const backups = paged.query;
  // The whole installation's: an app's own rolling backups are its own.
  const bundles = paged.rows.filter((r) => r.kind === 'dr_bundle');
  const shown = older ? bundles : bundles.slice(0, NEWEST);
  const attempts = backups.data?.pages[0]?.attempts ?? [];
  const failed = attempts.filter((a) => a.outcome === 'failed');
  const take = (
    <Button variant="primary" onClick={() => setTaking(true)}>
      Take a backup
    </Button>
  );

  return (
    <SystemPage title="Backups" action={take}>
      {backups.isError && <Quiet>{messageOf(backups.error)}</Quiet>}

      {/* Each app's last daily backup, including the ones that did not
          happen (R-211, issue #87): a backup that was skipped or failed
          leaves nothing in the list below. */}
      {attempts.length > 0 && (
        <SystemCard
          heading="Daily app backups"
          action={<StatusIndicator status={failed.length > 0 ? 'failed' : 'running'} label={dailySummary(attempts)} />}
        >
          {(allApps || failed.length > 0) && (
            <Table
              columns={[
                {
                  key: 'app_name',
                  header: 'App',
                  width: 'minmax(0,22ch)',
                  render: (row: BackupAttempt) => row.app_name || row.app_id,
                },
                {
                  key: 'outcome',
                  header: 'Last attempt',
                  width: '24ch',
                  render: (row: BackupAttempt) => (
                    <StatusIndicator status={attemptSymbol(row)} label={`${attemptLabel(row)} ${stamp(row.attempted_at)}`} />
                  ),
                },
                {
                  key: 'message',
                  header: 'Details',
                  width: 'minmax(0,1fr)',
                  muted: true,
                  render: (row: BackupAttempt) => attemptDetail(row) || '—',
                },
              ]}
              rows={(allApps ? attempts : failed).map((a) => ({ ...a, id: a.app_id }))}
            />
          )}
          <div>
            <Button variant="ghost" aria-expanded={allApps} onClick={() => setAllApps(!allApps)}>
              {allApps ? 'Show only failures' : `Show all ${attempts.length} apps`}
            </Button>
          </div>
        </SystemCard>
      )}

      <SystemCard
        heading={
          <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--space-1) var(--space-3)' }}>
            Whole installation{' '}
            <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>Every app, account and secret</span>
          </span>
        }
      >
        <Table
          loading={backups.isPending}
          // An installation that has never been backed up is the state this
          // page most needs to be clear about.
          empty={<EmptyState heading="No backups yet" action={take} />}
          columns={[
            {
              key: 'created_at',
              header: 'Taken',
              width: '16ch',
              render: (row: BackupRow) => stamp(row.created_at),
            },
            {
              key: 'size_bytes',
              header: 'Size',
              width: '10ch',
              muted: true,
              render: (row: BackupRow) => humanSize(row.size_bytes),
            },
            { key: 'adapter_ref', header: 'Destination', width: 'minmax(0,18ch)', mono: true },
            {
              key: 'retain_until',
              header: 'Kept until',
              width: '16ch',
              muted: true,
              render: (row: BackupRow) => (row.retain_until ? new Date(row.retain_until).toLocaleDateString() : 'Until discarded'),
            },
            {
              key: 'actions',
              header: '',
              width: '22ch',
              align: 'right',
              render: (row: BackupRow) => (
                <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
                  {/* Check a backup before it is needed (R-216). */}
                  <Button variant="secondary" onClick={() => setActing({ row, mode: 'verify' })}>
                    Check
                  </Button>
                  <Button variant="secondary" onClick={() => setActing({ row, mode: 'restore' })}>
                    Restore
                  </Button>
                </div>
              ),
            },
          ]}
          rows={shown}
        />
        {bundles.length > NEWEST && !older && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)' }}>
            <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>
              {NEWEST} newest of {backups.hasNextPage ? `${bundles.length}+` : bundles.length}
            </span>
            <Button variant="ghost" onClick={() => setOlder(true)}>
              Show older backups
            </Button>
          </div>
        )}
        {older && <ShowMore query={backups} label="Show older backups" />}
      </SystemCard>

      {taking && <TakeBackup onClose={() => setTaking(false)} />}
      {acting && <UseBackup {...acting} onClose={() => setActing(null)} />}
    </SystemPage>
  );
}

function TakeBackup({ onClose }: { onClose: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [retainDays, setRetainDays] = useState('30');
  const queries = useQueryClient();

  const mismatch = again !== '' && passphrase !== again;

  const take = useMutation({
    mutationFn: () =>
      api.post<unknown>('/backups', {
        passphrase,
        retain_days: Number(retainDays) || 0,
      }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['backups'] });
      onClose();
    },
  });

  return (
    <Dialog
      open
      title="Take a backup"
      description="Every app's configuration and data, and the key to its secrets."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={take.isPending || passphrase.length < 16 || passphrase !== again}
            onClick={() => take.mutate()}
          >
            {take.isPending ? 'Taking backup' : 'Take backup'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {/* R-214, said at the point it matters. Not a tooltip: this is the one
            fact about backups that costs an installation if it is missed, and
            a person reads it here or not at all. */}
        <Banner tone="info">
          Pando doesn&rsquo;t keep this passphrase. Without it, this backup can&rsquo;t be restored.
        </Banner>

        <Input
          label="Passphrase"
          type="password"
          value={passphrase}
          autoComplete="new-password"
          helper="At least 16 characters. Store it somewhere off this machine."
          onChange={(e) => setPassphrase(e.target.value)}
        />
        <Input
          label="Passphrase again"
          type="password"
          value={again}
          autoComplete="new-password"
          onChange={(e) => setAgain(e.target.value)}
          error={
            mismatch
              ? 'Passphrases don’t match.'
              : take.isError
                ? messageOf(take.error)
                : undefined
          }
        />
        <Input
          label="Keep for"
          type="number"
          value={retainDays}
          helper="Days. 0 keeps it until you discard it."
          onChange={(e) => setRetainDays(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

function UseBackup({
  row,
  mode,
  onClose,
}: {
  row: BackupRow;
  mode: 'verify' | 'restore';
  onClose: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [typed, setTyped] = useState('');
  const queries = useQueryClient();

  const restoring = mode === 'restore';

  // One mutation for both, because the dialog is the same shape and only the
  // consequence differs. The response bodies differ too, so the type is the
  // union rather than either one.
  const run = useMutation<{ volumes?: number; verified?: boolean }>({
    mutationFn: () =>
      restoring
        ? api.post<{ volumes: number }>(`/backups/${row.id}/restore`, { passphrase, confirm: true })
        : api.post<{ verified: boolean }>(`/backups/${row.id}/verify`, { passphrase }),
    onSuccess: () => void queries.invalidateQueries(),
  });

  // Typing the word is the confirmation. A second "are you sure" dialog trains
  // people to click through both; typing cannot be done by muscle memory.
  const confirmed = !restoring || typed === 'replace';

  return (
    <Dialog
      open
      title={restoring ? 'Restore this installation' : 'Check this backup'}
      description={
        restoring
          ? 'Everything here is replaced by what was in the backup. Anything created since then is gone.'
          : 'Reads the backup and checks it is complete. Nothing here changes.'
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={restoring ? 'destructive' : 'primary'}
            disabled={run.isPending || passphrase === '' || !confirmed}
            onClick={() => run.mutate()}
          >
            {run.isPending
              ? restoring
                ? 'Restoring'
                : 'Checking'
              : restoring
                ? 'Replace this installation'
                : 'Check backup'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {run.isSuccess && !restoring && (
          <Banner tone="running">This backup is complete and can be restored.</Banner>
        )}
        {run.isSuccess && restoring && (
          <Banner tone="running">Restored. Apps are being brought back to their pinned setup.</Banner>
        )}

        <Input
          label="Passphrase"
          type="password"
          value={passphrase}
          autoComplete="off"
          onChange={(e) => setPassphrase(e.target.value)}
          error={run.isError ? messageOf(run.error) : undefined}
        />

        {restoring && (
          <Input
            label="Type replace to confirm"
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        )}
      </div>
    </Dialog>
  );
}

/** Sizes in the shortest honest unit, like durations elsewhere. */
function humanSize(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
