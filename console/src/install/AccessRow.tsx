// One row of a card on an account's page: a label over its value, and one
// button on the right.

export function AccessRow({
  label,
  children,
  action,
}: Readonly<{ label: string; children: React.ReactNode; action?: React.ReactNode }>) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-2) 0',
        borderTop: 'var(--border-width) solid var(--rule)',
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minWidth: 0 }}>
        <span style={{ font: 'var(--type-caption)', color: 'var(--ink-secondary)' }}>{label}</span>
        <span style={{ font: 'var(--type-body-ui)', color: 'var(--ink)', overflowWrap: 'anywhere' }}>{children}</span>
      </span>
      {action}
    </div>
  );
}
