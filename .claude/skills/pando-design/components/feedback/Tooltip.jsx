import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// The bubble is placed in the page's body, at its trigger's place on screen,
// rather than inside the trigger. Inside, it was clipped by any ancestor that
// hides its overflow — every table cell does, to end a long value with an
// ellipsis — and a tooltip in a table showed as a sliver of shadow.
export function Tooltip({ content, side = 'top', style, children, ...rest }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [at, setAt] = useState(null);
  const trigger = useRef(null);
  const show = (hover || focus) && at !== null;
  const place = () => setAt(trigger.current ? trigger.current.getBoundingClientRect() : null);
  const pos = at && {
    top: { top: at.top, left: at.left + at.width / 2, transform: 'translate(-50%, calc(-100% - 6px))' },
    bottom: { top: at.bottom, left: at.left + at.width / 2, transform: 'translate(-50%, 6px)' },
    left: { top: at.top + at.height / 2, left: at.left, transform: 'translate(calc(-100% - 6px), -50%)' },
    right: { top: at.top + at.height / 2, left: at.right, transform: 'translate(6px, -50%)' },
  }[side];
  return (
    <span
      ref={trigger}
      style={{ position: 'relative', display: 'inline-flex', ...style }}
      onMouseEnter={() => { place(); setHover(true); }} onMouseLeave={() => setHover(false)}
      onFocus={() => { place(); setFocus(true); }} onBlur={() => setFocus(false)}
      {...rest}
    >
      {children}
      {show && createPortal(
        <span role="tooltip" style={{
          position: 'fixed', zIndex: 40, ...pos,
          padding: '4px 8px', whiteSpace: 'nowrap',
          background: 'var(--paper-raised)', color: 'var(--ink)',
          border: '1px solid var(--rule-strong)', borderRadius: 'var(--radius-sm)',
          boxShadow: 'var(--shadow-popover)',
          font: 'var(--type-caption)', pointerEvents: 'none',
        }}>{content}</span>,
        document.body,
      )}
    </span>
  );
}
