/**
 * Small DOM helpers for the plain-HTML UI (docs/DECISIONS.md 7: no framework). Screens build
 * their elements once and afterwards only write what changed, so these are construction helpers
 * plus a few "write if different" setters.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A real `<button type="button">`; `action` becomes `data-act` for delegated click handling. */
export function button(className: string, label: string, action?: string): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  if (action !== undefined) node.dataset['act'] = action;
  return node;
}

export function append<T extends Node>(parent: T, ...children: readonly Node[]): T {
  for (const child of children) parent.appendChild(child);
  return parent;
}

export type IconName = 'triangle' | 'diamond' | 'eye' | 'check' | 'cross' | 'copy' | 'lock';

/** 16-unit view box. Shapes are filled with `currentColor`; strokes use it too. */
const ICON_PATHS: Readonly<Record<IconName, { readonly d: string; readonly stroke: boolean }>> = {
  // Team Ember: flame / triangle.
  triangle: { d: 'M8 1.8 14.6 13.6H1.4Z', stroke: false },
  // Team Frost: crystal / diamond.
  diamond: { d: 'M8 1 14.4 8 8 15 1.6 8Z', stroke: false },
  eye: {
    d: 'M1.2 8C3 4.9 5.3 3.4 8 3.4S13 4.9 14.8 8C13 11.1 10.7 12.6 8 12.6S3 11.1 1.2 8ZM8 5.9A2.1 2.1 0 1 0 8 10.1 2.1 2.1 0 1 0 8 5.9Z',
    stroke: true,
  },
  check: { d: 'M2.6 8.6 6.3 12.2 13.4 4.2', stroke: true },
  cross: { d: 'M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5', stroke: true },
  copy: { d: 'M5.5 5.5H13.5V13.5H5.5ZM10.5 5.5V2.5H2.5V10.5H5.5', stroke: true },
  lock: { d: 'M3.5 7.5H12.5V13.5H3.5ZM5.5 7.5V5A2.5 2.5 0 0 1 10.5 5V7.5', stroke: true },
};

/** Decorative inline icon (`aria-hidden`); the element next to it carries the words. */
export function icon(name: IconName, className?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className === undefined ? 'dfu-icon' : `dfu-icon ${className}`);
  const spec = ICON_PATHS[name];
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', spec.d);
  if (spec.stroke) {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  } else {
    path.setAttribute('fill', 'currentColor');
  }
  svg.appendChild(path);
  return svg;
}

/** The closest ancestor-or-self button carrying `data-act`, for one delegated listener per screen. */
export function actionTarget(event: Event): HTMLButtonElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const hit = target.closest('button[data-act]');
  return hit instanceof HTMLButtonElement ? hit : null;
}

/**
 * Copies text to the clipboard. `navigator.clipboard` only exists in secure contexts, and the
 * LAN fallback is plain HTTP (docs/DECISIONS.md), so there is a selection-based fallback.
 */
export function copyText(value: string, onDone: (ok: boolean) => void): void {
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard !== undefined && window.isSecureContext) {
    clipboard.writeText(value).then(
      () => onDone(true),
      () => onDone(copyWithSelection(value)),
    );
    return;
  }
  onDone(copyWithSelection(value));
}

function copyWithSelection(value: string): boolean {
  const area = el('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.appendChild(area);
  const previous = document.activeElement;
  area.select();
  let ok = false;
  try {
    // Deprecated, but the only clipboard write available on an insecure origin.
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  if (previous instanceof HTMLElement) previous.focus();
  return ok;
}
