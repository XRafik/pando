// What the cards of Your settings share.

/** Up to two letters for a name: "Ben Meeker" is BM, "dana" is D. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s@._-]+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}

/** A card of this page: its title, then what is in it, the last row at the foot. */
export const card: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', minWidth: 0 };
