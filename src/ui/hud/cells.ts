/**
 * The HUD's building blocks: element helpers and the write-if-changed cells every part of the
 * HUD draws through. A cell remembers what it last wrote and touches the DOM only on a
 * difference, which is what makes `update` free on a frame where nothing changed.
 */

import { intString } from './hud-model';

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function span(className: string, text?: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Text node content, written only when the string differs. */
export class TextCell {
  private last: string;
  constructor(
    readonly node: HTMLElement,
    initial = '',
  ) {
    this.last = initial;
    if (initial !== '') node.textContent = initial;
  }
  set(value: string): void {
    if (value === this.last) return;
    this.last = value;
    this.node.textContent = value;
  }
}

/** A whole number shown through the string table, written only when the number differs. */
export class NumberCell {
  private last = Number.NaN;
  constructor(readonly node: HTMLElement) {}
  set(value: number): void {
    if (value === this.last) return;
    this.last = value;
    this.node.textContent = intString(value);
  }
  /** Shows fixed text (a dash) instead of a number. */
  setText(text: string, key: number): void {
    if (key === this.last) return;
    this.last = key;
    this.node.textContent = text;
  }
}

/** A CSS custom property (or plain property) fed from a string table by integer step. */
export class StepStyle {
  private last = -1;
  constructor(
    private readonly node: HTMLElement | SVGElement,
    private readonly property: string,
    private readonly table: readonly string[],
  ) {}
  set(step: number): void {
    if (step === this.last) return;
    this.last = step;
    this.node.style.setProperty(this.property, this.table[step] ?? this.table[0] ?? '0');
  }
}

/** `hidden`, written only on a change. Starts hidden. */
export class Visibility {
  private shown = false;
  constructor(private readonly node: HTMLElement | SVGElement) {
    node.setAttribute('hidden', '');
  }
  set(visible: boolean): void {
    if (visible === this.shown) return;
    this.shown = visible;
    if (visible) this.node.removeAttribute('hidden');
    else this.node.setAttribute('hidden', '');
  }
  get visible(): boolean {
    return this.shown;
  }
}

/** A `data-*` attribute, written only on a change. */
export class DataAttr {
  private last = '';
  constructor(
    private readonly node: HTMLElement,
    private readonly name: string,
  ) {}
  set(value: string): void {
    if (value === this.last) return;
    this.last = value;
    this.node.dataset[this.name] = value;
  }
}

/** A small stroked (or filled) icon whose path can be swapped. */
export class Glyph {
  readonly svg: SVGSVGElement;
  private readonly path: SVGPathElement;
  private last = '';
  constructor(className: string, d: string, filled = false) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('viewBox', '0 0 16 16');
    this.svg.setAttribute('aria-hidden', 'true');
    this.svg.setAttribute('focusable', 'false');
    this.svg.setAttribute('class', filled ? `${className} dfh-fill` : className);
    this.path = document.createElementNS(SVG_NS, 'path');
    this.svg.appendChild(this.path);
    this.set(d);
  }
  set(d: string): void {
    if (d === this.last) return;
    this.last = d;
    this.path.setAttribute('d', d);
  }
}

/** Restarts a CSS animation without a layout read: alternates between two twin keyframe names. */
export class Pulse {
  private flip = false;
  constructor(
    private readonly node: HTMLElement,
    private readonly name: string,
  ) {}
  fire(kind: string): void {
    this.flip = !this.flip;
    this.node.dataset[this.name] = this.flip ? `${kind}-a` : `${kind}-b`;
  }
}
