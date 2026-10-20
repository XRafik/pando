// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { Identities } from './Identities';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let posts: Record<string, unknown>[];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://pando.test');
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        if (!body.confirm) {
          return json(400, {
            code: 'VALID_INVALID',
            message: 'Moving this identity suspends account usr_old, the last active owner of wiki.',
            remedy: 'Give this account Owner on them first, or link the identity again with confirm set.',
            details: { orphaned_apps: ['wiki'] },
          });
        }
        return json(201, { aliased_user_id: 'usr_old' });
      }
      if (url.pathname.endsWith('/identity-providers')) {
        return json(200, { providers: [{ id: 'idp_okta', name: 'Okta', kind: 'oidc' }] });
      }
      return json(200, { identities: [] });
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
const button = (within: ParentNode, text: string) =>
  [...within.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// R-408: linking that would suspend an app's last active owner says which
// apps, and goes ahead only when asked again.
describe('linking away the last owner of an app', () => {
  it('names the apps, then links anyway with confirm', async () => {
    root = createRoot(host);
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Identities userID="usr_new" manage />
        </QueryClientProvider>,
      ),
    );
    await settle();
    await act(async () => button(host, 'Link identity').click());
    await settle();

    const external = [...dialog().querySelectorAll('input')].find((i) => i.type !== 'checkbox')!;
    act(() => type(external, '00u1'));
    await act(async () => button(dialog(), 'Link identity').click());
    await settle();

    expect(posts).toHaveLength(1);
    expect(posts[0]?.confirm).toBe(false);
    expect(dialog().textContent).toContain('the last active owner of wiki');
    expect(dialog().textContent).not.toContain('confirm set');

    // Editing the identity withdraws the warning: it was about the old one.
    act(() => type(external, '00u2'));
    expect(button(dialog(), 'Link anyway')).toBeUndefined();
    act(() => type(external, '00u1'));
    await act(async () => button(dialog(), 'Link identity').click());
    await settle();
    expect(posts).toHaveLength(2);
    expect(posts[1]?.confirm).toBe(false);

    await act(async () => button(dialog(), 'Link anyway').click());
    await settle();
    expect(posts).toHaveLength(3);
    expect(posts[2]?.confirm).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
