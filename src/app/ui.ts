/**
 * Small typed DOM helpers for the control panel. No framework; every control
 * returns its element plus a setter so panels can reflect state changes.
 */

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export interface Section {
  root: HTMLElement;
  body: HTMLElement;
  setCollapsed(v: boolean): void;
  setBadge(text: string): void;
}

export function section(title: string, opts: { collapsed?: boolean; id?: string } = {}): Section {
  const caret = el('span', { class: 'caret', text: '▾' });
  const badge = el('span', { class: 'hint' });
  const head = el('div', { class: 'section-title' }, el('span', {}, title, ' ', badge), caret);
  const body = el('div', { class: 'section-body' });
  const root = el('div', { class: 'section' + (opts.collapsed ? ' collapsed' : ''), id: opts.id }, head, body);
  head.addEventListener('click', () => root.classList.toggle('collapsed'));
  return {
    root,
    body,
    setCollapsed: (v) => root.classList.toggle('collapsed', v),
    setBadge: (text) => {
      badge.textContent = text;
    },
  };
}

export function row(label: string, control: HTMLElement, opts: { wide?: boolean } = {}): HTMLElement {
  if (opts.wide) return el('div', { class: 'row wide' }, control);
  return el('div', { class: 'row' }, el('label', { text: label }), control);
}

export function hint(text: string): HTMLElement {
  return el('div', { class: 'hint', text });
}

export interface SelectControl<T extends string> {
  root: HTMLSelectElement;
  set(value: T): void;
  setOptions(options: { value: T; label: string }[]): void;
}

/**
 * `set` and `setOptions` are no-ops when nothing changed. Panels call them on
 * every periodic refresh, and replacing a select's options (or re-assigning its
 * value) while its dropdown is open closes the dropdown immediately.
 */
export function select<T extends string>(
  options: { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
): SelectControl<T> {
  const root = el('select');
  let current: { value: T; label: string }[] = [];
  const same = (opts: { value: T; label: string }[]) =>
    opts.length === current.length && opts.every((o, i) => o.value === current[i]!.value && o.label === current[i]!.label);
  const fill = (opts: { value: T; label: string }[]) => {
    current = opts.map((o) => ({ value: o.value, label: o.label }));
    clear(root);
    for (const o of opts) root.appendChild(el('option', { value: o.value, text: o.label }));
  };
  fill(options);
  root.value = value;
  root.addEventListener('change', () => onChange(root.value as T));
  return {
    root,
    set: (v) => {
      if (root.value !== v) root.value = v;
    },
    setOptions: (opts) => {
      if (same(opts)) return;
      const cur = root.value;
      fill(opts);
      if (opts.some((o) => o.value === cur)) root.value = cur;
    },
  };
}

export interface ToggleControl {
  root: HTMLElement;
  input: HTMLInputElement;
  set(v: boolean): void;
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void): ToggleControl {
  const input = el('input', { type: 'checkbox' });
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  const root = el('label', { class: 'toggle' }, input, el('span', { text: label }));
  return {
    root,
    input,
    set: (v) => {
      input.checked = v;
    },
  };
}

export interface SliderControl {
  root: HTMLElement;
  input: HTMLInputElement;
  set(v: number): void;
}

export function slider(
  opts: { min: number; max: number; step: number; value: number; format?: (v: number) => string },
  onChange: (v: number) => void,
): SliderControl {
  const input = el('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step });
  input.value = String(opts.value);
  const fmt = opts.format ?? ((v: number) => (Number.isInteger(opts.step) ? String(v) : v.toFixed(2)));
  const value = el('span', { class: 'slider-value', text: fmt(opts.value) });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    value.textContent = fmt(v);
    onChange(v);
  });
  const root = el('div', { class: 'control' }, input, value);
  return {
    root,
    input,
    set: (v) => {
      input.value = String(v);
      value.textContent = fmt(v);
    },
  };
}

export function button(
  label: string,
  onClick: () => void,
  opts: { variant?: 'primary' | 'danger' | 'default'; title?: string } = {},
): HTMLButtonElement {
  const b = el('button', { text: label, title: opts.title });
  if (opts.variant && opts.variant !== 'default') b.classList.add(opts.variant);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

export function buttonRow(...buttons: HTMLElement[]): HTMLElement {
  return el('div', { class: 'button-row' }, ...buttons);
}

export function textInput(value: string, onChange: (v: string) => void, opts: { placeholder?: string; type?: string } = {}): HTMLInputElement {
  const input = el('input', { type: opts.type ?? 'text', placeholder: opts.placeholder });
  input.value = value;
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

export function fileDrop(label: string, accept: string, onFiles: (files: File[]) => void): HTMLElement {
  const input = el('input', { type: 'file', accept, multiple: true });
  input.addEventListener('change', () => {
    if (input.files && input.files.length) onFiles(Array.from(input.files));
    input.value = '';
  });
  const root = el('label', { class: 'file-drop' }, label, input);
  return root;
}

export type LightState = 'good' | 'warn' | 'bad' | 'off';

export interface Chip {
  root: HTMLElement;
  set(text: string, state?: LightState): void;
}

export function chip(label: string, state: LightState = 'off'): Chip {
  const light = el('span', { class: 'light' });
  const text = el('b', { text: label });
  const root = el('span', { class: 'chip' }, light, text);
  const set = (t: string, s: LightState = 'off') => {
    text.textContent = t;
    light.className = 'light' + (s === 'off' ? '' : ' ' + s);
  };
  set(label, state);
  return { root, set };
}

export function confidenceClass(c: number): string {
  return c >= 0.9 ? 'high' : c >= 0.6 ? 'mid' : 'low';
}

/** Draggable positioning for an absolutely positioned element (mouse and touch). */
export function makeDraggable(node: HTMLElement, handle: HTMLElement = node): void {
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;
  let dragging = false;
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    node.style.left = `${originLeft + dx}px`;
    node.style.top = `${originTop + dy}px`;
    node.style.bottom = 'auto';
    node.style.right = 'auto';
  };
  const onUp = () => {
    dragging = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button, select, input')) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = node.getBoundingClientRect();
    const parentRect = node.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
    originLeft = rect.left - parentRect.left;
    originTop = rect.top - parentRect.top;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    e.preventDefault();
  });
}

export class Toasts {
  private root: HTMLElement;
  constructor(parent: HTMLElement) {
    this.root = el('div', { id: 'toasts' });
    parent.appendChild(this.root);
  }
  show(message: string, kind: 'info' | 'warn' | 'bad' = 'info', ms = 4000): void {
    const t = el('div', { class: 'toast' + (kind === 'info' ? '' : ' ' + kind), text: message });
    this.root.appendChild(t);
    window.setTimeout(() => t.remove(), ms);
  }
}
