import type { PoseModelVariant } from '../../core/types';
import type { AppActions, Panel, SourceKind, SourceVM } from '../actions';
import type { SettingsStore } from '../state';
import { button, buttonRow, chip, el, fileDrop, hint, row, section, select, slider, textInput, toggle } from '../ui';

export function createSourcePanel(store: SettingsStore, actions: AppActions): Panel<SourceVM> {
  const sec = section('Source');
  const s = store.get();

  const kindSelect = select<SourceKind>(
    [
      { value: 'camera', label: 'Webcam (MediaPipe in browser)' },
      { value: 'synthetic', label: 'Synthetic motion (no webcam)' },
      { value: 'recording', label: 'Recorded take (.mocap.json)' },
      { value: 'websocket', label: 'WebSocket provider (Python / OpenCV)' },
    ],
    'camera',
    (v) => void actions.setSource(v),
  );

  const status = chip('idle');

  // Camera controls
  const cameraSelect = select<string>([{ value: '', label: 'Default camera' }], '', (v) => void actions.selectCamera(v));
  const refreshBtn = button('Refresh', () => void actions.refreshCameras());
  const modelSelect = select<PoseModelVariant>(
    [
      { value: 'lite', label: 'Lite (fastest)' },
      { value: 'full', label: 'Full (default)' },
      { value: 'heavy', label: 'Heavy (most accurate)' },
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
  const handsToggle = toggle('Hands (fingers, palm twist)', s.tracking.hands, (v) => store.update({ tracking: { hands: v } }));
  const faceToggle = toggle('Face (head pose, blendshapes)', s.tracking.face, (v) => store.update({ tracking: { face: v } }));
  const fovSlider = slider({ min: 30, max: 90, step: 1, value: s.tracking.cameraVfovDeg, format: (v) => `${v}°` }, (v) =>
    store.update({ tracking: { cameraVfovDeg: v } }),
  );
  const cameraBlock = el(
    'div',
    { class: 'section-body', style: 'padding:0' },
    row('Camera', el('div', { class: 'control' }, cameraSelect.root, refreshBtn)),
    row('Pose model', modelSelect.root),
    row('Delegate', delegateSelect.root),
    row('', handsToggle.root),
    row('', faceToggle.root),
    row('Webcam FOV', fovSlider.root),
    hint('The vertical field of view only sets the absolute depth scale for hip translation. Most laptop webcams are 40–55°.'),
  );

  // Synthetic controls
  const presetSelect = select<string>([{ value: 'walk', label: 'walk' }], 'walk', (v) => void actions.setSyntheticPreset(v));
  const syntheticBlock = el(
    'div',
    { class: 'section-body', style: 'padding:0' },
    row('Preset', presetSelect.root),
    hint('Generated motion from the synthetic human. Useful without a webcam and for checking a rig.'),
  );

  // Recording controls
  const recordingName = el('div', { class: 'hint', text: 'No take loaded.' });
  const recordingDrop = fileDrop('Drop or choose a .mocap.json take', '.json,application/json', (files) => {
    if (files[0]) void actions.loadRecordingFile(files[0]);
  });
  const playBtn = button('Play', () => actions.playback.play(), { variant: 'primary' });
  const pauseBtn = button('Pause', () => actions.playback.pause());
  const loopToggle = toggle('Loop', true, (v) => actions.playback.setLoop(v));
  const speedSelect = select<string>(
    ['0.25', '0.5', '1', '1.5', '2'].map((v) => ({ value: v, label: `${v}×` })),
    '1',
    (v) => actions.playback.setSpeed(Number(v)),
  );
  const scrub = el('input', { type: 'range', min: 0, max: 1000, step: 1 });
  scrub.value = '0';
  let scrubbing = false;
  scrub.addEventListener('pointerdown', () => (scrubbing = true));
  scrub.addEventListener('pointerup', () => (scrubbing = false));
  scrub.addEventListener('input', () => {
    const duration = Number(scrub.dataset.duration ?? '0');
    actions.playback.seek((Number(scrub.value) / 1000) * duration);
  });
  const timeLabel = el('span', { class: 'slider-value', text: '0.0 s' });
  const recordingBlock = el(
    'div',
    { class: 'section-body', style: 'padding:0' },
    recordingDrop,
    recordingName,
    el('div', { class: 'scrubber' }, scrub, timeLabel),
    buttonRow(playBtn, pauseBtn, loopToggle.root, speedSelect.root),
  );

  // WebSocket controls
  const wsInput = textInput('ws://localhost:8765', (v) => void actions.setWebSocketUrl(v), { placeholder: 'ws://host:8765', type: 'url' });
  const wsBlock = el(
    'div',
    { class: 'section-body', style: 'padding:0' },
    row('URL', wsInput),
    hint('Run `python backend/stream_pose.py` to provide frames from OpenCV. See backend/README.md.'),
  );

  const blocks: Record<SourceKind, HTMLElement> = { camera: cameraBlock, synthetic: syntheticBlock, recording: recordingBlock, websocket: wsBlock };

  sec.body.append(row('Source', kindSelect.root), row('Status', status.root), cameraBlock, syntheticBlock, recordingBlock, wsBlock);

  const showBlock = (kind: SourceKind) => {
    for (const [k, b] of Object.entries(blocks)) b.style.display = k === kind ? '' : 'none';
  };
  showBlock('camera');

  store.subscribe((st) => {
    modelSelect.set(st.tracking.poseModel);
    delegateSelect.set(st.tracking.delegate);
    handsToggle.set(st.tracking.hands);
    faceToggle.set(st.tracking.face);
    fovSlider.set(st.tracking.cameraVfovDeg);
  });

  return {
    root: sec.root,
    update(vm) {
      kindSelect.set(vm.kind);
      showBlock(vm.kind);
      const state = vm.status.state;
      const light = state === 'running' ? 'good' : state === 'error' ? 'bad' : state === 'starting' ? 'warn' : 'off';
      const fps = vm.status.fps ? ` · ${vm.status.fps.toFixed(0)} fps` : '';
      const ms = vm.status.inferenceMs ? ` · ${vm.status.inferenceMs.toFixed(0)} ms` : '';
      const del = vm.delegate ? ` · ${vm.delegate}` : '';
      status.set(`${state}${fps}${ms}${del}${vm.status.message ? ' · ' + vm.status.message : ''}`, light);
      cameraSelect.setOptions([{ value: '', label: 'Default camera' }, ...vm.cameras.map((c) => ({ value: c.deviceId, label: c.label || 'Camera' }))]);
      if (vm.cameraId !== null) cameraSelect.set(vm.cameraId);
      presetSelect.setOptions(vm.presets.map((p) => ({ value: p, label: p })));
      presetSelect.set(vm.preset);
      wsInput.value = vm.wsUrl;
      recordingName.textContent = vm.recordingName ? `Take: ${vm.recordingName}` : 'No take loaded.';
      if (vm.playback) {
        scrub.dataset.duration = String(vm.playback.durationMs);
        if (!scrubbing && vm.playback.durationMs > 0) scrub.value = String((vm.playback.timeMs / vm.playback.durationMs) * 1000);
        timeLabel.textContent = `${(vm.playback.timeMs / 1000).toFixed(1)} / ${(vm.playback.durationMs / 1000).toFixed(1)} s`;
        loopToggle.set(vm.playback.loop);
        speedSelect.set(String(vm.playback.speed));
        playBtn.disabled = vm.playback.playing;
        pauseBtn.disabled = !vm.playback.playing;
      }
    },
  };
}
