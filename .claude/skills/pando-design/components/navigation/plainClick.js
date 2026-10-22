// Whether a click on a link should be handled in place by the page.
//
// A primary-button click with no modifier is the page's to handle. Anything else
// — ⌘ or Ctrl to open a tab, Shift for a window, Alt to download, the middle
// button — is the browser's, and a link that swallows it is a link that cannot be
// opened in a new tab.
export function isPlainClick(e) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.defaultPrevented;
}
