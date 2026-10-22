import React, { useState } from 'react';

export function Table({ columns = [], rows = [], dense = false, onRowClick, rowHref, empty = null, style, ...rest }) {
  const grid = columns.map((c) => c.width || '1fr').join(' ');
  const h = dense ? 'var(--row-height-dense)' : 'var(--row-height)';
  return (
    <div style={{ width: '100%', ...style }} {...rest}>
      <div style={{ display: 'grid', gridTemplateColumns: grid, alignItems: 'center', gap: 'var(--space-4)', minHeight: dense ? 28 : 32, padding: '0 var(--space-3)', background: 'var(--paper-sunken)', borderTop: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)' }}>
        {columns.map((c) => (
          <span key={c.key} style={{ font: 'var(--type-label)', color: 'var(--ink-secondary)', textAlign: c.align || 'left' }}>{c.header}</span>
        ))}
      </div>
      {rows.length === 0 && empty}
      {rows.map((r, i) => <Row key={r.id || i} row={r} columns={columns} grid={grid} height={h} onRowClick={onRowClick} rowHref={rowHref} />)}
    </div>
  );
}

// Whether a click landed on a control inside the row rather than on the row:
// a button, link or field there acts for itself, and the row stays out of it.
function onControl(e) {
  const control = e.target.closest && e.target.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"]');
  return Boolean(control && control !== e.currentTarget && e.currentTarget.contains(control));
}

// A row holds buttons and menus, so it cannot be one link. With rowHref it
// opens the way a link would on ⌘- or Ctrl-click and on the middle button, and
// keeps onRowClick for a plain click.
function Row({ row, columns, grid, height, onRowClick, rowHref }) {
  const [hover, setHover] = useState(false);
  const href = rowHref ? rowHref(row) : undefined;
  const elsewhere = () => window.open(href, '_blank', 'noopener');
  const leads = Boolean(onRowClick || href);
  return (
    <div
      onClick={leads ? (e) => {
        if (href && (e.metaKey || e.ctrlKey)) {
          if (!onControl(e)) elsewhere();
        } else if (onRowClick) onRowClick(row);
      } : undefined}
      onAuxClick={href ? (e) => { if (e.button === 1 && !onControl(e)) elsewhere(); } : undefined}
      onMouseDown={href ? (e) => { if (e.button === 1 && !onControl(e)) e.preventDefault(); } : undefined}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid', gridTemplateColumns: grid, alignItems: 'center', gap: 'var(--space-4)',
        minHeight: height, padding: '0 var(--space-3)',
        borderBottom: '1px solid var(--rule)',
        background: hover && leads ? 'var(--paper-raised)' : 'transparent',
        cursor: leads ? 'pointer' : undefined,
        transition: 'background-color var(--dur-fast) var(--ease)',
      }}
    >
      {columns.map((c) => (
        <div key={c.key} style={{ font: c.mono ? 'var(--type-code-sm)' : 'var(--type-body-ui)', color: c.muted ? 'var(--ink-secondary)' : 'var(--ink)', textAlign: c.align || 'left', justifySelf: c.align === 'right' ? 'end' : undefined, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {c.render ? c.render(row) : row[c.key]}
        </div>
      ))}
    </div>
  );
}
