// @vitest-environment jsdom
// The column filters at phone width: a row of buttons, one per filtered
// column, each opening the same checklist the header's filter does.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { filterLabel, Table } from './Table';
import type { Column } from './Table';
import { mount } from './testing';

const rows = [
  { id: 'a', name: 'notes', state: 'Running' },
  { id: 'b', name: 'wiki', state: 'Failed' },
  { id: 'c', name: 'crm', state: 'Running' },
];
const columns: Column[] = [
  { key: 'name', header: 'Name', filter: 'text', phoneFilter: false },
  { key: 'state', header: 'Status', filter: 'values' },
  { key: 'owner', header: 'Owner' },
];

function atWidth(narrow: boolean) {
  vi.stubGlobal('matchMedia', () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} }));
}

const buttonNamed = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('filter labels', () => {
  it('count what is chosen', () => {
    expect(filterLabel('Status', 'values', undefined)).toBe('Status');
    expect(filterLabel('Status', 'values', { values: [] })).toBe('Status');
    expect(filterLabel('Status', 'values', { values: ['Failed', 'Degraded'] })).toBe('Status · 2');
    expect(filterLabel('Name', 'text', { text: 'no' })).toBe('Name · 1');
    expect(filterLabel('Name', 'text', { text: '  ' })).toBe('Name');
  });
});

describe('the table at phone width', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('puts a button per filtered column above the rows, leaving out the ones the search covers', () => {
    atWidth(true);
    const screen = mount(<Table columns={columns} rows={rows} />);
    const group = document.querySelector('fieldset[aria-label="Filters"]');
    expect(group).not.toBeNull();
    expect([...group!.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Status']);
    // No filter icon in the headers.
    expect(document.querySelector('button[aria-label="Filter Status"]')).toBeNull();
    screen.unmount();
  });

  it('opens the same checklist, counts the choices, and clears them', async () => {
    atWidth(true);
    const screen = mount(<Table columns={columns} rows={rows} />);
    await screen.settle(() => buttonNamed('Status')!.click());
    expect(document.querySelector('[role="dialog"][aria-label="Filter Status"]')).not.toBeNull();

    const failed = [...document.querySelectorAll('label')].find((l) => l.textContent === 'Failed (1)')!;
    await screen.settle(() => failed.querySelector('input')!.click());
    expect(buttonNamed('Status · 1')).toBeDefined();
    expect(screen.text()).toContain('wiki');
    expect(screen.text()).not.toContain('notes');

    await screen.press('Clear');
    expect(buttonNamed('Status')).toBeDefined();
    expect(screen.text()).toContain('notes');
    screen.unmount();
  });

  it('shows each row as one block, with no header, when the table gives one', () => {
    atWidth(true);
    const screen = mount(
      <Table columns={columns} rows={rows} stacked={(row: { name: string }) => <span data-block>{row.name} block</span>} />,
    );
    expect(document.querySelectorAll('[data-block]')).toHaveLength(3);
    expect(document.querySelector('.pando-table-stacked')).not.toBeNull();
    expect(screen.text()).toContain('notes block');
    screen.unmount();
  });

  it('keeps the columns and their header filters on a wide window', () => {
    atWidth(false);
    const screen = mount(<Table columns={columns} rows={rows} stacked={() => <span data-block />} />);
    expect(document.querySelector('fieldset[aria-label="Filters"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Filter Status"]')).not.toBeNull();
    expect(document.querySelector('[data-block]')).toBeNull();
    screen.unmount();
  });
});
