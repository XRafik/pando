// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { answering, mount, type Mounted, type Seed } from '../ui/testing';
import { Installation } from './Installation';
import type { AdapterKind } from './adapters';

// A Slack adapter on the Adapters screen (R-374): whether it is connected,
// connecting it, and the icon left to upload when Pando could not set it.

const slackKind: AdapterKind = {
  category: 'notify',
  kind: 'slack',
  name: 'Slack',
  description: 'Posts the events a subscription chooses.',
  id_prefix: 'ntf_',
  fields: [{ key: 'timeout_seconds', label: 'Timeout', type: 'int', advanced: true, default: '10' }],
};
const slackRow = { id: 'ntf_slack', category: 'notify', kind: 'slack', name: 'Slack', is_default: false, healthy: true };
const slack = (caps: object) => ({
  id: 'ntf_slack',
  name: 'Slack',
  kind: 'slack',
  capabilities: { audience: 'channel', channels: true, web_authorization: true, manual_authorization: true, ...caps },
});

const seed = (notify: object[]): Seed => [
  [['me'], { verbs: ['install.adapters.manage'] }],
  [['adapters'], { adapters: [slackRow] }],
  [['adapter-kinds'], { kinds: [slackKind] }],
  [['sources'], { sources: [] }],
  [['notify'], { adapters: notify }],
];

let screen: Mounted | undefined;

afterEach(() => {
  screen?.unmount();
  screen = undefined;
  vi.unstubAllGlobals();
});

describe('a Slack adapter on the Adapters screen', () => {
  it('reads as not connected, and Connect opens its connection', async () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<Installation />, seed([slack({})]));
    expect(screen.text()).toContain('Not connected');
    await screen.press('Connect');
    expect(screen.text()).toContain('Connect Slack');
  });

  it('reads as ready once connected, and offers to connect again', () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(<Installation />, seed([slack({ authorized: true, icon_set: true })]));
    expect(screen.text()).toContain('Ready');
    expect(screen.text()).toContain('Connect again');
  });

  it('offers the icon to upload on returning from Slack, when Pando could not set it', () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(
      <Installation query="authorized=ntf_slack" />,
      seed([slack({ authorized: true, icon_set: false, manage_url: 'https://api.slack.com/apps/A1/general' })]),
    );
    expect(screen.text()).toContain("Add Pando's logo to the app");
  });

  it('asks for nothing more when Slack took the icon', () => {
    vi.stubGlobal('fetch', answering({}));
    screen = mount(
      <Installation query="authorized=ntf_slack" />,
      seed([slack({ authorized: true, icon_set: true, manage_url: 'https://api.slack.com/apps/A1/general' })]),
    );
    expect(screen.text()).not.toContain("Add Pando's logo");
    expect(screen.text()).toContain('ntf_slack is authorized and ready.');
  });
});
