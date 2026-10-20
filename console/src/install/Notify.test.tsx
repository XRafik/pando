// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  ConnectNotifyDialog,
  connectable,
  needsConnecting,
  NotifyStatus,
  SlackLogoDialog,
  type NotifyAdapter,
} from './Notify';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const slack: NotifyAdapter = {
  id: 'ntf_slack',
  name: 'Slack',
  kind: 'slack',
  capabilities: { audience: 'channel', channels: true, web_authorization: true, manual_authorization: true },
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root!.render(<QueryClientProvider client={queries}>{node}</QueryClientProvider>));
}

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent === text);
  expect(found, `a button "${text}"`).toBeDefined();
  return found!;
}

async function press(text: string) {
  await act(async () => {
    button(text).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function type(label: string, value: string) {
  const input = document.getElementById('f-' + label.replace(/\W+/g, '-').toLowerCase()) as HTMLInputElement | null;
  expect(input, `an input "${label}"`).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('connecting Slack, R-374', () => {
  it('takes a configuration token and goes to Slack to approve, over https', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...globalThis.location, protocol: 'https:', assign });
    const fetch = vi.fn(async () => reply(200, { mode: 'web', authorize_url: 'https://slack.com/oauth/v2/authorize?state=s' }));
    vi.stubGlobal('fetch', fetch);

    render(<ConnectNotifyDialog adapter={slack} https onClose={() => undefined} onConnected={() => undefined} />);
    expect(button('Continue to Slack').disabled).toBe(true);
    type('Configuration token', 'xoxe-1');
    await press('Continue to Slack');

    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toContain('/notify/ntf_slack/authorize');
    expect(JSON.parse(String(init.body))).toEqual({ mode: 'web', token: 'xoxe-1' });
    expect(assign).toHaveBeenCalledWith('https://slack.com/oauth/v2/authorize?state=s');
  });

  it('is made by hand without https: a link to create the app, then its bot token', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onConnected = vi.fn();
    const fetch = vi.fn(async (_path: string, init?: RequestInit) =>
      JSON.parse(String(init?.body)).token
        ? reply(200, { status: 'authorized' })
        : reply(200, { mode: 'manual', authorize_url: 'https://api.slack.com/apps?new_app=1' }),
    );
    vi.stubGlobal('fetch', fetch);

    render(<ConnectNotifyDialog adapter={slack} https={false} onClose={() => undefined} onConnected={onConnected} />);
    expect(document.body.textContent).not.toContain('Configuration token');
    await press('Create the app in Slack');
    expect(open).toHaveBeenCalledWith('https://api.slack.com/apps?new_app=1', '_blank', 'noopener,noreferrer');

    type('Bot token', 'xoxb-1');
    await press('Connect');
    const [, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ mode: 'manual', token: 'xoxb-1' });
    expect(onConnected).toHaveBeenCalled();
  });

  it('says what Slack refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(400, { code: 'VALID_INVALID', message: 'Slack did not accept the configuration token.' })));
    render(<ConnectNotifyDialog adapter={slack} https onClose={() => undefined} onConnected={() => undefined} />);
    type('Configuration token', 'xoxe-bad');
    await press('Continue to Slack');
    expect(document.body.textContent).toContain('Slack did not accept the configuration token.');
  });
});

describe('a notification adapter’s state', () => {
  it('needs connecting until Slack is connected, and never for one the file declares', () => {
    expect(needsConnecting(slack)).toBe(true);
    expect(needsConnecting({ ...slack, capabilities: { ...slack.capabilities, authorized: true } })).toBe(false);
    expect(needsConnecting({ ...slack, declared: true })).toBe(false);
    expect(connectable({ ...slack, capabilities: { audience: 'people', authorized: true } })).toBe(false);
  });

  it('reads as ready, not connected, or why not', () => {
    render(
      <>
        <NotifyStatus adapter={slack} />
        <NotifyStatus adapter={{ ...slack, capabilities: { ...slack.capabilities, authorized: true } }} />
        <NotifyStatus adapter={{ ...slack, problem: 'refused' }} />
      </>,
    );
    expect(document.body.textContent).toContain('Not connected');
    expect(document.body.textContent).toContain('Ready');
    expect(document.body.textContent).toContain('Cannot be used');
  });

  it('offers Slack the 1024-pixel icon when Pando could not set it', () => {
    render(
      <SlackLogoDialog
        adapter={{ ...slack, capabilities: { ...slack.capabilities, authorized: true, manage_url: 'https://api.slack.com/apps/A1/general' } }}
        onClose={() => undefined}
      />,
    );
    const download = [...document.body.querySelectorAll('a')].find((a) => a.textContent === 'Download the logo');
    expect(download?.getAttribute('href')).toMatch(/pando-app-icon\.png$/);
    expect(document.body.textContent).toContain('Basic Information');
  });
});
