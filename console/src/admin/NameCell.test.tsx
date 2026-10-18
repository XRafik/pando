// @vitest-environment jsdom
// The apps list's Name cell and Access column (discussion #262): where each
// app is, and who can open it, "Public" always with its consequence (R-077).

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import type { App } from '@api/types.gen';
import { serverRender } from '../ui/testing';
import { shown } from './AppAddress';
import { NameCell } from './NameCell';
import { accessLabel, accessMeaning } from './share-access';

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

describe('NameCell', () => {
  it('puts the address under the name, as a link that opens in its own tab', () => {
    const html = serverRender(<NameCell row={app({ address: 'https://notes.example.com/' })} />);
    expect(html).toContain('Field notes');
    expect(html).toContain('href="https://notes.example.com/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('>notes.example.com<');
  });

  it('says an app with no address has not been deployed', () => {
    expect(serverRender(<NameCell row={app({})} />)).toContain('Not deployed yet');
  });

  it('keeps a click on the address from opening the app in the console as well', () => {
    // The design Table's row is a React onClick around the cell.
    const host = document.createElement('div');
    const row = vi.fn();
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <div onClick={row}>
          <NameCell row={app({ address: 'https://notes.example.com/' })} />
        </div>,
      ),
    );
    const link = host.querySelector('a')!;
    link.addEventListener('click', (e) => e.preventDefault());
    act(() => link.click());
    expect(row).not.toHaveBeenCalled();
    act(() => root.unmount());
    host.remove();
  });
});

describe('shown', () => {
  it('drops the scheme and a closing slash', () => {
    expect(shown('https://notes.example.com/')).toBe('notes.example.com');
    expect(shown('//host:8080/')).toBe('host:8080');
    expect(shown('/notes/')).toBe('/notes');
    expect(shown('/')).toBe('/');
  });
});

describe('accessLabel', () => {
  it('names each kind of access in a word or two, with what it means beside it', () => {
    expect(accessLabel('private')).toBe('Private');
    expect(accessLabel('shared')).toBe('Private – shared');
    expect(accessLabel('public')).toBe('Public');
    expect(accessLabel('passcode')).toBe('Public with passcode');
    expect(accessLabel(undefined)).toBe('');
    expect(accessMeaning(undefined)).toBe('');
  });

  it('never leaves "Public" without its consequence (R-077)', () => {
    for (const a of ['public', 'passcode']) expect(accessMeaning(a)).toContain('Anyone on the internet');
  });
});
