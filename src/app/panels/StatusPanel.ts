import type { AppActions, Panel, StatusVM } from '../actions';
import type { SettingsStore } from '../state';
import { chip, clear, el, section } from '../ui';
import { roleLabel } from './ModelPanel';

export function createStatusPanel(store: SettingsStore, _actions: AppActions): Panel<StatusVM> {
  const sec = section('Status');
  const subject = chip('no subject');
  const framing = chip('framing: none');
  const perf = chip('render — · inference —');
  const aux = chip('hands — · face —');
  const diagram = el('div', { class: 'body-diagram' });
  const errors = el('div', { class: 'error-list' });
  const errorsTitle = el('div', { class: 'hint', text: 'Per-bone error (measured vs solved direction):' });

  sec.body.append(el('div', { class: 'button-row' }, subject.root, framing.root), el('div', { class: 'button-row' }, perf.root, aux.root), diagram, errorsTitle, errors);

  const partEls = new Map<string, { bar: HTMLElement; label: HTMLElement }>();
  const ensurePart = (name: string) => {
    let p = partEls.get(name);
    if (!p) {
      const bar = el('i');
      const label = el('span', { text: name });
      diagram.appendChild(el('div', { class: 'body-part' }, label, el('div', { class: 'bar' }, bar)));
      p = { bar, label };
      partEls.set(name, p);
    }
    return p;
  };

  let showErrors = store.get().diagnostics;
  store.subscribe((s) => {
    showErrors = s.diagnostics;
  });

  return {
    root: sec.root,
    update(vm) {
      subject.set(vm.present ? 'subject tracked' : 'no subject', vm.present ? 'good' : 'bad');
      framing.set(`framing: ${vm.framing}${vm.depthZ !== null ? ` · ${vm.depthZ.toFixed(2)} m` : ''}`, vm.framing === 'none' ? 'off' : 'good');
      perf.set(`render ${vm.renderFps.toFixed(0)} · inference ${vm.inferenceFps.toFixed(0)} fps (${vm.inferenceMs.toFixed(0)} ms)`, 'off');
      aux.set(`hands ${vm.hands.left ? 'L' : '–'}${vm.hands.right ? 'R' : '–'} · face ${vm.face ? 'on' : '–'}`, 'off');
      for (const part of vm.parts) {
        const p = ensurePart(part.name);
        p.bar.style.width = `${Math.round(part.confidence * 100)}%`;
        p.bar.style.background = part.confidence > 0.6 ? 'var(--good)' : part.confidence > 0.3 ? 'var(--warn)' : 'var(--bad)';
      }
      errorsTitle.style.display = showErrors ? '' : 'none';
      errors.style.display = showErrors ? '' : 'none';
      if (showErrors) {
        clear(errors);
        for (const e of vm.errors) {
          const cls = e.flagged ? 'flagged' : '';
          errors.append(
            el('span', { class: cls, text: roleLabel(e.role) }),
            el('span', { class: cls, text: e.errorDeg === null ? '–' : `${e.errorDeg.toFixed(1)}°` }),
            el('span', { class: cls, text: e.flagged ? '!' : '' }),
          );
        }
        for (const c of vm.chainErrors) {
          errors.append(el('span', { text: c.name }), el('span', { text: c.errorDeg === null ? '–' : `${c.errorDeg.toFixed(1)}°` }), el('span'));
        }
      }
    },
  };
}
