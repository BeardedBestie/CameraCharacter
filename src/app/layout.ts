/**
 * Builds the static DOM skeleton of the app: viewport, webcam picture-in-picture,
 * status chips, overlays, and the collapsible side panel. No pipeline logic.
 */
import { chip, el, makeDraggable, type Chip } from './ui';

export interface Layout {
  viewport: HTMLElement;
  pip: HTMLElement;
  video: HTMLVideoElement;
  overlay: HTMLCanvasElement;
  pipLabel: HTMLElement;
  statusBar: HTMLElement;
  chips: { source: Chip; subject: Chip; model: Chip; framing: Chip; fps: Chip };
  dropOverlay: HTMLElement;
  countdown: HTMLElement;
  countdownNumber: HTMLElement;
  countdownText: HTMLElement;
  panel: HTMLElement;
  panelBody: HTMLElement;
  panelToggle: HTMLButtonElement;
  /** Bottom-centre pill shown while the free (orbit) camera is active; clicking it returns to the automatic camera. */
  cameraHint: HTMLButtonElement;
  setPanelCollapsed(v: boolean): void;
  isPanelCollapsed(): boolean;
  setPipVisible(v: boolean): void;
  setPipMirrored(v: boolean): void;
  showCountdown(number: number | null, text: string): void;
  hideCountdown(): void;
  /** Shows the free-camera pill with `text`, or hides it with null. */
  setCameraHint(text: string | null): void;
}

export function buildLayout(root: HTMLElement, opts: { version: string }): Layout {
  root.innerHTML = '';

  const viewport = el('div', { id: 'viewport' });

  const video = el('video', { id: 'pip-video', muted: true, playsinline: true, autoplay: true });
  video.muted = true;
  const overlay = el('canvas', { id: 'pip-overlay' });
  const pipLabel = el('div', { class: 'pip-label', text: 'webcam' });
  const pip = el('div', { id: 'pip' }, video, overlay, pipLabel);
  makeDraggable(pip);

  const chips = {
    source: chip('source: idle'),
    subject: chip('no subject'),
    model: chip('no model'),
    framing: chip('framing: none'),
    fps: chip('— fps'),
  };
  const statusBar = el('div', { id: 'status-bar' }, chips.source.root, chips.subject.root, chips.model.root, chips.framing.root, chips.fps.root);

  const dropOverlay = el('div', { id: 'drop-overlay', text: 'Drop a model (.glb / .fbx / .vrm), a take (.mocap.json) or an environment' });
  const countdownNumber = el('div', { text: '' });
  const countdownText = el('small', { text: '' });
  const countdown = el('div', { id: 'countdown' }, countdownNumber, countdownText);

  const cameraHint = el('button', { id: 'camera-hint', type: 'button', title: 'Return to the automatic camera', hidden: true });

  const panelToggle = el('button', { id: 'panel-toggle', title: 'Toggle panel (Tab)', text: '☰' });
  const panelHeader = el('div', { id: 'panel-header' }, el('h1', { text: 'CameraCharacter' }), el('span', { text: `v${opts.version}` }));
  const panelBody = el('div', { id: 'panel-body' });
  const panel = el('div', { id: 'panel' }, panelToggle, panelHeader, panelBody);

  root.append(viewport, pip, statusBar, dropOverlay, countdown, cameraHint, panel);

  const layout: Layout = {
    viewport,
    pip,
    video,
    overlay,
    pipLabel,
    statusBar,
    chips,
    dropOverlay,
    countdown,
    countdownNumber,
    countdownText,
    panel,
    panelBody,
    panelToggle,
    cameraHint,
    setPanelCollapsed: (v) => panel.classList.toggle('collapsed', v),
    isPanelCollapsed: () => panel.classList.contains('collapsed'),
    setPipVisible: (v) => pip.classList.toggle('hidden', !v),
    setPipMirrored: (v) => video.classList.toggle('mirrored', v),
    showCountdown: (number, text) => {
      countdownNumber.textContent = number === null ? '' : String(number);
      countdownText.textContent = text;
      countdown.classList.add('active');
    },
    hideCountdown: () => countdown.classList.remove('active'),
    setCameraHint: (text) => {
      if (text === null) {
        cameraHint.hidden = true;
        return;
      }
      if (cameraHint.textContent !== text) cameraHint.textContent = text;
      cameraHint.hidden = false;
    },
  };
  panelToggle.addEventListener('click', () => layout.setPanelCollapsed(!layout.isPanelCollapsed()));
  return layout;
}

/** Wires drag-and-drop on the whole window and returns an unsubscribe. */
export function installDropZone(root: HTMLElement, overlay: HTMLElement, onFiles: (files: File[]) => void): () => void {
  let depth = 0;
  const enter = (e: DragEvent) => {
    e.preventDefault();
    depth++;
    overlay.classList.add('active');
  };
  const over = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const leave = (e: DragEvent) => {
    e.preventDefault();
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.remove('active');
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('active');
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    if (files.length) onFiles(files);
  };
  root.addEventListener('dragenter', enter);
  root.addEventListener('dragover', over);
  root.addEventListener('dragleave', leave);
  root.addEventListener('drop', drop);
  return () => {
    root.removeEventListener('dragenter', enter);
    root.removeEventListener('dragover', over);
    root.removeEventListener('dragleave', leave);
    root.removeEventListener('drop', drop);
  };
}

export type ShortcutHandler = (e: KeyboardEvent) => void;

/** Keyboard shortcuts that ignore typing in inputs. */
export function installShortcuts(map: Record<string, ShortcutHandler>): () => void {
  const handler = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const fn = map[key];
    if (fn) {
      e.preventDefault();
      fn(e);
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
