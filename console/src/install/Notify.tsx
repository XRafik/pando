// Notification adapters that connect to their provider (R-374): Slack, as
// Pando's own Slack app, which posts to the channel each subscription chooses.
//
// The adapter is added on the Adapters screen like any other; what is
// particular to one is here: its state from GET /notify, connecting it through
// POST /notify/{id}/authorize, and the channels GET /notify/{id}/channels lists
// for a subscription to choose from (R-261).

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Banner, Button, Dialog, Input, StatusIndicator } from '@design';

import { api } from '@api/client';
import { refusal } from './Accounts';
import { AppLogoDialog } from './Sources';
import slackIcon from './pando-app-icon.png';

/** A notification adapter, as GET /notify returns it. */
export interface NotifyAdapter {
  id: string;
  name: string;
  kind: string;
  declared?: boolean;
  problem?: string;
  capabilities: {
    audience: 'people' | 'channel';
    channels?: boolean;
    web_authorization?: boolean;
    manual_authorization?: boolean;
    authorized?: boolean;
    manage_url?: string;
    icon_set?: boolean;
  };
}

/** One channel a subscription can post to. */
export interface NotifyChannel {
  id: string;
  name: string;
  private?: boolean;
}

export function useNotifyAdapters(enabled = true) {
  return useQuery({
    queryKey: ['notify'],
    queryFn: () => api.get<{ adapters: NotifyAdapter[] | null }>('/notify'),
    enabled,
  });
}

export function useNotifyChannels(adapterID: string, enabled = true) {
  return useQuery({
    queryKey: ['notify-channels', adapterID],
    queryFn: () => api.get<{ channels: NotifyChannel[] }>(`/notify/${encodeURIComponent(adapterID)}/channels`),
    enabled: enabled && adapterID !== '',
  });
}

/** Connects, and is not connected yet. */
export function needsConnecting(a: NotifyAdapter): boolean {
  const c = a.capabilities;
  return !a.problem && !a.declared && !c.authorized && Boolean(c.web_authorization || c.manual_authorization);
}

/** Can be connected from here. */
export function connectable(a: NotifyAdapter): boolean {
  const c = a.capabilities;
  return !a.declared && Boolean(c.web_authorization || c.manual_authorization);
}

/** Whether the adapter can send now. */
export function NotifyStatus({ adapter }: Readonly<{ adapter: NotifyAdapter }>) {
  if (adapter.problem) return <StatusIndicator status="failed" label="Cannot be used" title={adapter.problem} />;
  if (connectable(adapter) && !adapter.capabilities.authorized) {
    return <StatusIndicator status="info" label="Not connected" />;
  }
  return <StatusIndicator status="running" label="Ready" />;
}

/** Slack sends a browser back only to https, so a Pando reached over http
 *  connects by hand. */
function reachedOverHTTPS(): boolean {
  return globalThis.location?.protocol === 'https:';
}

/** Connects a Slack adapter: a configuration token, then Slack's approval
 *  screen; or, without https, the app made from a link and its bot token
 *  pasted back. */
export function ConnectNotifyDialog({
  adapter,
  onClose,
  onConnected,
  https = reachedOverHTTPS(),
}: Readonly<{ adapter: NotifyAdapter; onClose: () => void; onConnected: () => void; https?: boolean }>) {
  const caps = adapter.capabilities;
  const byHand = !https || !caps.web_authorization;
  const path = `/notify/${encodeURIComponent(adapter.id)}/authorize`;
  const [token, setToken] = useState('');
  const [botToken, setBotToken] = useState('');

  const begin = useMutation({
    mutationFn: () => api.post<{ authorize_url: string }>(path, { mode: 'web', token }),
    onSuccess: (a) => globalThis.location.assign(a.authorize_url),
  });
  const link = useMutation({
    mutationFn: () => api.post<{ authorize_url: string }>(path, { mode: 'manual' }),
    onSuccess: (a) => window.open(a.authorize_url, '_blank', 'noopener,noreferrer'),
  });
  const finish = useMutation({
    mutationFn: () => api.post<{ status: string }>(path, { mode: 'manual', token: botToken }),
    onSuccess: onConnected,
  });
  const failed = begin.error ?? link.error ?? finish.error;

  return (
    <Dialog
      open
      title={`Connect ${adapter.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {byHand ? (
            <Button variant="primary" disabled={!botToken.trim() || finish.isPending} onClick={() => finish.mutate()}>
              Connect
            </Button>
          ) : (
            <Button variant="primary" disabled={!token.trim() || begin.isPending} onClick={() => begin.mutate()}>
              Continue to Slack
            </Button>
          )}
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {byHand ? (
          <>
            <div>
              <Button variant="secondary" disabled={link.isPending} onClick={() => link.mutate()}>
                Create the app in Slack
              </Button>
            </div>
            <Input
              label="Bot token"
              type="password"
              mono
              autoComplete="off"
              placeholder="xoxb-…"
              helper="After Install to Workspace, from OAuth & Permissions."
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
          </>
        ) : (
          <Input
            label="Configuration token"
            type="password"
            mono
            autoComplete="off"
            helper="In Slack's app settings, under Your App Configuration Tokens, choose Generate Token. Used once."
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        )}
        {!byHand && (
          <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">
            Open Slack apps
          </a>
        )}
        {failed && <Banner tone="failed">{refusal(failed)}</Banner>}
      </div>
    </Dialog>
  );
}

/** The last step when Slack would not take Pando's icon, or the app was made
 *  by hand: upload it on the app's page. */
export function SlackLogoDialog({ adapter, onClose }: Readonly<{ adapter: NotifyAdapter; onClose: () => void }>) {
  return (
    <AppLogoDialog
      manageURL={adapter.capabilities.manage_url ?? 'https://api.slack.com/apps'}
      logo={slackIcon}
      where={
        <>
          On the app&apos;s <strong>Basic Information</strong> page, under <strong>Display Information</strong>, add it
          as the app icon.
        </>
      }
      onClose={onClose}
    />
  );
}
