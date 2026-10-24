// One page of System: its name, the action beside it, and what it holds.
// System's own heading is above, with the list of pages beside.

export function SystemPage({
  title,
  action,
  children,
}: Readonly<{ title: string; action?: React.ReactNode; children: React.ReactNode }>) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'var(--space-3) var(--space-4)',
          minHeight: 'var(--control-input)',
        }}
      >
        <h2 style={{ font: 'var(--type-h2)', color: 'var(--ink)', margin: 0 }}>{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}
