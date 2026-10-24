// A filter in a screen's filter row: a button named for what it filters,
// opening a checklist of the values to keep. With values chosen it reads
// "Status · 2". `single` makes it a choice of one, and the button then says
// the choice: Mine, Everyone.
//
// The list is a popover by the design system's rules — paper-raised, a strong
// rule border, the popover shadow, 6px corners — under the button. A click
// outside or Escape closes it.

import { useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Icon } from '@design';

import { useCloseOnOutside } from './combobox';

export interface FilterOption {
  value: string;
  label: string;
}

export function FilterMenu({
  label,
  options,
  chosen,
  onChange,
  single = false,
}: Readonly<{
  label: string;
  options: readonly FilterOption[];
  chosen: readonly string[];
  onChange: (chosen: string[]) => void;
  single?: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const roots = useMemo(() => [root], []);
  useCloseOnOutside(roots, open, () => setOpen(false));

  const active = !single && chosen.length > 0;
  let shown = label;
  if (single) shown = options.find((o) => o.value === chosen[0])?.label ?? label;
  else if (active) shown = `${label} · ${chosen.length}`;

  return (
    <div
      ref={root}
      style={{ position: 'relative' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <Button
        variant={active || single ? 'secondary' : 'ghost'}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={single ? `${label}: ${shown}` : undefined}
        onClick={() => setOpen(!open)}
      >
        {shown}
        <Icon name="chevron-down" size={12} />
      </Button>
      {open && (
        <div
          role="group"
          aria-label={label}
          style={{
            position: 'absolute',
            top: 'calc(100% + var(--space-1))',
            left: 0,
            zIndex: 30,
            minWidth: '22ch',
            maxWidth: 'calc(100vw - 2 * var(--space-4))',
            maxHeight: '60vh',
            overflowY: 'auto',
            padding: 'var(--space-2) var(--space-3)',
            background: 'var(--paper-raised)',
            border: 'var(--border-width) solid var(--rule-strong)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-popover)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          {options.map((o) => (
            <Checkbox
              key={o.value}
              label={o.label}
              checked={chosen.includes(o.value)}
              onChange={(e) => {
                if (single) {
                  onChange([o.value]);
                  setOpen(false);
                } else {
                  onChange(e.target.checked ? [...chosen, o.value] : chosen.filter((c) => c !== o.value));
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
