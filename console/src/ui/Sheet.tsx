// A console page: heading, action beside it, content below.
//
// Uncapped, to match ui/layout.ts: rows and their rules run the full window,
// and what is capped is the content inside a section, by MEASURE. No frame —
// the topographic terrain lives behind the console (TopoBackground), not
// around each page.
//
// Every admin screen and the launcher go through here, so the page layout is
// defined once. Three page wrappers had drifted into three copies of the same
// header before this existed.

import { useNarrow } from './narrow';

export function Sheet({
  heading,
  action,
  // An app's id, shown under its name: the value the CLI and the API want,
  // which the console otherwise only showed in the address bar.
  note,
  lede,
  // Tabs that belong to the header rather than the content: pinned with it.
  tabs,
  // The header stays at the top of the window while the page scrolls, so a
  // long page keeps its save button and search in reach. Not at phone width,
  // where a wrapped heading, buttons and search would cover half the screen.
  pinned = false,
  children,
}: {
  heading?: React.ReactNode;
  action?: React.ReactNode;
  note?: string;
  lede?: React.ReactNode;
  tabs?: React.ReactNode;
  pinned?: boolean;
  children: React.ReactNode;
}) {
  const hasHeader = Boolean(heading || action || note || lede || tabs);
  const pin = pinned && !useNarrow();
  let bodyPadding = 'var(--space-6) var(--console-padding) var(--space-7)';
  if (tabs) bodyPadding = 'var(--space-5) var(--console-padding) var(--space-7)';
  else if (hasHeader) bodyPadding = '0 var(--console-padding) var(--space-7)';

  return (
    <div>
      {hasHeader && (
        <header
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
            // With tabs, their rule is the header's lower edge.
            padding: tabs
              ? 'var(--space-6) var(--console-padding) 0'
              : 'var(--space-6) var(--console-padding) var(--space-4)',
            ...(pin && {
              position: 'sticky',
              top: 0,
              zIndex: 1,
              // Opaque, so rows scroll under it rather than through it.
              background: 'var(--paper)',
            }),
          }}
        >
          {/* The action sits beside the heading rather than at the far end of
              an uncapped row, where on a wide display it would be a long way
              from the thing it acts on. It wraps rather than overflowing: on a
              phone a heading, a button and a search do not fit on one line,
              and the page should not scroll sideways. It is as tall as the
              tallest control it might hold, a search field, so tabs sharing a
              header keep one height whether their action is a button, a
              search or nothing. */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 'var(--space-3) var(--space-4)',
              minHeight: 'var(--control-input)',
            }}
          >
            {typeof heading === 'string' ? (
              <h3 style={{ font: 'var(--type-h3)', margin: 0 }}>{heading}</h3>
            ) : (
              heading
            )}
            {action}
          </div>
          {lede}
          {note && (
            <span style={{ font: 'var(--type-code-sm)', color: 'var(--ink-secondary)' }}>
              {note}
            </span>
          )}
          {tabs && <div style={{ paddingTop: 'var(--space-2)' }}>{tabs}</div>}
        </header>
      )}
      <div style={{ padding: bodyPadding }}>
        {children}
      </div>
    </div>
  );
}
