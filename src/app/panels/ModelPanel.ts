import { BODY_BONES, type BoneRefMode, type HumanoidBone } from '../../core/types';
import type { AppActions, MappingRow, ModelVM, Panel } from '../actions';
import { SAMPLE_MODELS, type SettingsStore } from '../state';
import { button, buttonRow, clear, confidenceClass, el, fileDrop, hint, row, section, select, slider } from '../ui';

const ROLE_LABELS: Partial<Record<HumanoidBone, string>> = {
  hips: 'Hips',
  spine: 'Spine',
  chest: 'Chest',
  upperChest: 'Upper chest',
  neck: 'Neck',
  head: 'Head',
  leftShoulder: 'L shoulder',
  leftUpperArm: 'L upper arm',
  leftLowerArm: 'L lower arm',
  leftHand: 'L hand',
  rightShoulder: 'R shoulder',
  rightUpperArm: 'R upper arm',
  rightLowerArm: 'R lower arm',
  rightHand: 'R hand',
  leftUpperLeg: 'L upper leg',
  leftLowerLeg: 'L lower leg',
  leftFoot: 'L foot',
  leftToes: 'L toes',
  rightUpperLeg: 'R upper leg',
  rightLowerLeg: 'R lower leg',
  rightFoot: 'R foot',
  rightToes: 'R toes',
};

export function roleLabel(role: HumanoidBone): string {
  return ROLE_LABELS[role] ?? role;
}

const MODES: { value: BoneRefMode; label: string }[] = [
  { value: 'auto', label: 'auto' },
  { value: 'relative', label: 'relative' },
  { value: 'calibrated', label: 'calibrated' },
  { value: 'follow', label: 'follow' },
  { value: 'off', label: 'off' },
];

export function createModelPanel(store: SettingsStore, actions: AppActions): Panel<ModelVM> {
  const sec = section('Model');
  const s = store.get();

  const drop = fileDrop('Drop or choose a model (.glb, .gltf, .fbx, .vrm)', '.glb,.gltf,.fbx,.vrm', (files) => {
    if (files[0]) void actions.loadModelFile(files[0]);
  });
  const sampleSelect = select<string>(
    [{ value: '', label: 'Load a sample model…' }, ...SAMPLE_MODELS.map((m) => ({ value: m.id, label: m.label }))],
    '',
    (id) => {
      const m = SAMPLE_MODELS.find((x) => x.id === id);
      if (m) void actions.loadModelUrl(m.url, m.label);
      sampleSelect.set('');
    },
  );
  const heightSlider = slider({ min: 0.5, max: 3, step: 0.05, value: s.stage.targetHeight, format: (v) => `${v.toFixed(2)} m` }, (v) =>
    store.update({ stage: { targetHeight: v } }),
  );
  const info = el('div', { class: 'hint', text: 'No model loaded.' });
  const progress = el('div', { class: 'progress' }, el('i'));
  const warnings = el('ul', { class: 'warning-list' });

  const envDrop = fileDrop('Environment scene (.glb) — optional', '.glb,.gltf', (files) => {
    if (files[0]) void actions.loadEnvironmentFile(files[0]);
  });
  const envInfo = el('span', { class: 'hint', text: 'No environment.' });
  const envClear = button('Clear', () => actions.clearEnvironment());

  const table = el('table', { class: 'mapping-table' });
  const showAdvanced = { value: false };
  const advancedBtn = button('Show modes & roll', () => {
    showAdvanced.value = !showAdvanced.value;
    advancedBtn.textContent = showAdvanced.value ? 'Hide modes & roll' : 'Show modes & roll';
    if (lastVm) render(lastVm);
  });
  const swapBtn = button('Swap sides', () => actions.swapSides(), { title: 'Mirror the left/right assignment' });
  const resetBtn = button('Reset mapping', () => actions.resetMapping());
  const exportBtn = button('Export profile', () => actions.exportProfile());
  const importDrop = fileDrop('Import profile (.json)', '.json', (files) => {
    if (files[0]) void actions.importProfile(files[0]);
  });

  sec.body.append(
    drop,
    row('Samples', sampleSelect.root),
    info,
    progress,
    warnings,
    row('Height', heightSlider.root),
    hint('Every model is scaled to this height so translation, framing and exports are in meters.'),
    row('Environment', el('div', { class: 'control' }, envInfo, envClear)),
    envDrop,
    el('div', { class: 'hint', text: 'Bone mapping (auto-detected; change a dropdown to override):' }),
    table,
    buttonRow(advancedBtn, swapBtn, resetBtn, exportBtn),
    importDrop,
  );

  store.subscribe((st) => heightSlider.set(st.stage.targetHeight));

  let lastVm: ModelVM | null = null;
  /**
   * `update` runs on every periodic panel refresh. The table is rebuilt only
   * when its structure changes (rows, bone options, columns); the per-bone
   * error cells update in place. Recreating the rows on every refresh would
   * replace every bone dropdown ten times a second, which closes an open
   * dropdown at once and stalls the page with DOM churn.
   */
  let tableKey = '';
  let warningsKey: string | null = null;
  const errorCells = new Map<HumanoidBone, HTMLElement>();

  function tableStructureKey(vm: ModelVM): string {
    return JSON.stringify([
      showAdvanced.value,
      vm.boneNames,
      vm.rows.map((r) => [r.role, r.bone, r.confidence, r.mode, r.rollOffsetDeg, r.anatomical, r.overridden]),
    ]);
  }

  function setErrorCell(cell: HTMLElement, errorDeg: number | null): void {
    const text = errorDeg === null ? '' : `${errorDeg.toFixed(0)}°`;
    const cls = 'conf ' + (errorDeg !== null && errorDeg > 5 ? 'low' : 'high');
    if (cell.textContent !== text) cell.textContent = text;
    if (cell.className !== cls) cell.className = cls;
  }

  function render(vm: ModelVM): void {
    const key = tableStructureKey(vm);
    if (key === tableKey) {
      for (const r of vm.rows) {
        const cell = errorCells.get(r.role);
        if (cell) setErrorCell(cell, r.errorDeg);
      }
      return;
    }
    tableKey = key;
    errorCells.clear();
    clear(table);
    if (!vm.rows.length) return;
    const head = el(
      'tr',
      {},
      el('th', { text: 'Role' }),
      el('th', { text: 'Bone' }),
      el('th', { text: 'Conf' }),
      showAdvanced.value ? el('th', { text: 'Mode' }) : null,
      showAdvanced.value ? el('th', { text: 'Roll' }) : null,
      el('th', { text: 'Err' }),
    );
    table.appendChild(head);
    const boneOptions = [{ value: '', label: '— none —' }, ...vm.boneNames.map((b) => ({ value: b, label: b }))];
    const rows = vm.rows.filter((r) => (BODY_BONES as readonly string[]).includes(r.role));
    for (const r of rows) table.appendChild(renderRow(r, boneOptions));
  }

  function renderRow(r: MappingRow, boneOptions: { value: string; label: string }[]): HTMLElement {
    const boneSel = select<string>(boneOptions, r.bone ?? '', (v) => actions.setMappingOverride(r.role, v || null));
    boneSel.root.title = r.overridden ? 'Overridden by you' : 'Auto-detected';
    if (r.overridden) boneSel.root.style.borderColor = 'var(--accent)';
    const conf = el('td', { class: 'conf ' + confidenceClass(r.confidence), text: r.bone ? r.confidence.toFixed(2) : '' });
    const cells: (HTMLElement | null)[] = [
      el('td', { text: roleLabel(r.role), title: r.anatomical === false ? 'Bind pose is not anatomical for this role' : '' }),
      el('td', {}, boneSel.root),
      conf,
    ];
    if (showAdvanced.value) {
      const modeSel = select<BoneRefMode>(MODES, r.mode, (m) => actions.setBoneMode(r.role, m));
      const roll = el('input', { type: 'number', min: -180, max: 180, step: 5, style: 'width:60px' });
      roll.value = String(r.rollOffsetDeg);
      roll.addEventListener('change', () => actions.setBoneRoll(r.role, Number(roll.value)));
      cells.push(el('td', {}, modeSel.root), el('td', {}, roll));
    }
    const errCell = el('td');
    setErrorCell(errCell, r.errorDeg);
    errorCells.set(r.role, errCell);
    cells.push(errCell);
    if (r.anatomical === false) cells[0]!.style.color = 'var(--warn)';
    return el('tr', {}, ...cells);
  }

  return {
    root: sec.root,
    update(vm) {
      lastVm = vm;
      const parts: string[] = [];
      if (vm.name) parts.push(vm.name);
      if (vm.family) parts.push(`family: ${vm.family}`);
      if (vm.sourceHeight !== null && vm.scale !== null) parts.push(`source height ${vm.sourceHeight.toFixed(3)} × ${vm.scale.toFixed(2)}`);
      if (vm.unrigged) parts.push('no skeleton (static mesh)');
      info.textContent = vm.loading ? `Loading ${vm.name ?? ''}…` : parts.join(' · ') || 'No model loaded.';
      (progress.firstElementChild as HTMLElement).style.width = vm.loading && vm.progress !== null ? `${Math.round(vm.progress * 100)}%` : '0%';
      progress.style.display = vm.loading ? '' : 'none';
      const wk = vm.warnings.join('\n');
      if (wk !== warningsKey) {
        warningsKey = wk;
        clear(warnings);
        for (const w of vm.warnings) warnings.appendChild(el('li', { text: w }));
      }
      envInfo.textContent = vm.environmentName ? vm.environmentName : 'No environment.';
      envClear.disabled = !vm.environmentName;
      sec.setBadge(vm.name ? `(${vm.rows.filter((r) => r.bone).length} bones)` : '');
      render(vm);
    },
  };
}
