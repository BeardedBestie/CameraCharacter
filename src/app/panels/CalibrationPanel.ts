import type { AppActions, CalibrationVM, Panel } from '../actions';
import type { SettingsStore } from '../state';
import { button, buttonRow, chip, el, hint, row, section } from '../ui';

export function createCalibrationPanel(_store: SettingsStore, actions: AppActions): Panel<CalibrationVM> {
  const sec = section('Calibration');

  const baseline = chip('baseline: waiting');
  const calib = chip('no pose calibration');
  const calibrateBtn = button('Calibrate pose (3 s)', () => void actions.startPoseCalibration(), { variant: 'primary' });
  const clearBtn = button('Clear', () => actions.clearPoseCalibration());
  const baselineBtn = button('Re-capture baseline', () => actions.resetBaseline());
  const snapshotBtn = button('Diagnostic snapshot', () => void actions.takeSnapshot());
  const resetBonesBtn = button('Reset bone modes & roll', () => actions.resetBoneSettings());

  sec.body.append(
    row('Standing', baseline.root),
    hint('The standing baseline is captured automatically from the first seconds of full-body tracking. Stand naturally facing the camera.'),
    row('Pose', calib.root),
    buttonRow(calibrateBtn, clearBtn, baselineBtn),
    hint(
      'Optional: the character shows its rest pose; match it like a mirror and hold still during the countdown. Use this for stylized rigs or if limbs sit at a constant offset.',
    ),
    el('div', { class: 'hint', html: 'Per-bone modes and roll trims are in the Model section (<i>Show modes &amp; roll</i>).' }),
    buttonRow(resetBonesBtn),
    buttonRow(snapshotBtn),
    hint('The snapshot saves a side-by-side image plus a JSON bundle you can share (or paste to an LLM) to diagnose a rig.'),
  );

  return {
    root: sec.root,
    update(vm) {
      baseline.set(vm.baselineReady ? 'baseline captured' : 'baseline: waiting for full body', vm.baselineReady ? 'good' : 'warn');
      if (vm.capturing) calib.set(vm.countdown !== null ? `hold… ${vm.countdown}` : 'capturing…', 'warn');
      else if (vm.hasCalibration) calib.set(`calibrated ${vm.calibratedAt ? new Date(vm.calibratedAt).toLocaleTimeString() : ''}`, 'good');
      else calib.set('no pose calibration', 'off');
      calibrateBtn.disabled = vm.capturing;
      clearBtn.disabled = !vm.hasCalibration || vm.capturing;
      snapshotBtn.disabled = vm.snapshotBusy;
      snapshotBtn.textContent = vm.snapshotBusy ? 'Capturing…' : 'Diagnostic snapshot';
    },
  };
}
