// Which of Pando's own notifications reach you, and on which channel (R-373).
//
// Pando's own notifications are the ones it sends to particular people without
// anybody subscribing: a deploy waiting for your approval, an app of yours that
// failed. Each one can be turned off per channel that reaches people — the
// console, and email when an administrator has set it up. Channels that post to
// a room (Slack, Teams, Discord, ntfy) are not here: they hear only from event
// subscriptions, because a message meant for you must not land in a room.
//
// "An app was shared with you" is off by default (R-266): the launcher tile is
// the notification, and this is for someone who wants an email as well.
//
// One row per kind, one column per channel. At phone width each row's boxes go
// under its label, each named for its channel.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, Checkbox } from '@design';

import { api } from '@api/client';
import { messageOf } from '../install/Accounts';
import { LineSkeleton } from '../ui/Loading';
import { useNarrow } from '../ui/narrow';
import { CardHead } from '../admin/settingsParts';
import { card } from './parts';

interface View {
  kinds: { kind: string; label: string; description: string; default_on: boolean }[];
  channels: { id: string; kind: string }[];
  choices: { kind: string; channel: string; enabled: boolean }[];
}

const CHANNEL_NAMES: Record<string, string> = { console: 'Console', smtp: 'Email' };

const muted = { font: 'var(--type-body-ui)', color: 'var(--ink-secondary)', margin: 0 };

export function NotificationPreferences() {
  const queries = useQueryClient();
  const view = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => api.get<View>('/notification-preferences'),
  });
  const set = useMutation({
    mutationFn: (choice: { kind: string; channel: string; enabled: boolean }) =>
      api.put<View>('/notification-preferences', { choices: [choice] }),
    onSuccess: (next) => queries.setQueryData(['notification-preferences'], next),
  });

  let body: React.ReactNode;
  if (view.isPending) body = <LineSkeleton width="28ch" />;
  else if (view.isError) body = <p style={muted}>{messageOf(view.error)}</p>;
  else body = <Grid view={view.data} disabled={set.isPending} onChange={(choice) => set.mutate(choice)} />;

  return (
    <Card padding="md" as="section" style={card}>
      <CardHead title="Notifications" />
      {set.isError && <p style={{ ...muted, color: 'var(--marker-deep)' }}>{messageOf(set.error)}</p>}
      {body}
    </Card>
  );
}

function Grid({
  view,
  disabled,
  onChange,
}: Readonly<{
  view: View;
  disabled: boolean;
  onChange: (choice: { kind: string; channel: string; enabled: boolean }) => void;
}>) {
  const narrow = useNarrow();
  const { kinds, channels, choices } = view;
  const on = (kind: string, channel: string) =>
    choices.find((c) => c.kind === kind && c.channel === channel)?.enabled ?? false;
  const name = (ch: { id: string; kind: string }) => CHANNEL_NAMES[ch.kind] ?? ch.id;
  const row: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: narrow ? 'minmax(0,1fr)' : `minmax(0,1fr) repeat(${channels.length}, 8ch)`,
    gap: 'var(--space-2) var(--space-4)',
    alignItems: 'center',
    padding: 'var(--space-2) 0',
    borderTop: 'var(--border-width) solid var(--rule)',
  };

  return (
    <div role="table" aria-label="Notifications">
      {!narrow && (
        <div role="row" style={{ ...row, borderTop: 0, font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>
          <span role="columnheader">Notify me about</span>
          {channels.map((ch) => (
            <span role="columnheader" key={ch.id} style={{ textAlign: 'center' }}>
              {name(ch)}
            </span>
          ))}
        </div>
      )}
      {kinds.map((k) => (
        <div role="row" key={k.kind} style={row}>
          <span role="rowheader" style={{ font: 'var(--type-body-ui)', color: 'var(--ink)' }}>
            {k.label}
          </span>
          <span
            role="cell"
            style={narrow ? { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)' } : { display: 'contents' }}
          >
            {channels.map((ch) => (
              <span key={ch.id} style={narrow ? undefined : { display: 'flex', justifyContent: 'center' }}>
                <Checkbox
                  label={narrow ? name(ch) : undefined}
                  aria-label={narrow ? undefined : `${k.label}: ${name(ch)}`}
                  checked={on(k.kind, ch.id)}
                  disabled={disabled}
                  onChange={(e) => onChange({ kind: k.kind, channel: ch.id, enabled: e.target.checked })}
                />
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
