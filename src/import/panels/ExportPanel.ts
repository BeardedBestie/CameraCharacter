import type { Panel } from '../../app/actions';
import { button, buttonRow, el, hint, row, section, select, toggle } from '../../app/ui';
import type { ExportActions, ExportVM } from '../actions';

export function createExportPanel(actions: ExportActions): Panel<ExportVM> {
  const sec = section('Export');

  const bakeFps = select<string>(
    [
      { value: '24', label: '24 fps' },
      { value: '30', label: '30 fps' },
      { value: '60', label: '60 fps' },
    ],
    '30',
    (v) => actions.setExportOption('bakeFps', Number(v)),
  );
  const envToggle = toggle('Include environment in GLB', false, (v) => actions.setExportOption('includeEnvironment', v));
  const bakeBtn = button('Bake animation', () => void actions.bake(), { title: 'Runs the whole clip through the retargeter offline and samples the bones' });
  const bakeInfo = el('span', { class: 'hint', text: '' });
  const bakeBar = el('i');
  const bakeProgress = el('div', { class: 'progress' }, bakeBar);
  const glbBtn = button('Export GLB (model + animation)', () => void actions.exportGlb(), { variant: 'primary' });
  const bvhBtn = button('Export BVH', () => void actions.exportBvh());
  const takeBtn = button('Save take (.mocap.json)', () => actions.exportTake());

  const pipToggle = toggle('Source video picture-in-picture', false, (v) => actions.setExportOption('renderPip', v));
  const audioToggle = toggle('Clip audio', true, (v) => actions.setExportOption('renderAudio', v));
  const renderBtn = button('Render video (plays the clip once)', () => void actions.renderVideo());
  const stopBtn = button('Stop', () => void actions.cancelRender(), { variant: 'danger' });
  const renderInfo = el('span', { class: 'hint', text: '' });

  sec.body.append(
    hint('Animation: the clip is re-solved from the first frame to the last (deterministic, faster than real time) and sampled for export.'),
    row('Sample rate', bakeFps.root),
    row('', envToggle.root),
    row('', el('div', { class: 'control' }, bakeBtn, bakeInfo)),
    bakeProgress,
    buttonRow(glbBtn, bvhBtn, takeBtn),
    hint('GLB and BVH bake first when needed. The take keeps the raw landmarks for re-targeting onto another model in the live app or here.'),
    hint('Video of the viewport with the current camera (free, follow or keyframes):'),
    row('', pipToggle.root),
    row('', audioToggle.root),
    row('', el('div', { class: 'control' }, renderBtn, stopBtn, renderInfo)),
  );

  return {
    root: sec.root,
    update(vm) {
      bakeFps.set(String(vm.bakeFps));
      envToggle.set(vm.includeEnvironment);
      envToggle.input.disabled = !vm.hasEnvironment;
      pipToggle.set(vm.renderPip);
      pipToggle.input.disabled = !vm.hasVideo;
      audioToggle.set(vm.renderAudio);
      audioToggle.input.disabled = !vm.hasVideo;
      const canBake = vm.hasClip && vm.hasModel && !vm.baking && !vm.rendering;
      bakeBtn.disabled = !canBake;
      bakeBtn.textContent = vm.baking ? 'Baking…' : 'Bake animation';
      bakeProgress.style.display = vm.baking ? '' : 'none';
      if (vm.baking) bakeBar.style.width = vm.baking.total ? `${Math.round((100 * vm.baking.done) / vm.baking.total)}%` : '0%';
      bakeInfo.textContent = vm.baking ? `${vm.baking.done} / ${vm.baking.total}` : vm.hasTake ? (vm.takeStale ? 'baked (stale: clip, model or rate changed)' : 'baked') : vm.hasClip && vm.hasModel ? 'not baked yet' : 'needs a clip and a rigged model';
      glbBtn.disabled = !canBake;
      bvhBtn.disabled = !canBake;
      takeBtn.disabled = !vm.hasClip;
      renderBtn.disabled = !vm.hasClip || !!vm.rendering || !!vm.baking;
      stopBtn.style.display = vm.rendering ? '' : 'none';
      renderInfo.textContent = vm.rendering ? `recording ${vm.rendering.seconds.toFixed(1)} s` : '';
    },
  };
}
