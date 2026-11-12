/**
 * A very small stand-in for the browser's DOM, for UI tests that run in node (the project has
 * no jsdom). It models only what `src/ui` uses: elements with children, attributes, `dataset`,
 * `style`, `hidden`, text, simple selectors, and bubbling click / key events.
 *
 * It also counts every write (`writes`), so a test can check the UI's central rule: a frame
 * whose state did not change must not touch the page.
 */

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  readonly type: string;
  readonly target: FakeElement | null;
  readonly key?: string;
  readonly code?: string;
  readonly repeat?: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

/** Everything written to any fake element since the last `resetWrites()`. */
let writes = 0;

export function resetWrites(): void {
  writes = 0;
}

export function writeCount(): number {
  return writes;
}

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** A record whose every assignment and deletion counts as a write. */
function countingRecord(): Record<string, string> {
  return new Proxy<Record<string, string>>(
    {},
    {
      set(target, key, value: string): boolean {
        writes += 1;
        target[String(key)] = String(value);
        return true;
      },
      deleteProperty(target, key): boolean {
        writes += 1;
        delete target[String(key)];
        return true;
      },
    },
  );
}

interface FakeStyle {
  [name: string]: string | ((name: string, value: string) => void) | ((name: string) => string);
  setProperty(name: string, value: string): void;
  getPropertyValue(name: string): string;
}

function countingStyle(): FakeStyle {
  const values = countingRecord();
  const style = new Proxy(values, {
    get(target, key): unknown {
      if (key === 'setProperty') {
        return (name: string, value: string): void => {
          target[name] = value;
        };
      }
      if (key === 'getPropertyValue') return (name: string): string => target[name] ?? '';
      return target[String(key)] ?? '';
    },
  });
  return style as unknown as FakeStyle;
}

interface SelectorPart {
  readonly tag: string;
  readonly classes: readonly string[];
  readonly attributes: readonly { readonly name: string; readonly value: string | null }[];
}

/** One compound selector: `tag.class[attr="value"]`. No combinators, no lists. */
function parseSelector(selector: string): SelectorPart {
  const classes: string[] = [];
  const attributes: { name: string; value: string | null }[] = [];
  let rest = selector.trim();
  const tagMatch = /^[a-zA-Z][\w-]*/.exec(rest);
  const tag = tagMatch === null ? '' : tagMatch[0].toLowerCase();
  rest = rest.slice(tag.length);
  const pattern = /\.([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g;
  for (let match = pattern.exec(rest); match !== null; match = pattern.exec(rest)) {
    if (match[1] !== undefined) classes.push(match[1]);
    else if (match[2] !== undefined) attributes.push({ name: match[2], value: match[3] ?? null });
  }
  return { tag, classes, attributes };
}

export class FakeElement {
  readonly tagName: string;
  readonly dataset: Record<string, string> = countingRecord();
  readonly style: FakeStyle = countingStyle();
  readonly childNodes: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  // Layout does not exist here: every measurement is 0 (the UI treats that as "not laid out").
  readonly offsetLeft = 0;
  readonly offsetTop = 0;
  readonly offsetWidth = 0;
  readonly offsetHeight = 0;
  readonly clientWidth = 0;
  readonly clientHeight = 0;

  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private ownText = '';
  private classes = '';
  private isHidden = false;
  private isDisabled = false;
  private isInert = false;
  private currentValue = '';
  private currentTitle = '';
  private currentId = '';
  private currentTabIndex = 0;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  // --- Properties that count as writes ---------------------------------------------------------

  get className(): string {
    return this.classes;
  }
  set className(value: string) {
    writes += 1;
    this.classes = value;
  }

  get hidden(): boolean {
    return this.isHidden;
  }
  set hidden(value: boolean) {
    writes += 1;
    this.isHidden = value;
  }

  get disabled(): boolean {
    return this.isDisabled;
  }
  set disabled(value: boolean) {
    writes += 1;
    this.isDisabled = value;
  }

  get inert(): boolean {
    return this.isInert;
  }
  set inert(value: boolean) {
    writes += 1;
    this.isInert = value;
  }

  get value(): string {
    return this.currentValue;
  }
  set value(value: string) {
    writes += 1;
    this.currentValue = String(value);
  }

  get title(): string {
    return this.currentTitle;
  }
  set title(value: string) {
    writes += 1;
    this.currentTitle = value;
  }

  get id(): string {
    return this.currentId;
  }
  set id(value: string) {
    writes += 1;
    this.currentId = value;
  }

  get tabIndex(): number {
    return this.currentTabIndex;
  }
  set tabIndex(value: number) {
    writes += 1;
    this.currentTabIndex = value;
  }

  get textContent(): string {
    let text = this.ownText;
    for (const child of this.childNodes) text += child.textContent;
    return text;
  }
  set textContent(value: string) {
    writes += 1;
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes.length = 0;
    this.ownText = value;
  }

  /** For a `<select>`: the option that carries the current value. */
  get selectedIndex(): number {
    return this.childNodes.findIndex((option) => option.value === this.currentValue);
  }

  readonly classList = {
    add: (...names: string[]): void => {
      for (const name of names) if (!this.hasClass(name)) this.className = `${this.classes} ${name}`.trim();
    },
    remove: (...names: string[]): void => {
      for (const name of names) {
        if (!this.hasClass(name)) continue;
        this.className = this.classes
          .split(/\s+/)
          .filter((other) => other !== name)
          .join(' ');
      }
    },
    toggle: (name: string, force?: boolean): boolean => {
      const on = force ?? !this.hasClass(name);
      if (on) this.classList.add(name);
      else this.classList.remove(name);
      return on;
    },
    contains: (name: string): boolean => this.hasClass(name),
  };

  // --- Attributes ------------------------------------------------------------------------------

  setAttribute(name: string, value: string): void {
    if (name === 'class') {
      this.className = value;
      return;
    }
    writes += 1;
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    if (name === 'class') return this.classes;
    if (name === 'id') return this.currentId === '' ? null : this.currentId;
    if (name.startsWith('data-')) return this.dataset[camel(name.slice(5))] ?? null;
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    writes += 1;
    this.attributes.delete(name);
  }

  // --- Tree ------------------------------------------------------------------------------------

  get children(): FakeElement[] {
    return this.childNodes;
  }
  get firstChild(): FakeElement | null {
    return this.childNodes[0] ?? null;
  }
  get firstElementChild(): FakeElement | null {
    return this.childNodes[0] ?? null;
  }
  get lastElementChild(): FakeElement | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get parentNode(): FakeElement | null {
    return this.parentElement;
  }
  get isConnected(): boolean {
    let node: FakeElement | null = this.parentElement;
    while (node !== null) {
      if (node === fakeDocument.body || node === fakeDocument.documentElement) return true;
      node = node.parentElement;
    }
    return false;
  }

  appendChild(child: FakeElement): FakeElement {
    return this.insertBefore(child, null);
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  insertBefore(child: FakeElement, before: FakeElement | null): FakeElement {
    writes += 1;
    child.detach();
    const index = before === null ? -1 : this.childNodes.indexOf(before);
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    child.parentElement = this;
    return child;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    writes += 1;
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes.length = 0;
    this.ownText = '';
    for (const node of nodes) this.appendChild(node);
  }

  remove(): void {
    if (this.parentElement === null) return;
    writes += 1;
    this.detach();
  }

  contains(other: FakeElement | null): boolean {
    for (let node = other; node !== null; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }

  private detach(): void {
    const parent = this.parentElement;
    if (parent === null) return;
    const index = parent.childNodes.indexOf(this);
    if (index >= 0) parent.childNodes.splice(index, 1);
    this.parentElement = null;
  }

  // --- Selectors -------------------------------------------------------------------------------

  private hasClass(name: string): boolean {
    return this.classes.split(/\s+/).includes(name);
  }

  matches(selector: string): boolean {
    const part = parseSelector(selector);
    if (part.tag !== '' && part.tag !== this.tagName.toLowerCase()) return false;
    for (const name of part.classes) if (!this.hasClass(name)) return false;
    for (const attribute of part.attributes) {
      const value = this.getAttribute(attribute.name);
      if (value === null) return false;
      if (attribute.value !== null && attribute.value !== value) return false;
    }
    return true;
  }

  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node !== null; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.childNodes) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  // --- Events ----------------------------------------------------------------------------------

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Calls this element's listeners, then its ancestors' (every event here bubbles). */
  dispatchEvent(event: FakeEvent): void {
    for (let node: FakeElement | null = this; node !== null; node = node.parentElement) {
      const set = node.listeners.get(event.type);
      if (set !== undefined) for (const listener of [...set]) listener(event);
    }
    fakeDocument.fire(event);
  }

  /** A pointer click. Like the browser, a disabled control swallows it. */
  click(): void {
    if (this.isDisabled) return;
    this.dispatchEvent(makeEvent('click', this));
  }

  focus(): void {
    fakeDocument.activeElement = this;
  }

  blur(): void {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = null;
  }

  select(): void {
    // Text selection does not exist here.
  }
}

/** Subclasses only so that `instanceof HTMLButtonElement` and friends work. */
export class FakeButtonElement extends FakeElement {
  type = 'button';
}
export class FakeInputElement extends FakeElement {
  type = 'text';
  min = '';
  max = '';
  step = '';
  inputMode = '';
}
export class FakeSelectElement extends FakeElement {}

export function makeEvent(
  type: string,
  target: FakeElement | null,
  extra?: { readonly key?: string; readonly code?: string; readonly repeat?: boolean },
): FakeEvent {
  const event: FakeEvent = {
    type,
    target,
    ...(extra?.key === undefined ? {} : { key: extra.key }),
    ...(extra?.code === undefined ? {} : { code: extra.code }),
    repeat: extra?.repeat ?? false,
    defaultPrevented: false,
    preventDefault(): void {
      event.defaultPrevented = true;
    },
  };
  return event;
}

class FakeDocument {
  readonly root = new FakeElement('html');
  readonly documentElement = this.root;
  readonly body = new FakeElement('body');
  activeElement: FakeElement | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor() {
    this.root.appendChild(this.body);
  }

  createElement(tag: string): FakeElement {
    const name = tag.toLowerCase();
    if (name === 'button') return new FakeButtonElement(name);
    if (name === 'input' || name === 'textarea') return new FakeInputElement(name);
    if (name === 'select') return new FakeSelectElement(name);
    return new FakeElement(name);
  }

  createElementNS(_namespace: string, tag: string): FakeElement {
    return new FakeElement(tag);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(event: FakeEvent): void {
    const set = this.listeners.get(event.type);
    if (set !== undefined) for (const listener of [...set]) listener(event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  execCommand(): boolean {
    return false;
  }
}

export let fakeDocument = new FakeDocument();

/** A key press on the page (the UI listens on `document`). Returns the event for inspection. */
export function pressKey(key: string, code: string, repeat = false): FakeEvent {
  const event = makeEvent('keydown', null, { key, code, repeat });
  fakeDocument.fire(event);
  return event;
}

const GLOBAL_NAMES = [
  'document',
  'window',
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'Node',
] as const;

/**
 * Puts a fresh fake page on `globalThis` and returns the function that takes it off again
 * (restoring whatever was there). Call from `beforeEach` / `afterEach`.
 */
export function installFakeDom(): () => void {
  fakeDocument = new FakeDocument();
  resetWrites();
  const fakeWindow = {
    addEventListener(): void {},
    removeEventListener(): void {},
    isSecureContext: false,
    localStorage: {
      getItem: (): string | null => null,
      setItem: (): void => {},
    },
  };
  const values: Record<(typeof GLOBAL_NAMES)[number], unknown> = {
    document: fakeDocument,
    window: fakeWindow,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLButtonElement: FakeButtonElement,
    HTMLInputElement: FakeInputElement,
    HTMLSelectElement: FakeSelectElement,
    Node: FakeElement,
  };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const name of GLOBAL_NAMES) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: values[name],
      configurable: true,
      writable: true,
    });
  }
  return (): void => {
    for (const name of GLOBAL_NAMES) {
      const descriptor = saved.get(name);
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
    }
  };
}

/** The page's root for the UI, typed as the element the UI expects. */
export function createUiRoot(): { readonly fake: FakeElement; readonly element: HTMLElement } {
  const fake = fakeDocument.createElement('div');
  fakeDocument.body.appendChild(fake);
  return { fake, element: fake as unknown as HTMLElement };
}
