// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { select } from '../../src/app/ui';

const opts = () => [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
];

describe('select control', () => {
  it('keeps the existing option elements when setOptions receives an identical list', () => {
    const s = select(opts(), 'b', () => {});
    const before = Array.from(s.root.options);
    s.setOptions(opts());
    const after = Array.from(s.root.options);
    expect(after.length).toBe(before.length);
    expect(after.every((o, i) => o === before[i])).toBe(true);
    expect(s.root.value).toBe('b');
  });

  it('rebuilds the options when the list changes and keeps the selection when it still exists', () => {
    const s = select(opts(), 'b', () => {});
    const before = Array.from(s.root.options);
    s.setOptions([...opts(), { value: 'c', label: 'C' }]);
    const after = Array.from(s.root.options);
    expect(after.length).toBe(3);
    expect(after[0]).not.toBe(before[0]);
    expect(s.root.value).toBe('b');
    s.setOptions([{ value: 'a', label: 'A (renamed)' }]);
    expect(Array.from(s.root.options).map((o) => o.textContent)).toEqual(['A (renamed)']);
  });

  it('treats a label change as a change', () => {
    const s = select(opts(), 'a', () => {});
    s.setOptions([
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B2' },
    ]);
    expect(s.root.options[1]!.textContent).toBe('B2');
  });

  it('set() selects the value and leaves the option elements alone', () => {
    const s = select(opts(), 'a', () => {});
    const before = Array.from(s.root.options);
    s.set('b');
    expect(s.root.value).toBe('b');
    s.set('b');
    expect(s.root.value).toBe('b');
    expect(Array.from(s.root.options).every((o, i) => o === before[i])).toBe(true);
  });

  it('still reports user changes', () => {
    const onChange = vi.fn();
    const s = select(opts(), 'a', onChange);
    s.root.value = 'b';
    s.root.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
