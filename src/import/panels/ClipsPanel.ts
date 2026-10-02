import type { Panel } from '../../app/actions';
import type { SettingsStore } from '../../app/state';
import { button, clear, el, fileDrop, hint, row, section, select, toggle } from '../../app/ui';
import type { PoseModelVariant } from '../../core/types';
import type { ClipActions, ClipsVM } from '../actions';
import { SAMPLE_FPS_CHOICES, formatClock } from '../frameStepper';

function formatEta(ms: number | null): string {
  if (ms === null) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `about ${s} s left` : `about ${Math.round(s / 60)} min left`;
}

export function createClipsPanel(store: SettingsStore, actions: ClipActions): Panel<ClipsVM> {
  const sec = section('Clips');
  const s = store.get();

  const drop = fileDrop('Drop or choose video clips (.mp4, .mov, .webm, .mkv…) or takes (.mocap.json)', 'video/*,.mp4,.m4v,.mov,.webm,.mkv,.ogv,.json', (files) => {
    void actions.importFiles(files);
  });

  const fpsSelect = select<string>(
    SAMPLE_FPS_CHOICES.map((f) => ({ value: String(f), label: `${f} samples/s` })),
    '30',
    (v) => actions.setSampleFps(Number(v)),
  );
  const modelSelect = select<PoseModelVariant>(
    [
      { value: 'lite', label: 'Lite (fastest)' },
      { value: 'full', label: 'Full' },
      { value: 'heavy', label: 'Heavy (most accurate, default)' },
    ],
    s.tracking.poseModel,
    (v) => store.update({ tracking: { poseModel: v } }),
  );
  const delegateSelect = select<'GPU' | 'CPU'>(
    [
      { value: 'GPU', label: 'GPU (WebGL)' },
      { value: 'CPU', label: 'CPU' },
    ],
    s.tracking.delegate,
    (v) => store.update({ tracking: { delegate: v } }),
  );
  const handsToggle = toggle('Hands (fingers, palm twist; slower)', s.tracking.hands, (v) => store.update({ tracking: { hands: v } }));
  const faceToggle = toggle('Face (head pose, blendshapes; slower)', s.tracking.face, (v) => store.update({ tracking: { face: v } }));

  const progressName = el('div', { class: 'hint processing-name', text: '' });
  const progressMsg = el('div', { class: 'hint', text: '' });
  const progressBar = el('i');
  const progress = el('div', { class: 'progress' }, progressBar);
  const cancelBtn = button('Cancel', () => actions.cancelImport(), { variant: 'danger' });
  const processingBlock = el('div', { class: 'processing' }, progressName, progress, el('div', { class: 'control' }, progressMsg, cancelBtn));
  processingBlock.style.display = 'none';

  const list = el('div', { class: 'clip-list' });
  const empty = el('div', { class: 'hint', text: 'No clips yet. Drop a video of a person moving; the pose is extracted once and kept in this browser.' });
  const storeHint = el('div', { class: 'hint', text: '' });

  sec.body.append(
    drop,
    row('Sample rate', fpsSelect.root),
    row('Pose model', modelSelect.root),
    row('Delegate', delegateSelect.root),
    row('', handsToggle.root),
    row('', faceToggle.root),
    hint('Extraction runs offline on the clip, frame by frame, so it can be slower or faster than real time. Heavy gives the steadiest limbs; Lite is roughly three times faster.'),
    processingBlock,
    list,
    empty,
    storeHint,
  );

  store.subscribe((st) => {
    modelSelect.set(st.tracking.poseModel);
    delegateSelect.set(st.tracking.delegate);
    handsToggle.set(st.tracking.hands);
    faceToggle.set(st.tracking.face);
  });

  let lastKey = '';

  function renderList(vm: ClipsVM): void {
    // Re-render only when the list content changed (thumbnails are heavy).
    const key = vm.clips.map((c) => `${c.id}:${c.name}:${c.active ? 1 : 0}:${c.thumbnail ? 1 : 0}:${c.frames}`).join('|');
    if (key === lastKey) return;
    lastKey = key;
    clear(list);
    for (const c of vm.clips) {
      const thumb = c.thumbnail ? el('img', { src: c.thumbnail, alt: '', class: 'clip-thumb' }) : el('div', { class: 'clip-thumb placeholder', text: c.hasVideo ? '' : '⋯' });
      const name = el('div', { class: 'clip-name', text: c.name, title: 'Click to select, double-click to rename' });
      const detected = c.frames ? Math.round((100 * c.detectedFrames) / c.frames) : 0;
      const meta = el('div', { class: 'clip-meta', text: `${formatClock(c.durationMs)} · ${c.frames} frames · ${detected}% tracked · ${c.sampleFps} fps · ${c.width}×${c.height}${c.hasVideo ? '' : ' · no video'}` });
      const del = button('✕', () => void actions.deleteClip(c.id), { title: 'Delete this clip' });
      del.classList.add('clip-delete');
      const item = el('div', { class: 'clip-item' + (c.active ? ' active' : '') }, thumb, el('div', { class: 'clip-text' }, name, meta), del);
      item.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        void actions.selectClip(c.id);
      });
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const next = window.prompt('Clip name', c.name);
        if (next && next.trim() && next !== c.name) void actions.renameClip(c.id, next.trim());
      });
      list.appendChild(item);
    }
    empty.style.display = vm.clips.length ? 'none' : '';
  }

  return {
    root: sec.root,
    update(vm) {
      fpsSelect.set(String(vm.sampleFps));
      const p = vm.processing;
      processingBlock.style.display = p ? '' : 'none';
      if (p) {
        progressName.textContent = `${p.phase === 'frames' ? 'Analysing' : 'Preparing'} ${p.name}${p.queued ? ` (+${p.queued} queued)` : ''}`;
        const frac = p.total > 0 ? p.frame / p.total : 0;
        progressBar.style.width = p.phase === 'frames' || p.phase === 'done' ? `${Math.round(frac * 100)}%` : '8%';
        const pct = p.total > 0 ? ` ${Math.round(frac * 100)}%` : '';
        progressMsg.textContent = p.phase === 'frames' ? `${p.frame} / ${p.total}${pct} · ${p.detected} with a subject · ${formatEta(p.etaMs)}` : p.message;
      }
      renderList(vm);
      sec.setBadge(vm.clips.length ? `(${vm.clips.length})` : '');
      storeHint.textContent =
        vm.storeKind === 'indexeddb'
          ? 'Clips, their extracted poses and camera keyframes are stored in this browser (IndexedDB). Videos up to 200 MB are kept too.'
          : vm.storeKind === 'memory'
            ? 'Browser storage is unavailable: clips are kept for this session only.'
            : '';
    },
  };
}
