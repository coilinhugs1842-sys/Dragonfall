/**
 * App state machine: which top-level scene is active (docs/ARCHITECTURE.md, "Scenes and memory").
 *
 * Scene code registers a handler per state. `exit` is told where the app is going, so a scene
 * can dispose only what the next one does not need (results reuses the match map, for example).
 * No DOM or three.js here: this stays testable in node.
 */

export type AppStateId = 'title' | 'lobby' | 'match' | 'results';

export const APP_STATE_IDS: readonly AppStateId[] = ['title', 'lobby', 'match', 'results'];

/**
 * Every legal move. Anything not listed is rejected.
 * - lobby → title: leave the room.
 * - match → title: the host left, so the match ends for everyone (docs/NETWORKING.md, "Topology").
 * - results → lobby: back to the aerie with teams kept; results → title: leave.
 */
export const APP_TRANSITIONS: Readonly<Record<AppStateId, readonly AppStateId[]>> = {
  title: ['lobby'],
  lobby: ['match', 'title'],
  match: ['results', 'title'],
  results: ['lobby', 'title'],
};

export interface AppStateHandler {
  /** Runs after the state becomes active. `from` is null for the initial state (see `App.start`). */
  enter?(from: AppStateId | null, to: AppStateId): void;
  /** Runs before the state is left, while `app.state` is still this state. */
  exit?(to: AppStateId, from: AppStateId): void;
  /** Runs once per fixed sim tick while the state is active. Must not allocate. */
  update?(tick: number): void;
}

export type AppChangeListener = (to: AppStateId, from: AppStateId) => void;

type HandlerTable = Record<AppStateId, readonly AppStateHandler[]>;

export class App {
  private current: AppStateId;
  private started = false;
  private transitioning = false;
  // Handler and listener arrays are replaced, never mutated, so removing one during dispatch is
  // safe and `update` can iterate without copying.
  private readonly handlers: HandlerTable = { title: [], lobby: [], match: [], results: [] };
  private listeners: readonly AppChangeListener[] = [];

  constructor(initial: AppStateId = 'title') {
    this.current = initial;
  }

  get state(): AppStateId {
    return this.current;
  }

  /** Adds a handler for one state. Returns a function that removes it. */
  register(state: AppStateId, handler: AppStateHandler): () => void {
    this.handlers[state] = [...this.handlers[state], handler];
    return () => {
      this.handlers[state] = this.handlers[state].filter((h) => h !== handler);
    };
  }

  /**
   * Runs the `enter` hooks of the initial state, once. It is separate from the constructor so
   * scenes can register first. Later calls do nothing.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    const state = this.current;
    for (const handler of this.handlers[state]) handler.enter?.(null, state);
  }

  canTransition(to: AppStateId): boolean {
    return !this.transitioning && APP_TRANSITIONS[this.current].includes(to);
  }

  /**
   * Moves to `to` if the table allows it. Order: exit hooks of the old state, state change,
   * enter hooks of the new state, then `onChange` listeners.
   *
   * Returns false and changes nothing for an illegal move, including a move to the current state
   * and a call made from inside a hook or listener of a transition that is still running (queue
   * that for the next `update` instead).
   */
  transition(to: AppStateId): boolean {
    if (!this.canTransition(to)) return false;
    const from = this.current;
    this.transitioning = true;
    try {
      for (const handler of this.handlers[from]) handler.exit?.(to, from);
      this.current = to;
      for (const handler of this.handlers[to]) handler.enter?.(from, to);
      for (const listener of this.listeners) listener(to, from);
    } finally {
      this.transitioning = false;
    }
    return true;
  }

  /** Forwards one fixed sim tick to the active state's handlers. */
  update(tick: number): void {
    const handlers = this.handlers[this.current];
    for (let i = 0; i < handlers.length; i++) handlers[i]?.update?.(tick);
  }

  /** Subscribes to completed transitions. Returns the unsubscribe function. */
  onChange(fn: AppChangeListener): () => void {
    this.listeners = [...this.listeners, fn];
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }
}
