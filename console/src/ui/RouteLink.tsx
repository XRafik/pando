// A link to a console page.
//
// The console moves between its pages without reloading, which a button does
// well and a link does not — but a button cannot be opened in a new tab. This is
// a real link to the page's address that a plain click follows in place, and
// leaves ⌘-, Ctrl-, Shift- and middle-click to the browser.

import type { AnchorHTMLAttributes } from 'react';
import { isPlainClick } from '@design';

export function RouteLink({
  href,
  onFollow,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  /** Goes there in place, for a plain click. */
  onFollow: () => void;
}) {
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        if (!isPlainClick(e)) return;
        e.preventDefault();
        onFollow();
      }}
    />
  );
}
