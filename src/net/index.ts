/**
 * Barrel for `src/net`: what `src/game` needs to host or join a room. Pure of the DOM, so all
 * of it runs in node tests and in a Web Worker.
 *
 * Not re-exported on purpose:
 * - `./transport/peerjs` (the PeerJS runtime, browser only): import it by path, ideally with a
 *   dynamic `import()` so the title screen does not pay for it;
 * - the codec and the wire structs (`./codec`, `./protocol`): the sessions are their only
 *   users. Import them by path for tools and tests.
 */

export * from './bots';
export * from './clock';
export * from './prediction';
export * from './room-code';
export * from './session';
export * from './snapshot';
export * from './transport';
export * from './worker';
