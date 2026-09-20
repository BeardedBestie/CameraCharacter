import type { CameraMode, HipsMode } from '../../core/types';
import type { AppActions, Panel } from '../actions';
import type { SettingsStore } from '../state';
import { hint, row, section, select, slider, textInput, toggle } from '../ui';

export function createStagePanel(store: SettingsStore, _actions: AppActions): Panel<void> {
  const sec = section('Stage');
  const s = store.get();

  const mirror = toggle('Mirror mode (like a mirror; off = actor mode)', s.stage.mirror, (v) => store.update({ stage: { mirror: v } }));
  const camera = select<CameraMode>(
    [
      { value: 'mirror', label: 'Mirror (frames the character as the webcam frames you)' },
      { value: 'follow', label: 'Follow (full body, pans with you)' },
      { value: 'orbit', label: 'Free / orbit (mouse controlled)' },
    ],
    s.stage.cameraMode,
    (v) => store.update({ stage: { cameraMode: v } }),
  );
  const hips = select<HipsMode>(
    [
      { value: 'locked', label: 'Locked (rotate in place)' },
      { value: 'horizontal', label: 'Horizontal (sideways + depth)' },
      { value: 'full', label: 'Full (also crouch/jump)' },
    ],
    s.stage.hipsMode,
    (v) => store.update({ stage: { hipsMode: v } }),
  );
  const fov = slider({ min: 20, max: 70, step: 1, value: s.stage.mirrorCameraFovDeg, format: (v) => `${v}°` }, (v) =>
    store.update({ stage: { mirrorCameraFovDeg: v } }),
  );
  const floor = toggle('Floor', s.stage.showFloor, (v) => store.update({ stage: { showFloor: v } }));
  const grid = toggle('Grid', s.stage.showGrid, (v) => store.update({ stage: { showGrid: v } }));
  const skeleton = toggle('Show tracked skeleton in 3D', s.stage.showLandmarkSkeleton, (v) => store.update({ stage: { showLandmarkSkeleton: v } }));
  const background = textInput(s.stage.background, (v) => store.update({ stage: { background: v } }), { placeholder: '#15171c' });
  const diagnostics = toggle('Diagnostics (per-bone error, overlays)', s.diagnostics, (v) => store.update({ diagnostics: v }));

  sec.body.append(
    row('', mirror.root),
    row('Camera', camera.root),
    hint('Drag or scroll on the viewport to take over the camera: left-drag rotates, wheel zooms, right-drag or two fingers pan. Double-click the viewport to return to the automatic camera.'),
    row('Mirror FOV', fov.root),
    row('Translation', hips.root),
    hint('In mirror camera mode depth drives the framing rather than the character.'),
    row('', floor.root),
    row('', grid.root),
    row('', skeleton.root),
    row('Background', background),
    row('', diagnostics.root),
  );

  store.subscribe((st) => {
    mirror.set(st.stage.mirror);
    camera.set(st.stage.cameraMode);
    hips.set(st.stage.hipsMode);
    fov.set(st.stage.mirrorCameraFovDeg);
    floor.set(st.stage.showFloor);
    grid.set(st.stage.showGrid);
    skeleton.set(st.stage.showLandmarkSkeleton);
    background.value = st.stage.background;
    diagnostics.set(st.diagnostics);
  });

  return { root: sec.root, update() {} };
}
