/**
 * DOM skeleton of the import page: viewport, source-video picture-in-picture
 * with the landmark overlay, status chips, the transport bar with keyframe
 * markers, and the collapsible side panel. No pipeline logic.
 */
import { button, chip, el, makeDraggable, select, toggle, type Chip } from '../app/ui';

export interface TransportBar {
  root: HTMLElement;
  playBtn: HTMLButtonElement;
  timeLabel: HTMLElement;
  scrub: HTMLInputElement;
  markers: HTMLElement;
  loopToggle: ReturnType<typeof toggle>;
  speedSelect: ReturnType<typeof select<string>>;
  prevKeyBtn: HTMLButtonElement;
  nextKeyBtn: HTMLButtonElement;
  addKeyBtn: HTMLButtonElement;
  stepBackBtn: HTMLButtonElement;
  stepFwdBtn: HTMLButtonElement;
  clipLabel: HTMLElement;
}

export interface ImportLayout {
  viewport: HTMLElement;
  pip: HTMLElement;
  overlay: HTMLCanvasElement;
  pipLabel: HTMLElement;
  pipPlaceholder: HTMLElement;
  chips: { clip: Chip; subject: Chip; model: Chip; camera: Chip; fps: Chip };
  dropOverlay: HTMLElement;
  busy: HTMLElement;
  busyText: HTMLElement;
  busyBar: HTMLElement;
  panel: HTMLElement;
  panelBody: HTMLElement;
  transport: TransportBar;
  setPanelCollapsed(v: boolean): void;
  isPanelCollapsed(): boolean;
  setPipVisible(v: boolean): void;
  mountVideo(video: HTMLVideoElement | null, mirrored: boolean): void;
  showBusy(text: string, fraction: number | null): void;
  hideBusy(): void;
}

export interface TransportHandlers {
  onPlayToggle(): void;
  onScrub(fraction: number): void;
  onScrubStart(): void;
  onScrubEnd(): void;
  onLoop(v: boolean): void;
  onSpeed(x: number): void;
  onPrevKey(): void;
  onNextKey(): void;
  onAddKey(): void;
  onStep(frames: number): void;
}

export function buildImportLayout(root: HTMLElement, opts: { version: string }, handlers: TransportHandlers): ImportLayout {
  root.innerHTML = '';
  root.classList.add('import-page');

  const viewport = el('div', { id: 'viewport' });

  const overlay = el('canvas', { id: 'pip-overlay' });
  const pipLabel = el('div', { class: 'pip-label', text: 'source video' });
  const pipPlaceholder = el('div', { class: 'pip-placeholder', text: 'landmarks only (no video stored)' });
  const pip = el('div', { id: 'pip' }, pipPlaceholder, overlay, pipLabel);
  makeDraggable(pip);

  const chips = {
    clip: chip('no clip'),
    subject: chip('no subject'),
    model: chip('no model'),
    camera: chip('camera: orbit'),
    fps: chip('— fps'),
  };
  const statusBar = el('div', { id: 'status-bar' }, chips.clip.root, chips.subject.root, chips.model.root, chips.camera.root, chips.fps.root);

  const dropOverlay = el('div', { id: 'drop-overlay', text: 'Drop video clips (.mp4, .mov, .webm…), a model (.glb / .fbx / .vrm), a take (.mocap.json) or a camera track' });

  const busyText = el('div', { class: 'busy-text', text: '' });
  const busyBar = el('i');
  const busy = el('div', { id: 'busy' }, busyText, el('div', { class: 'progress' }, busyBar));

  // Transport bar
  const playBtn = button('▶', () => handlers.onPlayToggle(), { title: 'Play / pause (Space)' });
  playBtn.classList.add('transport-play');
  const stepBackBtn = button('⏮', () => handlers.onStep(-1), { title: 'Previous frame (←)' });
  const stepFwdBtn = button('⏭', () => handlers.onStep(1), { title: 'Next frame (→)' });
  const timeLabel = el('span', { class: 'transport-time', text: '0:00.0 / 0:00.0' });
  const scrub = el('input', { type: 'range', min: 0, max: 1000, step: 1, class: 'transport-scrub' });
  scrub.value = '0';
  scrub.addEventListener('pointerdown', () => handlers.onScrubStart());
  scrub.addEventListener('pointerup', () => handlers.onScrubEnd());
  scrub.addEventListener('input', () => handlers.onScrub(Number(scrub.value) / 1000));
  const markers = el('div', { class: 'transport-markers' });
  const scrubWrap = el('div', { class: 'transport-scrub-wrap' }, scrub, markers);
  const loopToggle = toggle('Loop', true, (v) => handlers.onLoop(v));
  const speedSelect = select<string>(
    ['0.25', '0.5', '1', '1.5', '2'].map((v) => ({ value: v, label: `${v}×` })),
    '1',
    (v) => handlers.onSpeed(Number(v)),
  );
  speedSelect.root.classList.add('transport-speed');
  const prevKeyBtn = button('◀ key', () => handlers.onPrevKey(), { title: 'Previous camera keyframe ([)' });
  const nextKeyBtn = button('key ▶', () => handlers.onNextKey(), { title: 'Next camera keyframe (])' });
  const addKeyBtn = button('+ camera key', () => handlers.onAddKey(), { title: 'Add a camera keyframe at the current time (K)', variant: 'primary' });
  const clipLabel = el('span', { class: 'transport-clip', text: 'No clip' });
  const transportRoot = el(
    'div',
    { id: 'transport' },
    clipLabel,
    stepBackBtn,
    playBtn,
    stepFwdBtn,
    timeLabel,
    scrubWrap,
    loopToggle.root,
    speedSelect.root,
    el('span', { class: 'transport-sep' }),
    prevKeyBtn,
    addKeyBtn,
    nextKeyBtn,
  );

  const panelToggle = el('button', { id: 'panel-toggle', title: 'Toggle panel (Tab)', text: '☰' });
  const liveLink = el('a', { href: '/', class: 'header-link', title: 'Back to the live webcam app', text: '← Live' });
  const panelHeader = el(
    'div',
    { id: 'panel-header' },
    el('h1', { text: 'CameraCharacter · Import' }),
    el('span', {}, liveLink, ' ', el('span', { text: `v${opts.version}` })),
  );
  const panelBody = el('div', { id: 'panel-body' });
  const panel = el('div', { id: 'panel' }, panelToggle, panelHeader, panelBody);

  root.append(viewport, pip, statusBar, dropOverlay, busy, transportRoot, panel);

  let currentVideo: HTMLVideoElement | null = null;
  const layout: ImportLayout = {
    viewport,
    pip,
    overlay,
    pipLabel,
    pipPlaceholder,
    chips,
    dropOverlay,
    busy,
    busyText,
    busyBar,
    panel,
    panelBody,
    transport: { root: transportRoot, playBtn, timeLabel, scrub, markers, loopToggle, speedSelect, prevKeyBtn, nextKeyBtn, addKeyBtn, stepBackBtn, stepFwdBtn, clipLabel },
    setPanelCollapsed: (v) => {
      panel.classList.toggle('collapsed', v);
      root.classList.toggle('panel-collapsed', v);
    },
    isPanelCollapsed: () => panel.classList.contains('collapsed'),
    setPipVisible: (v) => pip.classList.toggle('hidden', !v),
    mountVideo: (video, mirrored) => {
      if (currentVideo && currentVideo !== video) currentVideo.remove();
      currentVideo = video;
      if (video) {
        video.classList.add('pip-video');
        video.classList.toggle('mirrored', mirrored);
        if (video.parentElement !== pip) pip.insertBefore(video, overlay);
        pipPlaceholder.style.display = 'none';
      } else {
        pipPlaceholder.style.display = '';
      }
    },
    showBusy: (text, fraction) => {
      busyText.textContent = text;
      busyBar.style.width = fraction === null ? '100%' : `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
      busyBar.classList.toggle('indeterminate', fraction === null);
      busy.classList.add('active');
    },
    hideBusy: () => busy.classList.remove('active'),
  };
  panelToggle.addEventListener('click', () => layout.setPanelCollapsed(!layout.isPanelCollapsed()));
  return layout;
}

/** Draws keyframe markers (fractions of the duration) into the transport bar. */
export function renderMarkers(container: HTMLElement, fractions: readonly number[], activeIndex: number, onClick: (index: number) => void): void {
  container.replaceChildren();
  fractions.forEach((f, i) => {
    const m = el('button', { class: 'transport-marker' + (i === activeIndex ? ' active' : ''), title: `Camera keyframe ${i + 1}` });
    m.style.left = `${Math.min(100, Math.max(0, f * 100))}%`;
    m.addEventListener('click', (e) => {
      e.preventDefault();
      onClick(i);
    });
    container.appendChild(m);
  });
}
