// A row of the admin apps list: the app's name, with its address under it
// (discussion #262).

import type { App } from '@api/types.gen';
import { shown } from './AppAddress';

/**
 * The app's name, and under it where the app is, opening it in its own tab.
 * The click stops at the link: the row's own click opens the app's admin
 * screen, and both at once would change the console behind the new tab.
 */
export function NameCell({ row }: { row: App }) {
  const caption = { font: 'var(--type-caption)', color: 'var(--ink-secondary)' };
  return (
    <span style={{ display: 'flex', flexDirection: 'column', padding: 'var(--space-2) 0' }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name}</span>
      {row.address ? (
        <a
          href={row.address}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ ...caption, overflow: 'hidden', textOverflow: 'ellipsis', alignSelf: 'start', maxWidth: '100%' }}
        >
          {shown(row.address)}
        </a>
      ) : (
        <span style={caption}>Not deployed yet</span>
      )}
    </span>
  );
}
