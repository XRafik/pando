// A panel that slides over a screen from the right, keeping the screen in view
// beside it: the app page's Output, Deployments and Terminal (AppPanel), and a
// subscription on the Events screen.
//
// A click on the scrim or Escape closes it — except inside a terminal, where
// Escape is a key the shell is waiting for. At phone width it is the whole
// screen.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon, IconButton } from '@design';

import { useNarrow } from './narrow';
import './panel.css';

export function SidePanel({
  title,
  under,
  width = '75%',
  expandable = false,
  onClose,
  children,
}: Readonly<{
  title: ReactNode;
  /** A line under the title: a status. */
  under?: ReactNode;
  /** Its width beside the screen. */
  width?: string;
  /** Offers full screen. */
  expandable?: boolean;
  onClose: () => void;
  children: ReactNode;
}>) {
  const narrow = useNarrow();
  const [full, setFull] = useState(false);
  const titleID = useId();
  const sheet = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.target instanceof Element && e.target.closest('.xterm')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Focus moves into the panel, so the keyboard is where the eye is.
  useEffect(() => {
    sheet.current?.focus();
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50 }}>
      <div aria-hidden="true" onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--scrim)' }} />
      <aside
        ref={sheet}
        className="pando-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleID}
        tabIndex={-1}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: full || narrow ? '100%' : width,
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--paper-raised)',
          borderLeft: 'var(--border-width) solid var(--rule)',
          boxShadow: 'var(--shadow-popover)',
          outline: 'none',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
            padding: 'var(--space-4) var(--space-5) 0',
          }}
        >
          <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minWidth: 0 }}>
            <h2 id={titleID} style={{ font: 'var(--type-h3)', color: 'var(--ink)', margin: 0, overflowWrap: 'anywhere' }}>
              {title}
            </h2>
            {under}
          </span>
          <span style={{ display: 'inline-flex', gap: 'var(--space-1)' }}>
            {expandable && !narrow && (
              <IconButton label={full ? 'Exit full screen' : 'Full screen'} onClick={() => setFull(!full)}>
                <Icon name={full ? 'minimize-2' : 'maximize-2'} />
              </IconButton>
            )}
            <IconButton label="Close" onClick={onClose}>
              <Icon name="x" />
            </IconButton>
          </span>
        </div>
        {children}
      </aside>
    </div>
  );
}
