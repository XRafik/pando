import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderToString } from 'react-dom/server';

import { Sheet } from './Sheet';

// useNarrow reads the window's width; rendered on the server here, so stub it.
function atWidth(narrow: boolean) {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: narrow }) });
}

function headerOf(html: string): string {
  return html.slice(html.indexOf('<header'), html.indexOf('</header>'));
}

describe('Sheet', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reserves a search field’s height for the heading row, whatever the action', () => {
    atWidth(false);
    for (const action of [undefined, <button key="b">Add</button>, <input key="i" />]) {
      const html = renderToString(
        <Sheet heading="System" action={action}>
          body
        </Sheet>,
      );
      expect(headerOf(html)).toContain('min-height:var(--control-input)');
    }
  });

  it('pins the header, tabs included, when asked', () => {
    atWidth(false);
    const html = renderToString(
      <Sheet heading="System" pinned tabs={<div role="tablist">tabs</div>}>
        body
      </Sheet>,
    );
    const header = headerOf(html);
    expect(header).toContain('position:sticky');
    expect(header).toContain('background:var(--paper)');
    expect(header).toContain('role="tablist"');
    expect(html.slice(html.indexOf('</header>'))).not.toContain('role="tablist"');
  });

  it('does not pin at phone width or when not asked', () => {
    atWidth(true);
    const narrow = renderToString(
      <Sheet heading="System" pinned>
        body
      </Sheet>,
    );
    expect(narrow).not.toContain('sticky');

    atWidth(false);
    const unpinned = renderToString(<Sheet heading="Accounts">body</Sheet>);
    expect(unpinned).not.toContain('sticky');
  });

  it('has no header without a heading, action or tabs', () => {
    atWidth(false);
    expect(renderToString(<Sheet>body</Sheet>)).not.toContain('<header');
  });
});
