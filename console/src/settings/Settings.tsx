// Your settings: the signed-in person's own preferences, and signing out.
//
// A page of its own rather than a section of the admin console. Nothing here
// is administration, everyone signed in reaches it, and it is opened from the
// launcher and the console alike — so it wears neither one's chrome, and its
// back arrow returns to whichever it was opened from. The address is under
// /admin only because that prefix is already reserved against app slugs
// (consoleRoutes in httpapi); a new top-level path would be one more slug an
// app could not have (R-023).
//
// Account, Appearance and Two-factor are three cards across the page, then
// Notifications as one grid of kinds by channel.

import { Card, Icon, IconButton, Logo } from '@design';

import { usePrincipal } from '../app/principal';
import { NotificationPreferences } from './NotificationPreferences';
import { TwoFactorSettings } from './TwoFactorSettings';
import { useTheme } from '../ui/theme';
import type { Preference } from '../ui/theme';
import { Sheet } from '../ui/Sheet';
import { LineSkeleton } from '../ui/Loading';
import { SignOut } from '../ui/SignOut';
import { TopoBackground } from '../ui/TopoBackground';
import { Segmented } from '../ui/Segmented';
import { CardHead } from '../admin/settingsParts';
import { card, initials } from './parts';

const THEMES: { value: Preference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function Settings({
  onBack,
  onSignedOut,
}: {
  onBack: () => void;
  onSignedOut?: () => void;
}) {
  const me = usePrincipal();
  const { preference, set } = useTheme();

  const name = me.data?.display_name || me.data?.username || me.data?.email || '';
  const email = me.data?.email && me.data.email !== name ? me.data.email : undefined;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper)', position: 'relative', isolation: 'isolate' }}>
      <TopoBackground seed="settings" />
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-5) var(--console-padding)',
          borderBottom: 'var(--border-width) solid var(--rule)',
        }}
      >
        <IconButton label="Back" onClick={onBack}>
          <Icon name="arrow-left" size={16} />
        </IconButton>
        <Logo size={20} />
      </header>

      <main>
        <Sheet heading="Your settings">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))',
                gap: 'var(--space-5)',
              }}
            >
              <Card padding="md" as="section" style={card}>
                <CardHead title="Account" />
                {/* Usually already loaded by the time this page opens; when it
                    is not, the line keeps its place so Sign out does not move. */}
                {me.isPending && <LineSkeleton width="20ch" />}
                {name && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flex: '0 0 auto',
                        width: 'var(--control-console)',
                        height: 'var(--control-console)',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--paper-sunken)',
                        font: 'var(--type-label)',
                        color: 'var(--ink)',
                      }}
                    >
                      {initials(name)}
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ font: 'var(--type-label)', overflowWrap: 'anywhere' }}>{name}</span>
                      {email && (
                        <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)', overflowWrap: 'anywhere' }}>
                          {email}
                        </span>
                      )}
                    </span>
                  </div>
                )}
                <div style={{ marginTop: 'auto' }}>
                  <SignOut onSignedOut={onSignedOut} />
                </div>
              </Card>

              <Card padding="md" as="section" style={card}>
                <CardHead title="Appearance" />
                <Segmented label="Theme" value={preference} options={THEMES} onChange={set} />
                {/* Per browser, not per account (ui/theme.ts): someone who
                    picks dark here and finds another laptop still light has
                    not found a bug. */}
                <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>This browser only.</span>
              </Card>

              {/* Local accounts only; GET /me has no two_factor for others (R-405). */}
              {me.data?.two_factor && <TwoFactorSettings status={me.data.two_factor} username={me.data.username} />}
            </div>

            <NotificationPreferences />
          </div>
        </Sheet>
      </main>
    </div>
  );
}
