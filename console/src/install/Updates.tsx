// The Pando card on System's Overview: whether a newer Pando is released
// (R-351), how to upgrade this installation to it (R-352), and upgrading it
// in place (R-355 – R-360).
//
// The check's settings and the in-place opt-in are host policy. They open in
// place on this card and are saved with the rest of policy, so a value fixed
// in the startup config is shown read-only by the same rule everywhere.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banner, Button, Checkbox, CodeBlock, Dialog, InlineCode, Input, StatusIndicator, Tag } from '@design';

import { api } from '@api/client';
import type { Attempt, Plan, Release, Status } from '@api/types.gen';
import { InstallVerb, useInstallVerb } from '../app/principal';
import { Quiet, messageOf } from './Accounts';
import { relative } from '../ui/time';

/** The same rule as any backup's passphrase (backup.MinPassphraseLength). */
const MIN_PASSPHRASE = 16;

export function useUpdates(enabled: boolean) {
  return useQuery({
    queryKey: ['updates'],
    queryFn: () => api.get<Status>('/updates'),
    enabled,
    // The server checks every six hours; asking it hourly is plenty to show
    // what it found.
    refetchInterval: 60 * 60 * 1000,
  });
}

/** A card: a heading with an action beside it, then what it holds. */
export function SystemCard({
  heading,
  action,
  children,
}: Readonly<{ heading: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }>) {
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
        minWidth: 0,
        padding: 'var(--space-4) var(--space-5)',
        background: 'var(--paper-raised)',
        border: 'var(--border-width) solid var(--rule)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2) var(--space-3)' }}>
        <h3 style={{ font: 'var(--type-h3)', color: 'var(--ink)', margin: 0 }}>{heading}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Label over value, as many to a line as fit. */
function Facts({ facts }: Readonly<{ facts: Array<[string, React.ReactNode]> }>) {
  return (
    <dl className="pando-facts">
      {facts.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Pando itself: the version running and the latest, Upgrade, and the release
 * notes and update settings, each opened in place. `settings` is the update
 * settings form, given by whoever holds the policy draft.
 */
export function PandoCard({ settings }: Readonly<{ settings?: React.ReactNode }>) {
  const updates = useUpdates(true);
  const queries = useQueryClient();
  const [open, setOpen] = useState<'notes' | 'settings' | null>(null);
  // The server checks at startup and every six hours; this asks it now (R-349).
  const check = useMutation({
    mutationFn: () => api.post<Status>('/updates/check'),
    onSuccess: (fresh) => queries.setQueryData(['updates'], fresh),
  });
  const st = updates.data;
  const toggle = (which: 'notes' | 'settings') => setOpen(open === which ? null : which);
  const releases = st?.releases ?? [];

  return (
    <SystemCard
      heading="Pando"
      action={
        settings && (
          <Button variant="ghost" aria-expanded={open === 'settings'} onClick={() => toggle('settings')}>
            Update settings
          </Button>
        )
      }
    >
      {updates.isError && <Quiet>{messageOf(updates.error)}</Quiet>}
      {st && (
        <>
          <Facts
            facts={[
              ['Running', <span key="r" style={{ font: 'var(--type-code)' }}>{st.development ? 'Development build' : st.current}</span>],
              ...(st.enabled && st.checked_at
                ? ([
                    ['Latest', <span key="l" style={{ font: 'var(--type-code)' }}>{st.latest || 'None published'}</span>],
                    ['Status', <UpdateStatus key="s" st={st} />],
                    ['Checked', relative(st.checked_at)],
                  ] as Array<[string, React.ReactNode]>)
                : []),
            ]}
          />
          {!st.enabled && <Quiet>The update check is off.</Quiet>}
          {st.error && <Banner tone="failed">{st.error}</Banner>}
          {st.enabled && !st.checked_at && !st.error && <Quiet>Pando hasn&rsquo;t checked for releases yet.</Quiet>}
          {check.isError && <Banner tone="failed">{messageOf(check.error)}</Banner>}

          <LastUpgrade />

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
            {st.available && st.upgrade && <InPlace version={st.upgrade.version} />}
            {releases.length > 0 && (
              <Button variant="secondary" aria-expanded={open === 'notes'} onClick={() => toggle('notes')}>
                Release notes
              </Button>
            )}
            {st.enabled && (
              <Button variant="ghost" disabled={check.isPending} onClick={() => check.mutate()}>
                {check.isPending ? 'Checking' : 'Check now'}
              </Button>
            )}
          </div>

          {st.available && st.upgrade && <ManualUpgrade st={st} />}

          {open === 'notes' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              {releases.map((r) => (
                <ReleaseNotes key={r.version} release={r} />
              ))}
            </div>
          )}
        </>
      )}
      {open === 'settings' && settings}
    </SystemCard>
  );
}

/** Up to date, or how far behind and whether it matters. */
function UpdateStatus({ st }: Readonly<{ st: Status }>) {
  if (!st.available) return <StatusIndicator status="running" label={st.development ? 'Not compared' : 'Up to date'} />;
  if (st.security) return <StatusIndicator status="failed" label="Security fix" />;
  if (st.breaking) return <StatusIndicator status="info" label="Update, with breaking changes" />;
  return <StatusIndicator status="info" label="Update available" />;
}

function ReleaseNotes({ release }: { release: Release }) {
  return (
    <article style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <header style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h4 style={{ font: 'var(--type-h4)', color: 'var(--ink)', margin: 0 }}>
          {release.url ? <a href={release.url}>{release.version}</a> : release.version}
        </h4>
        {release.published_at && (
          <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>
            {release.published_at.slice(0, 10)}
          </span>
        )}
        {release.security && <StatusIndicator status="failed" label="Security fix" />}
        {release.breaking && <Tag tone="contour">Breaking</Tag>}
        {release.prerelease && <Tag>Release candidate</Tag>}
      </header>
      <Changelog notes={release.notes} />
    </article>
  );
}

/**
 * A CHANGELOG.md section, rendered. The release workflow writes exactly the
 * shapes docs/releasing.md asks for — `###` headings, `-` bullets,
 * paragraphs, inline code — so those are all this reads; anything else is
 * shown as the text it is. Never HTML: release notes are text, and this
 * renders them as text.
 */
function Changelog({ notes }: { notes: string }) {
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push(
        <p key={blocks.length} style={{ font: 'var(--type-body-ui)', color: 'var(--ink)', margin: 0 }}>
          {inline(para.join(' '))}
        </p>,
      );
      para = [];
    }
    if (bullets.length) {
      blocks.push(
        <ul key={blocks.length} style={{ margin: 0, paddingLeft: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          {bullets.map((b, i) => (
            <li key={i} style={{ font: 'var(--type-body-ui)', color: 'var(--ink)' }}>
              {inline(b)}
            </li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };

  for (const raw of notes.split('\n')) {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s(.*)$/.exec(line.trim());
    if (heading) {
      flush();
      blocks.push(
        <h3 key={blocks.length} style={{ font: 'var(--type-label)', color: 'var(--ink-secondary)', margin: 'var(--space-2) 0 0' }}>
          {heading[1]?.trim()}
        </h3>,
      );
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (para.length) flush();
      bullets.push(line.replace(/^\s*[-*]\s+/, ''));
    } else if (line.trim() === '') {
      flush();
    } else if (bullets.length && /^\s+/.test(line)) {
      bullets[bullets.length - 1] += ' ' + line.trim();
    } else {
      if (bullets.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>{blocks}</div>;
}

/** Inline code between backticks; everything else as text. */
function inline(text: string): React.ReactNode[] {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
      <InlineCode key={i}>{part.slice(1, -1)}</InlineCode>
    ) : (
      part.replace(/\*\*([^*]+)\*\*/g, '$1')
    ),
  );
}

function useUpgradePlan(version: string) {
  return useQuery({
    queryKey: ['upgrade-plan', version],
    queryFn: () => api.get<Plan>(`/upgrade?version=${encodeURIComponent(version)}`),
  });
}

/** Upgrade, when Pando can replace itself (R-355). */
function InPlace({ version }: Readonly<{ version: string }>) {
  const canUpgrade = useInstallVerb(InstallVerb.Upgrade);
  const [open, setOpen] = useState(false);
  const p = useUpgradePlan(version).data;
  if (!p?.possible) return null;
  return (
    <>
      <Button variant="primary" disabled={!canUpgrade} onClick={() => setOpen(true)}>
        Upgrade to {p.target}
      </Button>
      {open && <UpgradeDialog plan={p} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * What stands in the way of the upgrade: breaking changes, the verb, and
 * when Pando can't replace itself, every reason why and the command to
 * upgrade it by hand (R-352).
 */
function ManualUpgrade({ st }: Readonly<{ st: Status }>) {
  const canUpgrade = useInstallVerb(InstallVerb.Upgrade);
  const upgrade = st.upgrade!;
  const plan = useUpgradePlan(upgrade.version);
  const p = plan.data;
  const byHand = !p?.possible;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {st.breaking && (
        <Banner tone="info">
          A version between this one and {upgrade.version} has breaking changes. Read its release notes first.
        </Banner>
      )}
      {p?.possible && !canUpgrade && <Quiet>Upgrading needs install.upgrade, which the Administrator role holds.</Quiet>}
      {p && !p.possible && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <p style={{ font: 'var(--type-label)', color: 'var(--ink)', margin: 0 }}>Pando can't upgrade itself from here</p>
          <ul style={{ margin: 0, paddingLeft: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            {(p.reasons ?? []).map((r) => (
              <li key={r} style={{ font: 'var(--type-body-ui)', color: 'var(--ink-secondary)' }}>
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
      {byHand && (
        <>
          <CodeBlock prompt copyable lines={upgrade.command} />
          <p style={{ font: 'var(--type-body-ui)', color: 'var(--ink-secondary)', margin: 0 }}>{upgrade.instructions}</p>
        </>
      )}
    </div>
  );
}

/**
 * The confirmation (R-358, R-360): the outage, each breaking version's notes
 * with the version typed to go ahead, and the backup's passphrase or an
 * explicit choice to go without one. The same questions `pando upgrade` asks.
 */
function UpgradeDialog({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const queries = useQueryClient();
  const [typed, setTyped] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [skip, setSkip] = useState(false);
  const breaking = plan.breaking ?? [];
  const confirmed = breaking.length === 0 || typed.trim().replace(/^v/, '') === plan.target;
  const backupReady = skip || passphrase.length >= MIN_PASSPHRASE;

  const start = useMutation({
    mutationFn: () =>
      api.post<Attempt>('/upgrade', {
        version: plan.target,
        ...(breaking.length > 0 ? { confirm_breaking: plan.target } : {}),
        ...(skip ? { skip_backup: true } : { passphrase }),
      }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['upgrade-last'] });
      onClose();
    },
  });

  return (
    <Dialog
      open
      title={`Upgrade Pando to ${plan.target}`}
      description={plan.note}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!confirmed || !backupReady || start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? 'Upgrading' : `Upgrade to ${plan.target}`}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {breaking.map((r) => (
          <div key={r.version} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <p style={{ font: 'var(--type-label)', color: 'var(--ink)', margin: 0 }}>
              {r.version} has breaking changes
            </p>
            <Changelog notes={r.notes} />
          </div>
        ))}
        {breaking.length > 0 && (
          <Input
            label={`Type ${plan.target} to upgrade anyway`}
            mono
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        )}

        {/* R-214: said before the passphrase is chosen, not after. */}
        <p style={{ font: 'var(--type-body-ui)', color: 'var(--ink)', margin: 0 }}>
          Pando takes a full backup first. It doesn't keep this passphrase. Without it, the backup can't be
          restored.
        </p>
        <Input
          label="Backup passphrase"
          type="password"
          autoComplete="new-password"
          disabled={skip}
          value={passphrase}
          helper={`At least ${MIN_PASSPHRASE} characters.`}
          onChange={(e) => setPassphrase(e.target.value)}
        />
        <Checkbox
          label="Upgrade without a backup"
          description="Pando still keeps a database copy to roll back to if the new version doesn't start."
          checked={skip}
          onChange={(e) => setSkip(e.target.checked)}
        />
        {start.isError && <Banner tone="failed">{messageOf(start.error)}</Banner>}
      </div>
    </Dialog>
  );
}

const STATES: Record<string, string> = {
  running: 'Under way',
  succeeded: 'Upgraded',
  rolled_back: 'Rolled back',
  failed: 'Failed',
};

/**
 * The last upgrade (R-356, R-359). While one is under way Pando restarts, so
 * this keeps asking until the answer is the outcome; a request that fails in
 * between is Pando being down, not an error to show.
 */
function LastUpgrade() {
  const last = useQuery({
    queryKey: ['upgrade-last'],
    queryFn: () => api.get<{ upgrade: Attempt | null }>('/upgrade/last'),
    retry: false,
    refetchInterval: (q) => (q.state.data?.upgrade?.state === 'running' || q.state.error ? 5_000 : false),
  });
  const a = last.data?.upgrade;
  if (!a) return null;
  if (a.state === 'succeeded' && a.finished_at && Date.now() - Date.parse(a.finished_at) > 24 * 60 * 60 * 1000) {
    return null;
  }

  if (a.state === 'running') {
    return (
      <Banner tone="running">
        Upgrading from {a.from} to {a.to}. Apps are unreachable while Pando restarts.
      </Banner>
    );
  }
  if (a.state === 'succeeded') {
    return (
      <Banner tone="info">
        {STATES[a.state]} from {a.from} to {a.to} {a.finished_at ? relative(a.finished_at) : ''}.
        {a.reason ? ` ${a.reason}` : ''}
      </Banner>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <Banner tone="failed">
        {STATES[a.state]}: {a.reason}
      </Banner>
      {a.logs && <CodeBlock title={`Logs from ${a.to}`} lines={a.logs.trimEnd()} dense />}
    </div>
  );
}
