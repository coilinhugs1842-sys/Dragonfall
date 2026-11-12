/**
 * The trailer as data: what is recorded (SHOTS), where each piece goes in the cut (CUT) and
 * what plays under it (MUSIC). `node tools/trailer/build.mjs` reads this and nothing else.
 *
 * Words on screen: only the game's own name, its own map and mode names (the intro's title
 * card, the HUD of the gameplay shots) and the neutral closing line below. No claims, no
 * dates, no logos.
 *
 * A shot:
 *   id          file name of the recording (art-source/_scratch/trailer/shots/<id>.mp4)
 *   what        one line for the build log and the report
 *   url         path and query on the dev server (`--base`, default http://localhost:5199)
 *   seconds     length of the recording
 *   ui          record.mjs --ui: 'cine' = no HUD or menus (the scene fade and the intro's
 *               title card stay), 'game' = the HUD as a player sees it, 'none' = nothing
 *   start       optional: seconds of game time to let pass first (not recorded, cheap)
 *   from        optional: start condition, an expression that becomes true in the page
 *   pre         optional: with `from`, seconds kept from BEFORE it came true
 *   max         optional: give up waiting for `from` after this many seconds of game time
 *   camera      optional: a camera from ./cameras.mjs, placed on the live match
 *   seed        optional: record.mjs --seed; makes a live bot match repeat exactly
 *   check       optional: an expression that must be true after the last frame; the build
 *               warns when it is not (a seeded match that no longer plays out as timed)
 *   placeholder optional: why this shot cannot be recorded yet; the build skips it and every
 *               piece of the cut that uses it
 */

/** One bar of the lobby theme (66 BPM, 4/4) and of the match music (120 BPM, 4/4), seconds. */
const LOBBY_BAR = (4 * 60) / 66;
const MATCH_BAR = (4 * 60) / 120;

/** A hosted 5v5 of bots, the local dragon flown by a bot, no lobby or intro. */
const LIVE = '/?autostart&fill&teamsize=5&autopilot=bot&nocine';
/** The same room with its cinematics: lobby launch, intro flyby, 3-2-1. */
const LIVE_WITH_INTRO = '/?autostart&fill&teamsize=5&autopilot=bot';
const REPORT = 'window.__dragonfall.report()';
/** True from `seconds` into the fight (the match clock, which starts after the 3-2-1). */
const matchTime = (seconds) =>
  `(() => { const r = ${REPORT}; return r.phase === 'playing' && r.show.phaseTimeS >= ${seconds}; })()`;

export const SHOTS = [
  {
    id: 'title-open',
    what: 'Opening card: the wordmark over the live sky and cloud sea',
    url: '/?viewer=cine:title',
    seconds: 4.2,
    ui: 'game',
  },
  {
    id: 'aerie-arrive',
    what: 'Aerie lobby: riders land on their perches and ready up (the braziers light)',
    url: '/?viewer=cine:aerie&join=1&ready=1&plates=0',
    start: 4.6,
    seconds: 4.6,
    ui: 'cine',
  },
  {
    id: 'aerie-closeup',
    what: 'Aerie lobby: close-up of one rider and dragon',
    url: '/?viewer=cine:aerie&ready=all&focus=3&plates=0',
    start: 1.2,
    seconds: 4.4,
    ui: 'cine',
  },
  {
    id: 'aerie-launch',
    what: 'Aerie lobby: the host starts, everyone takes off',
    url: '/?viewer=cine:aerie&ready=all&launch=1&launchAt=1.4&plates=0',
    seconds: 4.6,
    ui: 'cine',
  },
  {
    id: 'intro',
    what: 'Live room: intro flyby with the map title card, then the two team gates',
    url: LIVE_WITH_INTRO,
    seed: 915,
    from: `${REPORT}.phase === 'intro'`,
    pre: 0.5,
    seconds: 7,
    ui: 'cine',
  },
  {
    id: 'skim',
    what: 'A flight of three low over the cloud sea, through the canyon (new scene cine:skim)',
    url: '/?viewer=cine:skim',
    start: 1.5,
    seconds: 4.4,
    ui: 'cine',
  },
  {
    id: 'fight-wide',
    what: 'Live 5v5 bot fight from the bench camera path (the wide orbit round the centre)',
    url: '/?bench',
    seed: 77,
    start: 35,
    seconds: 2.4,
    ui: 'none',
  },
  // The two live shots below are SEEDED: with the same seed the bots fly the same match every
  // time (same room code, same events on the same tick), so a moment can be picked once by
  // match time and recorded again exactly. The times were picked from contact sheets made
  // with tools/trailer/scout.mjs. They hold only while the simulation's code is unchanged:
  // after a change to src/sim the same seed gives another match. `check` catches that (the
  // build warns); then scout again and move the times. Each live shot needs its own seed:
  // the room code comes from it, and two recordings run at once.
  {
    id: 'fight-orbit',
    what: 'Live 5v5: a slow orbit round whichever two enemies are closest (camera fightOrbit)',
    url: LIVE,
    seed: 4107,
    camera: 'fightOrbit',
    from: matchTime(13.3),
    seconds: 23.2,
    ui: 'none',
    check: `${REPORT}.match.events.hit >= 60`,
  },
  {
    id: 'chase',
    what: 'Live 5v5, HUD on: the chase camera in a dogfight, then the takedown and the death cam',
    url: LIVE,
    seed: 2611,
    from: matchTime(24.5),
    seconds: 10.4,
    ui: 'game',
    // The local dragon goes down about 6.5 s in and is still down at the end.
    check: `(() => { const local = ${REPORT}.local; return local !== null && !local.alive; })()`,
  },
  {
    id: 'podium',
    what: 'Results: the winners fly their formation pass and land on the podium',
    url: '/?viewer=cine:podium',
    start: 2.8,
    seconds: 6.6,
    ui: 'cine',
  },
  {
    id: 'title-close',
    what: 'Closing card: the wordmark and "Play in your browser"',
    url: '/?viewer=cine:title&line=Play%20in%20your%20browser',
    seconds: 6.6,
    ui: 'game',
  },

  // ---- PLACEHOLDERS: not recorded, not in the cut, until the features land ------------------
  {
    id: 'caldera-flyby',
    placeholder: 'Emberfall Caldera (the second map) is still being built by another agent',
    what: 'PLACEHOLDER: intro flyby over Emberfall Caldera with its map title card',
    url: `${LIVE_WITH_INTRO}&map=emberfall-caldera`,
    from: `${REPORT}.phase === 'intro'`,
    pre: 0.5,
    seconds: 4.4,
    ui: 'cine',
  },
  {
    id: 'ember-relay',
    placeholder: 'Ember Relay (the capture-the-flag mode) is still being built by another agent',
    what: 'PLACEHOLDER: Ember Relay: a carrier runs the ember home with the HUD on',
    url: `${LIVE}&mode=emberRelay`,
    start: 10,
    from: `${REPORT}.match.events.objective >= 1`,
    pre: 2.5,
    max: 240,
    seconds: 4.4,
    ui: 'game',
  },
];

/**
 * The cut, in order. `in`: seconds into the recording where the piece starts; `length`: its
 * time on screen. Lengths are whole bars of the music under them, so every cut lands on a
 * downbeat. `xfade`: seconds of cross-fade from the piece before (0 = a hard cut);
 * `fadeIn` / `fadeOut`: from and to black.
 */
export const CUT = [
  { shot: 'title-open', in: 0, length: LOBBY_BAR, fadeIn: 0.5 },
  { shot: 'aerie-arrive', in: 0, length: LOBBY_BAR, xfade: 0.5 },
  { shot: 'aerie-closeup', in: 0, length: LOBBY_BAR },
  { shot: 'aerie-launch', in: 0.5, length: LOBBY_BAR },
  // The match music starts on this cut. (The intro opens on the game's own fade from cream.)
  { shot: 'intro', in: 0.5, length: 3 * MATCH_BAR, xfade: 0.3 },
  { shot: 'caldera-flyby', in: 0.5, length: 2 * MATCH_BAR },
  { shot: 'skim', in: 0, length: 2 * MATCH_BAR },
  // The battle layer of the music is in from here.
  { shot: 'fight-wide', in: 0, length: MATCH_BAR },
  { shot: 'fight-orbit', in: 0.2, length: 2 * MATCH_BAR },
  { shot: 'chase', in: 0, length: 3 * MATCH_BAR },
  { shot: 'fight-orbit', in: 21, length: MATCH_BAR },
  { shot: 'ember-relay', in: 0, length: 2 * MATCH_BAR },
  // The same recording as the chase, from where that piece left off: the takedown.
  { shot: 'chase', in: 6, length: 2 * MATCH_BAR },
  { shot: 'podium', in: 0, length: 3 * MATCH_BAR },
  { shot: 'title-close', in: 0, length: 6, xfade: 0.4, fadeOut: 0.9 },
];

/**
 * The soundtrack, from the game's own synthesised audio (public/assets/audio, loop points from
 * its manifest.json). Times are places in the cut: the first frame of the named shot.
 */
export const MUSIC = {
  /** Gain of the whole mix before the limiter (the game's files are mastered quiet). */
  master: 1.5,
  /** Quiet opening: the lobby theme from its loop start, under the cards and the aerie. */
  opening: { track: 'lobby', gain: 0.45, fadeInS: 1.2 },
  /** With a little of the aerie's air under it. */
  air: { ambience: 'aerie', gain: 0.35 },
  /** The match music's calm layer starts on this shot... */
  matchFrom: 'intro',
  /** ...and its battle layer (same bars, tempo and harmony) is fully in on this one. */
  battleFrom: 'fight-wide',
  match: { calm: 'matchLow', battle: 'matchHigh', gain: 0.8, calmUnderBattle: 0.3, blendS: MATCH_BAR },
  /** The victory sting lands on this shot; the match music falls away under it. */
  stingAt: 'title-close',
  sting: { sound: 'victory', gain: 0.95, musicOutS: 1.4 },
};
