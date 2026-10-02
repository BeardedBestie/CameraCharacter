import type { Panel } from '../../app/actions';
import type { SettingsStore } from '../../app/state';
import { hint, row, section, select, textInput, toggle } from '../../app/ui';
import type { HipsMode } from '../../core/types';
import type { ImportActions } from '../actions';

export function createImportStagePanel(store: SettingsStore, actions: Pick<ImportActions, 'setPipVisible' | 'setAudio'>, initial: { pip: boolean; audio: boolean }): Panel<{ pip: boolean; audio: boolean }> {
  const sec = section('Stage', { collapsed: true });
  const s = store.get();

  const mirror = toggle('Mirror the actor (off = the character copies the actor’s own left and right)', s.stage.mirror, (v) => store.update({ stage: { mirror: v } }));
  const hips = select<HipsMode>(
    [
      { value: 'locked', label: 'Locked (stays in place; safest for moving cameras)' },
      { value: 'horizontal', label: 'Horizontal (sideways + depth from the footage)' },
      { value: 'full', label: 'Full (also crouch / jump)' },
    ],
    s.stage.hipsMode,
    (v) => store.update({ stage: { hipsMode: v } }),
  );
  const floor = toggle('Floor', s.stage.showFloor, (v) => store.update({ stage: { showFloor: v } }));
  const grid = toggle('Grid', s.stage.showGrid, (v) => store.update({ stage: { showGrid: v } }));
  const skeleton = toggle('Show tracked skeleton in 3D', s.stage.showLandmarkSkeleton, (v) => store.update({ stage: { showLandmarkSkeleton: v } }));
  const background = textInput(s.stage.background, (v) => store.update({ stage: { background: v } }), { placeholder: '#15171c' });
  const diagnostics = toggle('Diagnostics (per-bone error, framing fit)', s.diagnostics, (v) => store.update({ diagnostics: v }));
  const pip = toggle('Source video picture-in-picture', initial.pip, (v) => actions.setPipVisible(v));
  const audio = toggle('Play the clip’s audio', initial.audio, (v) => actions.setAudio(v));

  sec.body.append(
    row('', mirror.root),
    row('Translation', hips.root),
    hint('Translation follows the actor in the footage. With a hand-held or zooming camera the depth estimate drifts; keep it locked then.'),
    row('', floor.root),
    row('', grid.root),
    row('', skeleton.root),
    row('Background', background),
    row('', diagnostics.root),
    row('', pip.root),
    row('', audio.root),
  );

  store.subscribe((st) => {
    mirror.set(st.stage.mirror);
    hips.set(st.stage.hipsMode);
    floor.set(st.stage.showFloor);
    grid.set(st.stage.showGrid);
    skeleton.set(st.stage.showLandmarkSkeleton);
    background.value = st.stage.background;
    diagnostics.set(st.diagnostics);
  });

  return {
    root: sec.root,
    update(vm) {
      pip.set(vm.pip);
      audio.set(vm.audio);
    },
  };
}
