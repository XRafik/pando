// System's Overview: Pando itself, how much room each runtime has, and the
// settings Pando read when it started — the three things about the
// installation that are too small to be pages of their own.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Tag } from '@design';

import { api } from '@api/client';
import { InstallVerb, useInstallVerb } from '../app/principal';
import { TipButton } from '../ui/TipButton';
import { useNarrow } from '../ui/narrow';
import { Capacity } from './Capacity';
import { PandoCard, SystemCard } from './Updates';
import { RestartButton } from './Restart';
import type { AdapterKind } from './adapters';
import type { ConfiguredAdapter } from './AdapterDialog';
import type { Source, StartupConfig } from './policyDraft';

export function Overview({ settings }: Readonly<{ settings?: React.ReactNode }>) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div className="pando-two">
        <PandoCard settings={settings} />
        <Capacity names={useRuntimeNames()} />
      </div>
      <StartupSettings />
    </div>
  );
}

/** Each runtime by the name its kind goes by, as on Adapters. */
function useRuntimeNames(): Record<string, string> {
  const adapters = useQuery({
    queryKey: ['adapters'],
    queryFn: () => api.get<{ adapters: ConfiguredAdapter[] | null }>('/adapters'),
  });
  const kinds = useQuery({
    queryKey: ['adapter-kinds'],
    queryFn: () => api.get<{ kinds: AdapterKind[] | null }>('/adapters/kinds'),
  });
  const rows = adapters.data && !Array.isArray(adapters.data) ? (adapters.data.adapters ?? []) : [];
  const catalog = kinds.data?.kinds ?? [];
  return Object.fromEntries(
    rows.map((r) => [r.id, r.name || catalog.find((k) => k.category === r.category && k.kind === r.kind)?.name || r.kind]),
  );
}

/**
 * The startup settings by area, in the order someone setting Pando up meets
 * them. A key not listed falls into its prefix's area, or Other, so a new
 * setting is never missing from the table — only, until it is listed here,
 * from the right place in it.
 */
const SETTING_AREAS: Array<{ name: string; prefix?: string; keys: string[] }> = [
  { name: 'Server', keys: ['server.addr', 'server.work_dir', 'server.shutdown_timeout'] },
  {
    name: 'Public addresses',
    keys: ['server.external_url', 'server.base_domain', 'server.issuer', 'server.proxy_upstream'],
  },
  { name: 'Routing', keys: ['server.routing_mode', 'server.port_range_start', 'server.port_range_end'] },
  { name: 'Database', prefix: 'database.', keys: ['database.connect_timeout'] },
  { name: 'App defaults', prefix: 'apps.', keys: ['apps.cpu_millis', 'apps.memory_bytes', 'apps.disk_bytes'] },
  {
    name: 'Reconciler',
    prefix: 'reconciler.',
    keys: ['reconciler.backoff', 'reconciler.failure_threshold', 'reconciler.failure_window', 'reconciler.gc_interval'],
  },
  {
    name: 'Background work',
    prefix: 'work.',
    keys: ['work.deploys', 'work.detections', 'work.backups', 'work.auto_deploy'],
  },
  { name: 'Retention', prefix: 'retention.', keys: [] },
  { name: 'Logging', prefix: 'log.', keys: ['log.level', 'log.development'] },
];

/** Where in SETTING_AREAS a key goes: its area's index, and its place in it. */
export function settingArea(key: string): { area: string; rank: number } {
  for (const [i, a] of SETTING_AREAS.entries()) {
    const at = a.keys.indexOf(key);
    if (at >= 0) return { area: a.name, rank: i * 100 + at };
  }
  for (const [i, a] of SETTING_AREAS.entries()) {
    if (a.prefix && key.startsWith(a.prefix)) return { area: a.name, rank: i * 100 + 99 };
  }
  return { area: 'Other', rank: SETTING_AREAS.length * 100 };
}

const STARTUP_GRID = 'minmax(0,3fr) minmax(0,2fr) minmax(12ch,1fr)';

/**
 * Every other setting Pando started with — the ones that are not policy and
 * that no screen edits — grouped by area, with its value and where it came
 * from. Collapsed: read once at startup, and looked at rarely. A secret is
 * never shown (R-194): the server sends it redacted, or not at all.
 */
function StartupSettings() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.get<StartupConfig>('/config') });
  const [open, setOpen] = useState(false);
  const c = config.data;
  if (!c) return null;
  const set = c.settings.filter((r) => r.source.kind !== 'default').length;
  return (
    <SystemCard
      heading={
        <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          Startup settings{' '}
          <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>
            {set === 0
              ? 'Read once when Pando starts. Every setting is at its default.'
              : `Read once when Pando starts. ${set} of ${c.settings.length} are set; the rest are defaults.`}
          </span>
        </span>
      }
      action={
        <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'}
        </Button>
      }
    >
      {open && <StartupTable config={c} />}
    </SystemCard>
  );
}

function StartupTable({ config }: Readonly<{ config: StartupConfig }>) {
  // POST /restart's verb: the same restart applies a saved adapter.
  const canRestart = useInstallVerb(InstallVerb.AdaptersManage);
  // At phone width a row stacks — the setting on its own line, its value and
  // source under it — rather than scrolling sideways.
  const narrow = useNarrow();
  const rows = config.settings
    .map((s) => ({ ...s, ...settingArea(s.key) }))
    .sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
  const code = { font: 'var(--type-code-sm)' } as const;
  const line = {
    display: 'grid',
    gridTemplateColumns: narrow ? 'minmax(0,1fr) auto' : STARTUP_GRID,
    alignItems: 'center',
    gap: narrow ? 'var(--space-1) var(--space-3)' : 'var(--space-4)',
    padding: narrow ? 'var(--space-2) 0' : '0 var(--space-3)',
  } as const;

  return (
    <>
      <div role="table" aria-label="Startup settings">
        <div
          role="row"
          style={{
            ...line,
            display: narrow ? 'none' : 'grid',
            minHeight: 'var(--control-console)',
            background: 'var(--paper-sunken)',
            borderBottom: 'var(--border-width) solid var(--rule)',
          }}
        >
          {['Setting', 'Value', 'Set in'].map((h) => (
            <span key={h} role="columnheader" style={{ font: 'var(--type-label)', color: 'var(--ink-secondary)' }}>
              {h}
            </span>
          ))}
        </div>
        {rows.map((row, i) => {
          const isDefault = row.source.kind === 'default';
          const empty = row.value === '' || row.value === null || row.value === undefined;
          return (
            <div key={row.key} role="rowgroup">
              {rows[i - 1]?.area !== row.area && (
                <div
                  role="row"
                  style={{
                    padding: 'var(--space-4) var(--space-3) var(--space-1)',
                    font: 'var(--type-caption)',
                    color: 'var(--ink-secondary)',
                    borderBottom: 'var(--border-width) solid var(--rule)',
                  }}
                >
                  {row.area}
                </div>
              )}
              <div role="row" style={{ ...line, minHeight: 'var(--row-height)', borderBottom: 'var(--border-width) solid var(--rule)' }}>
                <span role="cell" style={{ ...code, color: 'var(--ink)', overflowWrap: 'anywhere', gridColumn: narrow ? '1 / -1' : undefined }}>
                  {row.key}
                </span>
                <span role="cell" style={{ ...code, color: isDefault ? 'var(--ink-secondary)' : 'var(--ink)', overflowWrap: 'anywhere' }}>
                  {empty ? '—' : String(row.value)}
                </span>
                <span role="cell">
                  <SetBy source={row.source} env={row.env} />
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* How to change one. The Compose command stays in plain sight: a
          restart keeps the old environment, and that is the mistake people
          make. */}
      <p style={{ margin: 0, font: 'var(--type-body-ui)', color: 'var(--ink-secondary)' }}>
        Set a value at its source and restart Pando. With Docker Compose, set <code style={code}>PANDO_…</code> under{' '}
        <code style={code}>environment:</code> and run <code style={code}>docker compose up -d pando</code>;{' '}
        <code style={code}>docker compose restart</code> keeps the old environment.{' '}
        {config.file ? (
          <>
            Config file: <code style={code}>{config.file}</code>.
          </>
        ) : (
          <>No config file is in use.</>
        )}
      </p>
      {canRestart && (
        <div>
          <RestartButton />
        </div>
      )}
    </>
  );
}

/** Where a setting came from, as a tag; the exact variable or file on hover
 *  or focus. A default is plain words, quieter than a tag. */
function SetBy({ source, env }: Readonly<{ source: Source; env: string }>) {
  if (source.kind === 'default') {
    return (
      <TipButton
        tip={`Not set. Set ${env} to change it.`}
        label={`Default: not set. Set ${env} to change it.`}
        style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}
      >
        Default
      </TipButton>
    );
  }
  let exact = source.name ?? env;
  if (source.kind !== 'env') {
    const at = source.key ? `, at ${source.key}` : '';
    exact = `${source.name ?? 'the config file'}${at}`;
  }
  return (
    <TipButton tip={exact} label={`${source.kind === 'env' ? 'Environment' : 'Config file'}: ${exact}`}>
      <Tag tone="contour">{source.kind === 'env' ? 'Environment' : 'Config file'}</Tag>
    </TipButton>
  );
}
