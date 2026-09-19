import type { AppActions, Panel, RecordingVM } from '../actions';
import type { SettingsStore } from '../state';
import { button, buttonRow, el, hint, row, section, select, toggle } from '../ui';

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function createRecordingPanel(_store: SettingsStore, actions: AppActions): Panel<RecordingVM> {
  const sec = section('Recording');

  const takeBtn = button('● Record take', () => void actions.toggleRecording('take'));
  const takeInfo = el('span', { class: 'hint', text: 'raw landmarks (.mocap.json), re-targetable' });
  const clipBtn = button('● Record animation', () => void actions.toggleRecording('clip'));
  const clipInfo = el('span', { class: 'hint', text: 'bone animation for GLB / BVH export' });
  const videoBtn = button('● Record video', () => void actions.toggleRecording('video'));
  const videoInfo = el('span', { class: 'hint', text: 'viewport video' });

  const fpsSelect = select<string>(
    [
      { value: '30', label: '30 fps' },
      { value: '60', label: '60 fps' },
    ],
    '30',
    (v) => actions.setRecordingOption('fps', Number(v)),
  );
  const envToggle = toggle('Include environment in GLB', false, (v) => actions.setRecordingOption('includeEnvironment', v));
  const pipToggle = toggle('Webcam picture-in-picture in video', false, (v) => actions.setRecordingOption('pip', v));
  const micToggle = toggle('Microphone audio in video', false, (v) => actions.setRecordingOption('microphone', v));

  const exportTake = button('Save take (.mocap.json)', () => actions.exportTake());
  const exportGlb = button('Export GLB (model + animation)', () => void actions.exportClipGlb(), { variant: 'primary' });
  const exportBvh = button('Export BVH', () => actions.exportBvh());

  sec.body.append(
    row('', el('div', { class: 'control' }, takeBtn, takeInfo)),
    row('', el('div', { class: 'control' }, clipBtn, clipInfo)),
    row('', el('div', { class: 'control' }, videoBtn, videoInfo)),
    row('Sample rate', fpsSelect.root),
    row('', envToggle.root),
    row('', pipToggle.root),
    row('', micToggle.root),
    hint('Exports:'),
    buttonRow(exportTake, exportGlb, exportBvh),
    hint('Shortcuts: R take · A animation · V video · Space play/pause a take.'),
  );

  return {
    root: sec.root,
    update(vm) {
      const setBtn = (b: HTMLButtonElement, label: string, rec: { active: boolean; frames?: number; seconds: number }) => {
        b.classList.toggle('recording', rec.active);
        b.textContent = rec.active ? `■ Stop (${fmt(rec.seconds)})` : `● ${label}`;
      };
      setBtn(takeBtn, 'Record take', vm.take);
      setBtn(clipBtn, 'Record animation', vm.clip);
      setBtn(videoBtn, 'Record video', vm.video);
      takeInfo.textContent = vm.take.active ? `${vm.take.frames} frames` : 'raw landmarks (.mocap.json), re-targetable';
      clipInfo.textContent = vm.clip.active ? `${vm.clip.frames} samples` : 'bone animation for GLB / BVH export';
      videoInfo.textContent = vm.video.active ? vm.video.mime ?? 'recording' : 'viewport video';
      fpsSelect.set(String(vm.fps));
      envToggle.set(vm.includeEnvironment);
      pipToggle.set(vm.pip);
      micToggle.set(vm.microphone);
      exportTake.disabled = !vm.hasTake;
      exportGlb.disabled = !vm.hasClip;
      exportBvh.disabled = !vm.hasClip;
    },
  };
}
