// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@api/types.gen';
import { CodeBlock } from '@design';
import { SignIn } from './SignIn';
import { CopyInline } from '../ui/CopyField';
import { answering, mount, reply } from '../ui/testing';
import type { Mounted } from '../ui/testing';

const base = 'https://pando.example.com/api/v1/auth/providers/idp_okta';

const okta: ProviderView = {
  id: 'idp_okta',
  kind: 'oidc',
  name: 'Okta',
  config: {},
  enabled: false,
  jit_provisioning: false,
  link_by_email: false,
  scim_enabled: false,
  scim_identity_attribute: 'externalId',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  credentials: [],
  callback_url: `${base}/callback`,
  login_url: `${base}/start`,
  scim_base_url: 'https://pando.example.com/api/v1/scim/v2',
};

const local: ProviderView = { ...okta, id: 'idp_local', kind: 'local', name: 'Pando accounts', enabled: true, callback_url: undefined, login_url: undefined };

let screen: Mounted | undefined;
afterEach(() => {
  screen?.unmount();
  screen = undefined;
  vi.unstubAllGlobals();
});

function clipboard() {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  return writeText;
}

async function pressLabeled(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, label).not.toBeNull();
  await act(async () => {
    button!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function show(providers: ProviderView[], canManagePolicy = false) {
  screen = mount(<SignIn canEdit canManagePolicy={canManagePolicy} onClearTest={() => undefined} />, [
    [['identity-providers'], { providers, kinds: [] }],
    [['policy'], {}],
  ]);
  return screen;
}

describe('an identity provider card', () => {
  it('gives each address its own field, and Copy takes only the value', async () => {
    const writeText = clipboard();
    const s = show([okta]);
    expect(s.text()).toContain('Redirect URI');
    expect(s.text()).toContain('Initiate login URI');
    await pressLabeled('Copy Initiate login URI');
    expect(writeText).toHaveBeenCalledWith(`${base}/start`);
    await pressLabeled('Copy Redirect URI');
    expect(writeText).toHaveBeenLastCalledWith(`${base}/callback`);
    expect(document.querySelector('button[aria-label="Copied"]')).not.toBeNull();
  });

  it('selects the value where the browser will not copy', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const s = show([okta]);
    await pressLabeled('Copy Redirect URI');
    expect(s.text()).toContain('Your browser blocked copying.');
    expect(String(window.getSelection())).toBe(`${base}/callback`);
  });

  it('is turned on and off with a switch that says which it is', async () => {
    const fetch = vi.fn(async () => reply({}));
    vi.stubGlobal('fetch', fetch);
    show([okta]);
    const toggle = document.querySelector<HTMLInputElement>('input[role="switch"][aria-label="Okta sign-in"]')!;
    expect(toggle.checked).toBe(false);
    expect(toggle.closest('label')?.textContent).toBe('Off');
    await act(async () => {
      toggle.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/identity-providers/idp_okta');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
  });

  it('turns password sign-in off with a switch for a policy manager', () => {
    show([local], true);
    const toggle = document.querySelector<HTMLInputElement>('input[role="switch"][aria-label="Pando accounts sign-in"]')!;
    expect(toggle.checked).toBe(true);
    expect(toggle.closest('label')?.textContent).toBe('On');
  });

  it('shows a word and a symbol, without a switch, to someone who cannot change it', () => {
    screen = mount(<SignIn canEdit={false} onClearTest={() => undefined} />, [
      [['identity-providers'], { providers: [{ ...okta, enabled: true }], kinds: [] }],
      [['policy'], {}],
    ]);
    expect(document.querySelector('input[role="switch"]')).toBeNull();
    expect(screen.text()).toContain('On');
  });
});

/** Answers the token request, and the listing asked again after it. */
const scim = (providers: ProviderView[]) =>
  answering({
    'scim-token': { token: 'pando_scim_abc', scim_base_url: okta.scim_base_url },
    'identity-providers': { providers, kinds: [] },
  });

describe('turning on SCIM', () => {
  it('says how to set it up, and each value copies alone', async () => {
    const writeText = clipboard();
    vi.stubGlobal('fetch', vi.fn(scim([okta])));
    const s = show([okta]);
    await s.press('Turn on SCIM');
    expect(s.text()).toContain('Set up SCIM');
    expect(s.text()).toContain('turn on SCIM provisioning');
    expect(s.text()).toContain('Pando matches people by externalId.');
    expect(s.text()).toContain('SCIM requests fail while this provider is off.');
    await pressLabeled('Copy Token');
    expect(writeText).toHaveBeenCalledWith('pando_scim_abc');
    await pressLabeled('Copy SCIM base URL');
    expect(writeText).toHaveBeenLastCalledWith(okta.scim_base_url);
  });

  it('says nothing about the provider being off when it is on', async () => {
    const on = { ...okta, enabled: true, scim_identity_attribute: 'userName' };
    vi.stubGlobal('fetch', vi.fn(scim([on])));
    const s = show([on]);
    await s.press('Turn on SCIM');
    expect(s.text()).not.toContain('SCIM requests fail');
    expect(s.text()).not.toContain('objectId');
  });
});

describe('copying', () => {
  it('copies a code block’s lines, not just says so', async () => {
    const writeText = clipboard();
    screen = mount(<CodeBlock lines={['pando login', { text: 'pando apps' }]} />);
    await pressLabeled('Copy');
    expect(writeText).toHaveBeenCalledWith('pando login\npando apps');
    expect(screen.text()).toContain('Copied');
  });

  it('selects a code block where the browser will not copy', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    screen = mount(<CodeBlock lines={['pando login']} />);
    await pressLabeled('Copy');
    expect(screen.text()).toContain('Selected');
    expect(String(window.getSelection())).toBe('pando login');
  });

  it('copies a value inside a step', async () => {
    const writeText = clipboard();
    screen = mount(<CopyInline value={`${base}/callback`} />);
    await pressLabeled('Copy');
    expect(writeText).toHaveBeenCalledWith(`${base}/callback`);
    expect(document.querySelector('button[aria-label="Copied"]')).not.toBeNull();
  });
});
