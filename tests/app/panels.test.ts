// @vitest-environment happy-dom
/**
 * The App refreshes every panel ten times a second. Panels must update the DOM
 * in place: rebuilding a <select>'s options closes its open dropdown, and
 * overwriting a text input clobbers what the user is typing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppActions, MappingRow, ModelVM, SourceVM } from '../../src/app/actions';
import { createModelPanel } from '../../src/app/panels/ModelPanel';
import { createSourcePanel } from '../../src/app/panels/SourcePanel';
import { SettingsStore } from '../../src/app/state';
import type { HumanoidBone } from '../../src/core/types';

function fakeActions(): AppActions {
  const handler: ProxyHandler<object> = { get: () => new Proxy(vi.fn(), handler) };
  return new Proxy({}, handler) as AppActions;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('source panel', () => {
  const vm = (over: Partial<SourceVM> = {}): SourceVM => ({
    kind: 'camera',
    status: { state: 'running', fps: 30 },
    cameras: [
      { deviceId: 'cam-1', label: 'FaceTime HD' },
      { deviceId: 'cam-2', label: 'USB camera' },
    ],
    cameraId: 'cam-2',
    presets: ['walk', 'wave'],
    preset: 'walk',
    wsUrl: 'ws://localhost:8765',
    recordingName: null,
    playback: null,
    delegate: 'GPU',
    ...over,
  });

  function cameraSelect(root: HTMLElement): HTMLSelectElement {
    const s = Array.from(root.querySelectorAll('select')).find((el) => Array.from(el.options).some((o) => o.value === 'cam-1'));
    if (!s) throw new Error('camera select not found');
    return s;
  }

  it('keeps the camera dropdown options across refreshes with an unchanged camera list', () => {
    const panel = createSourcePanel(new SettingsStore(), fakeActions());
    panel.update(vm());
    const sel = cameraSelect(panel.root);
    const before = Array.from(sel.options);
    expect(sel.value).toBe('cam-2');
    for (let i = 0; i < 5; i++) panel.update(vm({ status: { state: 'running', fps: 30 + i } }));
    const after = Array.from(sel.options);
    expect(after.length).toBe(before.length);
    expect(after.every((o, i) => o === before[i])).toBe(true);
    expect(sel.value).toBe('cam-2');
  });

  it('rebuilds the camera dropdown when a camera is added', () => {
    const panel = createSourcePanel(new SettingsStore(), fakeActions());
    panel.update(vm());
    const sel = cameraSelect(panel.root);
    panel.update(vm({ cameras: [...vm().cameras, { deviceId: 'cam-3', label: 'Capture card' }] }));
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['', 'cam-1', 'cam-2', 'cam-3']);
    expect(sel.value).toBe('cam-2');
  });

  it('does not overwrite the WebSocket URL while the field has focus', () => {
    const panel = createSourcePanel(new SettingsStore(), fakeActions());
    document.body.appendChild(panel.root);
    panel.update(vm({ kind: 'websocket' }));
    const input = panel.root.querySelector<HTMLInputElement>('input[type="url"]');
    if (!input) throw new Error('url input not found');
    expect(input.value).toBe('ws://localhost:8765');
    input.focus();
    expect(document.activeElement).toBe(input);
    input.value = 'ws://192.168.1.20:87';
    panel.update(vm({ kind: 'websocket' }));
    expect(input.value).toBe('ws://192.168.1.20:87');
    input.blur();
    panel.update(vm({ kind: 'websocket' }));
    expect(input.value).toBe('ws://localhost:8765');
  });
});

describe('model panel', () => {
  const row = (role: HumanoidBone, bone: string | null, errorDeg: number | null, over: Partial<MappingRow> = {}): MappingRow => ({
    role,
    bone,
    confidence: 0.95,
    mode: 'auto',
    rollOffsetDeg: 0,
    anatomical: true,
    errorDeg,
    overridden: false,
    ...over,
  });
  const vm = (errorDeg: number | null, over: Partial<ModelVM> = {}): ModelVM => ({
    name: 'Rig',
    loading: false,
    progress: null,
    family: 'mixamo',
    familyKey: 'k',
    warnings: ['one warning'],
    rows: [row('hips', 'Hips', errorDeg), row('spine', 'Spine', errorDeg), row('head', 'Head', errorDeg)],
    boneNames: ['Hips', 'Spine', 'Head', 'Neck'],
    unrigged: false,
    sourceHeight: 1.7,
    scale: 1,
    environmentName: null,
    ...over,
  });
  const boneSelects = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLSelectElement>('.mapping-table select'));
  const errorCells = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('.mapping-table tr td:last-child'));

  it('keeps the bone dropdowns and updates error cells in place when only errors change', () => {
    const panel = createModelPanel(new SettingsStore(), fakeActions());
    panel.update(vm(2));
    const selects = boneSelects(panel.root);
    expect(selects.length).toBe(3);
    expect(selects[0]!.value).toBe('Hips');
    expect(errorCells(panel.root).map((c) => c.textContent)).toEqual(['2°', '2°', '2°']);
    const warning = panel.root.querySelector('.warning-list li');
    panel.update(vm(7));
    const again = boneSelects(panel.root);
    expect(again.every((s, i) => s === selects[i])).toBe(true);
    expect(Array.from(again[0]!.options).every((o, i) => o === selects[0]!.options[i])).toBe(true);
    const cells = errorCells(panel.root);
    expect(cells.map((c) => c.textContent)).toEqual(['7°', '7°', '7°']);
    expect(cells.every((c) => c.classList.contains('low'))).toBe(true);
    expect(panel.root.querySelector('.warning-list li')).toBe(warning);
  });

  it('rebuilds the table when the mapping changes', () => {
    const panel = createModelPanel(new SettingsStore(), fakeActions());
    panel.update(vm(2));
    const first = boneSelects(panel.root)[0]!;
    panel.update(vm(2, { rows: [row('hips', 'Hips', 2), row('spine', 'Spine', 2), row('head', 'Neck', 2, { overridden: true })] }));
    const selects = boneSelects(panel.root);
    expect(selects[0]).not.toBe(first);
    expect(selects[2]!.value).toBe('Neck');
    expect(selects[2]!.title).toBe('Overridden by you');
  });

  it('clears the table when the model is unloaded', () => {
    const panel = createModelPanel(new SettingsStore(), fakeActions());
    panel.update(vm(2));
    panel.update(vm(null, { name: null, rows: [], boneNames: [], warnings: [] }));
    expect(boneSelects(panel.root).length).toBe(0);
    expect(panel.root.querySelectorAll('.warning-list li').length).toBe(0);
  });
});
