// One of a few choices, side by side: a row of buttons, the chosen one
// pressed. The design system has none; this is built from its control rules —
// the input border and radius, the console control height, the sunken paper
// for the pressed state.

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: Readonly<{
  /** What the group is, to a screen reader. */
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}>) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignSelf: 'flex-start',
        border: 'var(--border-width) solid var(--field-border)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
      }}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            style={{
              height: 'var(--control-console)',
              padding: '0 var(--space-3)',
              border: 0,
              borderLeft: i === 0 ? 0 : 'var(--border-width) solid var(--field-border)',
              background: on ? 'var(--paper-sunken)' : 'transparent',
              color: on ? 'var(--ink)' : 'var(--ink-secondary)',
              font: 'var(--type-label)',
              cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
