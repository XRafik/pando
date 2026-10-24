// @vitest-environment jsdom
// The admin apps list's cells: the tile beside the name, the notices beside
// the status (R-412), and the block a row becomes at phone width.

import { describe, expect, it } from 'vitest';

import type { App } from '@api/types.gen';
import { serverRender } from '../ui/testing';
import { gridColumns } from '../launcher/Launcher';
import { NameCell } from './NameCell';
import { SecurityCell, StackedAppRow, StatusCell, noticesLabel, rowStatus, securityFilterValue } from './AppListCells';

const app = (a: Partial<App>): App => ({
  id: 'app_1',
  name: 'Field notes',
  slug: 'field-notes',
  owner_user_id: 'usr_1',
  state: 'running',
  desired_state: 'running',
  source: { type: 'git' } as App['source'],
  created_at: '2026-10-17T00:00:00Z',
  updated_at: '2026-10-17T00:00:00Z',
  ...a,
});

describe('the name cell', () => {
  it('puts the app’s tile beside its name', () => {
    const html = serverRender(<NameCell row={app({ icon_updated_at: '2026-10-20T00:00:00Z' })} />);
    expect(html).toContain('/apps/app_1/icon?v=');
    expect(html.indexOf('/icon')).toBeLessThan(html.indexOf('Field notes'));
  });
});

// R-412: the list says how many notices the reader has not ignored.
describe('notices beside the status', () => {
  it('count one or many, and say nothing for none', () => {
    expect(noticesLabel(undefined)).toBe('');
    expect(noticesLabel(0)).toBe('');
    expect(noticesLabel(1)).toBe('1 notice');
    expect(noticesLabel(3)).toBe('3 notices');
  });

  it('sit under the status in contour brown, and beside it at phone width', () => {
    const under = serverRender(<StatusCell row={app({ notice_count: 2 })} />);
    expect(under).toContain('Running');
    expect(under).toContain('2 notices');
    expect(under).toContain('var(--contour-text)');
    expect(serverRender(<StatusCell row={app({ notice_count: 2 })} inline />)).toContain('· 2 notices');
    expect(serverRender(<StatusCell row={app({})} />)).not.toContain('notice');
  });
});

describe('filter values', () => {
  it('name the status and the security standing in words', () => {
    expect(rowStatus(app({ state: 'failed' }))).toBe('Failed');
    expect(securityFilterValue(app({ security_scanning: true }))).toBe('Scanning');
    expect(securityFilterValue(app({ security_awaiting_image: true }))).toBe('Not scored yet');
    expect(securityFilterValue(app({}))).toBe('Not scanned');
    expect(securityFilterValue(app({ security_score: 40, security_verdict: 'insecure' }))).toBe('Below minimum');
    expect(securityFilterValue(app({ security_score: 90, security_verdict: 'ok' }))).toBe('Scanned');
    expect(serverRender(<SecurityCell row={app({ security_scanning: true })} />)).toContain('Scanning');
    expect(serverRender(<SecurityCell row={app({ security_awaiting_image: true })} />)).toContain('Not scored yet');
  });
});

describe('a row at phone width', () => {
  it('holds the name, status, score, access and when it changed, and not the owner', () => {
    const html = serverRender(
      <StackedAppRow row={app({ notice_count: 1, security_score: 92, access: 'private', owner_name: 'Ada Lovelace' })} />,
    );
    for (const s of ['Field notes', 'Running', '· 1 notice', '92', 'Private']) expect(html).toContain(s);
    expect(html).not.toContain('Ada Lovelace');
  });
});

describe('the launcher grid', () => {
  it('keeps fixed tracks on a wide window and shares the width on a phone', () => {
    expect(gridColumns(false)).toBe('repeat(auto-fill, 16ch)');
    expect(gridColumns(true)).toContain('1fr');
  });
});
