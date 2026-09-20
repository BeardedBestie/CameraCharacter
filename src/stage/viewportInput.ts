/**
 * Mouse and touch takeover of the stage camera (docs/DESIGN.md §8).
 *
 * The automatic cameras (mirror, follow) overwrite the camera pose every
 * frame, so pointer input cannot simply be layered on top of them. Instead the
 * first drag or wheel on the viewport hands the camera to OrbitControls from
 * its current position, and a double-click gives it back. The listeners run in
 * the capture phase so the takeover happens before OrbitControls sees the same
 * pointerdown: the very first drag already rotates.
 *
 * DOM only; no three.js, so it is unit-tested under happy-dom.
 */
export interface ViewportInputHandlers {
  /** True while the free (orbit) camera already owns the view. */
  isManual(): boolean;
  /** First pointer or wheel interaction while an automatic camera is active. */
  onTakeOver(): void;
  /** Double-click on the viewport: return to the automatic camera. */
  onResetView(): void;
}

/** Installs the takeover listeners on the viewport element; returns the uninstaller. */
export function installViewportInput(el: HTMLElement, handlers: ViewportInputHandlers): () => void {
  const takeOver = () => {
    if (!handlers.isManual()) handlers.onTakeOver();
  };
  const onPointerDown = (e: PointerEvent) => {
    // Left, middle and right buttons drive OrbitControls; ignore back/forward buttons.
    if (e.button > 2) return;
    takeOver();
  };
  const onWheel = () => takeOver();
  const onDblClick = () => handlers.onResetView();
  el.addEventListener('pointerdown', onPointerDown, { capture: true });
  el.addEventListener('wheel', onWheel, { capture: true, passive: true });
  el.addEventListener('dblclick', onDblClick);
  return () => {
    el.removeEventListener('pointerdown', onPointerDown, { capture: true });
    el.removeEventListener('wheel', onWheel, { capture: true });
    el.removeEventListener('dblclick', onDblClick);
  };
}
