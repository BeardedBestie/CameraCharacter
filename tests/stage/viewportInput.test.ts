// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { installViewportInput } from '../../src/stage/viewportInput';

function setup(manual = false) {
  const el = document.createElement('canvas');
  document.body.appendChild(el);
  const handlers = { isManual: vi.fn(() => manual), onTakeOver: vi.fn(), onResetView: vi.fn() };
  const uninstall = installViewportInput(el, handlers);
  return { el, handlers, uninstall };
}

describe('viewport input takeover', () => {
  it('takes over on the first pointer press while an automatic camera is active', () => {
    const { el, handlers } = setup(false);
    el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    expect(handlers.onTakeOver).toHaveBeenCalledTimes(1);
    el.dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true }));
    expect(handlers.onTakeOver).toHaveBeenCalledTimes(2);
  });

  it('takes over on wheel', () => {
    const { el, handlers } = setup(false);
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    expect(handlers.onTakeOver).toHaveBeenCalledTimes(1);
  });

  it('runs before listeners registered in the bubble phase on the same element', () => {
    const { el, handlers } = setup(false);
    const order: string[] = [];
    handlers.onTakeOver.mockImplementation(() => order.push('takeover'));
    el.addEventListener('pointerdown', () => order.push('controls'));
    el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    expect(order).toEqual(['takeover', 'controls']);
  });

  it('does nothing on pointer or wheel while the free camera already owns the view', () => {
    const { el, handlers } = setup(true);
    el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
    expect(handlers.onTakeOver).not.toHaveBeenCalled();
  });

  it('ignores back/forward buttons and resets on double-click', () => {
    const { el, handlers } = setup(false);
    el.dispatchEvent(new PointerEvent('pointerdown', { button: 3, bubbles: true }));
    expect(handlers.onTakeOver).not.toHaveBeenCalled();
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(handlers.onResetView).toHaveBeenCalledTimes(1);
  });

  it('uninstalls cleanly', () => {
    const { el, handlers, uninstall } = setup(false);
    uninstall();
    el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(handlers.onTakeOver).not.toHaveBeenCalled();
    expect(handlers.onResetView).not.toHaveBeenCalled();
  });
});
