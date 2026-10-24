// The admin apps list's cells, and the block each row becomes at phone width.

import { StatusIndicator, Tooltip } from '@design';

import type { App } from '@api/types.gen';
import { ScoreBadge } from '../ui/ScoreBadge';
import { TipButton } from '../ui/TipButton';
import { statusLabel, statusSymbol } from '../ui/status';
import { relative } from '../ui/time';
import { NameCell } from './NameCell';
import { AWAITING_IMAGE } from './scanScope';
import { accessLabel, accessMeaning } from './share-access';

/** The app's status in words, as its filter offers it. */
export function rowStatus(row: App): string {
  return statusLabel(row.state, row.stopped_for_idle, row.stopped_for_disk, row.stopped_for_orphan);
}

/** How many notices the reader has not ignored (R-412), or nothing for none. */
export function noticesLabel(count: number | undefined): string {
  if (!count) return '';
  return count === 1 ? '1 notice' : `${count} notices`;
}

const noticeStyle = { font: 'var(--type-caption)', color: 'var(--contour-text)' };

/** The status, symbol and word, and under it — beside it at phone width —
 *  how many notices the app has for the reader. */
export function StatusCell({ row, inline = false }: Readonly<{ row: App; inline?: boolean }>) {
  const notices = noticesLabel(row.notice_count);
  return (
    <span
      style={{
        display: 'flex',
        flexDirection: inline ? 'row' : 'column',
        alignItems: inline ? 'center' : 'flex-start',
        flexWrap: 'wrap',
        gap: inline ? 'var(--space-1)' : 0,
      }}
    >
      <StatusIndicator status={statusSymbol(row.state)} label={rowStatus(row)} />
      {notices && <span style={noticeStyle}>{inline ? `· ${notices}` : notices}</span>}
    </span>
  );
}

/** The apps list's security column, as a value its filter offers. */
export function securityFilterValue(row: App): string {
  if (row.security_scanning) return 'Scanning';
  if (row.security_awaiting_image) return 'Not scored yet';
  if (row.security_score == null) return 'Not scanned';
  return row.security_verdict === 'insecure' ? 'Below minimum' : 'Scanned';
}

/** The apps list's security column: the score, colored by what it means. */
export function SecurityCell({ row }: Readonly<{ row: App }>) {
  // A scan under way, whoever started it, as the design system's building
  // status: the hollow ring, which does not move.
  if (row.security_scanning) return <StatusIndicator status="building" label="Scanning" />;
  if (row.security_awaiting_image) {
    // Its source was scanned and nothing has been built: that number is the
    // source's, not the app's (R-311).
    return (
      <Tooltip content={`${AWAITING_IMAGE}.`}>
        <span style={{ font: 'var(--type-code-sm)', color: 'var(--ink-secondary)' }}>Not scored yet</span>
      </Tooltip>
    );
  }
  return <ScoreBadge score={row.security_score} verdict={row.security_verdict as never} />;
}

/** Who can open it, as a button whose tip says what that means (R-077). Its
 *  click stops there: asking what a label means is not opening the app. */
export function AccessCell({ row }: Readonly<{ row: App }>) {
  return (
    <TipButton
      tip={accessMeaning(row.access)}
      label={`${accessLabel(row.access)}: ${accessMeaning(row.access)}`}
      onClick={(e) => e.stopPropagation()}
    >
      {accessLabel(row.access)}
    </TipButton>
  );
}

export function UpdatedCell({ row }: Readonly<{ row: App }>) {
  return (
    <Tooltip content={row.updated_at}>
      <span>{relative(row.updated_at)}</span>
    </Tooltip>
  );
}

/**
 * A row at phone width: tile, name and address; then status and notices
 * left, score right; then access left, updated right. The owner is left out —
 * the Owner filter still narrows by it.
 */
export function StackedAppRow({ row }: Readonly<{ row: App }>) {
  const end = { justifySelf: 'end' } as const;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) auto',
        alignItems: 'center',
        gap: 'var(--space-2) var(--space-3)',
        padding: 'var(--space-3) 0',
        whiteSpace: 'normal',
      }}
    >
      <div style={{ gridColumn: '1 / -1', minWidth: 0 }}>
        <NameCell row={row} />
      </div>
      <StatusCell row={row} inline />
      <div style={end}>
        <SecurityCell row={row} />
      </div>
      <div>
        <AccessCell row={row} />
      </div>
      <div style={{ ...end, font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>
        <UpdatedCell row={row} />
      </div>
    </div>
  );
}
