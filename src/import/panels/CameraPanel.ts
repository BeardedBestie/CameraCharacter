import type { Panel } from '../../app/actions';
import { button, buttonRow, clear, el, fileDrop, hint, row, section, select, slider } from '../../app/ui';
import type { CameraActions, CameraVM } from '../actions';
import type { CameraEase } from '../CameraTrack';
import { SHOT_LABELS, SHOT_NAMES } from '../cameraShots';
import type { ImportCameraMode } from '../state';

const EASES: { value: CameraEase; label: string }[] = [
  { value: 'smooth', label: 'smooth' },
  { value: 'linear', label: 'linear' },
  { value: 'cut', label: 'cut' },
];

export function createCameraPanel(actions: CameraActions): Panel<CameraVM> {
  const sec = section('Camera');

  const mode = select<ImportCameraMode>(
    [
      { value: 'orbit', label: 'Free (drag to orbit, wheel to zoom, right-drag to pan)' },
      { value: 'follow', label: 'Follow (full body, pans with the character)' },
      { value: 'track', label: 'Keyframes (plays the camera track below)' },
    ],
    'orbit',
    (v) => actions.setCameraMode(v),
  );
  const fov = slider({ min: 15, max: 100, step: 1, value: 35, format: (v) => `${v}°` }, (v) => actions.setFov(v));

  const shots = buttonRow(...SHOT_NAMES.map((name) => button(SHOT_LABELS[name], () => actions.applyShot(name))));

  const addBtn = button('+ Key at playhead', () => actions.addCameraKey(), { variant: 'primary', title: 'Store the current camera as a keyframe at the current time (K)' });
  const clearBtn = button('Clear keys', () => actions.clearCameraKeys());
  const keyList = el('div', { class: 'key-list' });
  const keysHint = el('div', { class: 'hint', text: 'No camera keyframes. Move the camera, scrub to a time and add a key; add more keys at other times and switch the mode to Keyframes to play the move.' });

  const turns = select<string>(
    [
      { value: '0.25', label: 'quarter turn' },
      { value: '0.5', label: 'half turn' },
      { value: '1', label: 'one turn' },
      { value: '2', label: 'two turns' },
    ],
    '1',
    () => undefined,
  );
  const orbitBtn = button('Add orbit shot', () => actions.addOrbitShot({ turns: Number(turns.root.value) }), { title: 'Replaces the keys with a camera orbit around the character over the whole clip' });

  const exportBtn = button('Export track (.json)', () => actions.exportCameraTrack());
  const importDrop = fileDrop('Import camera track (.json)', '.json', (files) => {
    if (files[0]) void actions.importCameraTrackFile(files[0]);
  });

  sec.body.append(
    row('Mode', mode.root),
    row('FOV', fov.root),
    hint('Shots (framed from the character’s height):'),
    shots,
    hint('Camera keyframes:'),
    buttonRow(addBtn, clearBtn),
    keyList,
    keysHint,
    row('Orbit', el('div', { class: 'control' }, turns.root, orbitBtn)),
    buttonRow(exportBtn),
    importDrop,
    hint('Shortcuts: K add key · [ ] previous/next key · C cycle camera mode.'),
  );

  let lastKey = '';

  return {
    root: sec.root,
    update(vm) {
      mode.set(vm.mode);
      fov.set(vm.fov);
      const key = vm.keys.map((k) => `${k.t.toFixed(3)}:${k.ease}:${k.active ? 1 : 0}`).join('|');
      if (key !== lastKey) {
        lastKey = key;
        clear(keyList);
        vm.keys.forEach((k, i) => {
          const time = button(`${k.t.toFixed(2)} s`, () => actions.jumpToCameraKey(i), { title: 'Jump to this key' });
          time.classList.add('key-time');
          const ease = select<CameraEase>(EASES, k.ease, (e) => actions.setCameraKeyEase(i, e));
          ease.root.classList.add('key-ease');
          const del = button('✕', () => actions.removeCameraKey(i), { title: 'Delete key' });
          keyList.appendChild(el('div', { class: 'key-item' + (k.active ? ' active' : '') }, el('span', { class: 'key-index', text: String(i + 1) }), time, ease.root, del));
        });
        keysHint.style.display = vm.keys.length ? 'none' : '';
      }
      sec.setBadge(vm.keys.length ? `(${vm.keys.length} keys)` : '');
      orbitBtn.disabled = !vm.hasModel;
      for (const b of Array.from(shots.querySelectorAll('button'))) b.disabled = !vm.hasModel;
    },
  };
}
