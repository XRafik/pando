// An account's initials in a circle: Accounts' rows and the account page's
// header. Pando keeps no pictures of people.

/** Up to two initials: "Ana Ruiz" is AR, "ci-bot" is CB, "pando" is P. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toUpperCase();
}

export function Avatar({ name, large = false }: Readonly<{ name: string; large?: boolean }>) {
  const size = large ? 'calc(var(--space-7) + var(--space-2))' : 'var(--space-6)';
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 'var(--radius-pill)',
        border: 'var(--border-width) solid var(--rule-strong)',
        background: 'var(--paper-sunken)',
        color: 'var(--ink-secondary)',
        font: large ? 'var(--type-h4)' : 'var(--type-caption)',
        fontWeight: 500,
        boxSizing: 'border-box',
      }}
    >
      {initials(name)}
    </span>
  );
}
