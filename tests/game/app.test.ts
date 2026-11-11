import { describe, expect, it } from 'vitest';
import { APP_STATE_IDS, APP_TRANSITIONS, App } from '../../src/game/app';
import type { AppStateId } from '../../src/game/app';

/** Drives an app along a path of legal moves and returns it. */
function appAt(...path: AppStateId[]): App {
  const app = new App();
  for (const state of path) expect(app.transition(state)).toBe(true);
  return app;
}

const PATH_TO: Record<AppStateId, AppStateId[]> = {
  title: [],
  lobby: ['lobby'],
  match: ['lobby', 'match'],
  results: ['lobby', 'match', 'results'],
};

describe('App transition table', () => {
  it('starts at the title', () => {
    expect(new App().state).toBe('title');
  });

  it('walks the main loop: title → lobby → match → results → lobby', () => {
    const app = appAt('lobby', 'match', 'results', 'lobby');
    expect(app.state).toBe('lobby');
  });

  it('allows leaving to the title from lobby, match (host left) and results', () => {
    expect(appAt('lobby', 'title').state).toBe('title');
    expect(appAt('lobby', 'match', 'title').state).toBe('title');
    expect(appAt('lobby', 'match', 'results', 'title').state).toBe('title');
  });

  it('accepts exactly the moves in the table and rejects every other pair', () => {
    for (const from of APP_STATE_IDS) {
      for (const to of APP_STATE_IDS) {
        const app = appAt(...PATH_TO[from]);
        const legal = APP_TRANSITIONS[from].includes(to);
        expect(app.canTransition(to), `${from} → ${to}`).toBe(legal);
        expect(app.transition(to), `${from} → ${to}`).toBe(legal);
        expect(app.state).toBe(legal ? to : from);
      }
    }
  });

  it('rejects the specific shortcuts that would skip a scene', () => {
    expect(new App().transition('match')).toBe(false);
    expect(new App().transition('results')).toBe(false);
    expect(appAt('lobby').transition('results')).toBe(false);
    expect(appAt('lobby', 'match', 'results').transition('match')).toBe(false);
  });

  it('lets the host end a match straight back to the lobby', () => {
    expect(appAt('lobby', 'match', 'lobby').state).toBe('lobby');
  });

  it('rejects a move to the current state', () => {
    for (const state of APP_STATE_IDS) {
      expect(appAt(...PATH_TO[state]).transition(state)).toBe(false);
    }
  });

  it('runs no hook and notifies nobody on a rejected move', () => {
    const app = new App();
    const calls: string[] = [];
    app.register('title', { exit: () => calls.push('exit') });
    app.register('match', { enter: () => calls.push('enter') });
    app.onChange(() => calls.push('change'));

    expect(app.transition('match')).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('App hooks', () => {
  it('orders a transition: exit old, enter new, then onChange', () => {
    const app = new App();
    const calls: string[] = [];
    app.register('title', {
      exit: (to, from) => calls.push(`exit ${from}→${to} (state=${app.state})`),
    });
    app.register('lobby', {
      enter: (from, to) => calls.push(`enter ${from}→${to} (state=${app.state})`),
    });
    app.onChange((to, from) => calls.push(`change ${from}→${to} (state=${app.state})`));

    app.transition('lobby');

    expect(calls).toEqual([
      'exit title→lobby (state=title)',
      'enter title→lobby (state=lobby)',
      'change title→lobby (state=lobby)',
    ]);
  });

  it('tells exit where the app is going, so a scene can keep what the next one reuses', () => {
    const destinations: AppStateId[] = [];
    const app = appAt('lobby', 'match');
    app.register('match', { exit: (to) => destinations.push(to) });

    app.transition('results');
    app.transition('lobby');
    app.transition('match');
    app.transition('title');

    expect(destinations).toEqual(['results', 'title']);
  });

  it('runs several handlers of one state in registration order', () => {
    const app = new App();
    const calls: string[] = [];
    app.register('lobby', { enter: () => calls.push('a') });
    app.register('lobby', { enter: () => calls.push('b') });
    app.transition('lobby');
    expect(calls).toEqual(['a', 'b']);
  });

  it('start() enters the initial state once, with from = null', () => {
    const app = new App();
    const calls: (AppStateId | null)[] = [];
    app.register('title', { enter: (from) => calls.push(from) });

    app.start();
    app.start();
    expect(calls).toEqual([null]);

    app.transition('lobby');
    app.transition('title');
    expect(calls).toEqual([null, 'lobby']);
  });

  it('update() reaches only the active state', () => {
    const app = new App();
    const seen: string[] = [];
    app.register('title', { update: (tick) => seen.push(`title ${tick}`) });
    app.register('lobby', { update: (tick) => seen.push(`lobby ${tick}`) });

    app.update(0);
    app.transition('lobby');
    app.update(1);
    app.update(2);

    expect(seen).toEqual(['title 0', 'lobby 1', 'lobby 2']);
  });

  it('removes a handler through the function register() returns', () => {
    const app = new App();
    let updates = 0;
    const remove = app.register('title', { update: () => updates++ });
    app.update(0);
    remove();
    remove();
    app.update(1);
    expect(updates).toBe(1);
  });

  it('rejects a transition requested from inside a hook or listener', () => {
    const app = new App();
    const nested: boolean[] = [];
    app.register('title', { exit: () => nested.push(app.transition('lobby')) });
    app.register('lobby', { enter: () => nested.push(app.transition('match')) });
    app.onChange(() => nested.push(app.transition('title')));

    expect(app.transition('lobby')).toBe(true);
    expect(nested).toEqual([false, false, false]);
    expect(app.state).toBe('lobby');
    // The guard is released afterwards.
    expect(app.transition('match')).toBe(true);
  });

  it('releases the re-entrancy guard when a hook throws', () => {
    const app = new App();
    const remove = app.register('lobby', {
      enter: () => {
        throw new Error('scene failed to load');
      },
    });
    expect(() => app.transition('lobby')).toThrow('scene failed to load');
    remove();
    expect(app.transition('title')).toBe(true);
  });
});

describe('App.onChange', () => {
  it('notifies every listener with (to, from)', () => {
    const app = new App();
    const a: string[] = [];
    const b: string[] = [];
    app.onChange((to, from) => a.push(`${from}→${to}`));
    app.onChange((to, from) => b.push(`${from}→${to}`));

    app.transition('lobby');
    app.transition('match');

    expect(a).toEqual(['title→lobby', 'lobby→match']);
    expect(b).toEqual(a);
  });

  it('stops notifying after unsubscribe, without disturbing other listeners', () => {
    const app = new App();
    let first = 0;
    let second = 0;
    const unsubscribe = app.onChange(() => first++);
    app.onChange(() => second++);

    app.transition('lobby');
    unsubscribe();
    unsubscribe();
    app.transition('match');

    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it('lets a listener unsubscribe itself during dispatch', () => {
    const app = new App();
    let once = 0;
    let always = 0;
    const unsubscribe = app.onChange(() => {
      once++;
      unsubscribe();
    });
    app.onChange(() => always++);

    app.transition('lobby');
    app.transition('match');

    expect(once).toBe(1);
    expect(always).toBe(2);
  });
});
