import React, { useState } from 'react';
import { isPlainClick } from './plainClick.js';

export function Tabs({ items = [], value, defaultValue, onChange, style, ...rest }) {
  const [internal, setInternal] = useState(defaultValue || (items[0] && items[0].value));
  const active = value !== undefined ? value : internal;
  const pick = (v) => { if (value === undefined) setInternal(v); if (onChange) onChange(v); };
  return (
    <div role="tablist" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)', borderBottom: '1px solid var(--rule)', ...style }} {...rest}>
      {items.map((it) => {
        const on = it.value === active;
        // With an href the tab is a link, so ⌘-click and the middle button
        // open it in a new tab; a plain click still goes through onChange.
        const Item = it.href ? 'a' : 'button';
        const link = it.href
          ? {
              href: it.href,
              onClick: (e) => {
                if (!isPlainClick(e)) return;
                e.preventDefault();
                pick(it.value);
              },
            }
          : { onClick: () => pick(it.value) };
        return (
          <Item
            key={it.value} role="tab" aria-selected={on} {...link}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
              height: 36, padding: 0, marginBottom: -1,
              border: 'none', borderBottom: '1px solid ' + (on ? 'var(--ink)' : 'transparent'),
              background: 'transparent',
              color: on ? 'var(--ink)' : 'var(--ink-secondary)',
              font: on ? 'var(--type-label)' : 'var(--type-body-ui)',
              textDecoration: 'none', cursor: 'pointer',
              transition: 'color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)',
            }}
          >
            {it.label}{it.trailing}
          </Item>
        );
      })}
    </div>
  );
}
