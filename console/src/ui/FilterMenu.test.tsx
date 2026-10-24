// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FilterMenu } from './FilterMenu';
import { mount } from './testing';

const options = [
  { value: 'running', label: 'Running' },
  { value: 'failed', label: 'Failed' },
];

const list = () => document.querySelector('fieldset[aria-label="Status"]');

describe('the filter menu', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens a checklist, and Escape inside it closes it without reaching what is around it', async () => {
    const around = vi.fn();
    document.addEventListener('keydown', around);
    const onChange = vi.fn();
    const screen = mount(<FilterMenu label="Status" options={options} chosen={[]} onChange={onChange} />);

    await screen.press('Status');
    expect(list()).not.toBeNull();
    await screen.click('Failed');
    expect(onChange).toHaveBeenCalledWith(['failed']);

    await screen.settle(() => {
      list()!.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(list()).toBeNull();
    expect(around).not.toHaveBeenCalled();

    // Closed, Escape is the page's again.
    await screen.settle(() => {
      document.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(around).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', around);
    screen.unmount();
  });

  it('says the choice when it is a choice of one, and closes on choosing', async () => {
    const onChange = vi.fn();
    const screen = mount(<FilterMenu label="Status" options={options} chosen={['running']} onChange={onChange} single />);
    expect(screen.text()).toContain('Running');

    await screen.settle(() => document.querySelector('button')!.click());
    await screen.click('Failed');
    expect(onChange).toHaveBeenCalledWith(['failed']);
    expect(list()).toBeNull();
    screen.unmount();
  });
});
