/**
 * Timing, capacity and identity constants shared by sim, net and views.
 * Sources: docs/ARCHITECTURE.md (Timing), docs/NETWORKING.md (rates, lobby), docs/GAME_DESIGN.md (teams).
 * Balance numbers do NOT live here: see tuning.ts.
 */

// --- Simulation timing -------------------------------------------------------------------------

/** Fixed sim rate. The host sim and client prediction must use the same step or they diverge. */
export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;
/** Seconds per tick, for integrating physics without a per-tick division. */
export const TICK_DT_S = 1 / TICK_HZ;

// --- Network timing (docs/NETWORKING.md, "Tick rates and timing") -------------------------------

export const SNAPSHOT_HZ = 20;
export const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_HZ;
/** Clients send one input packet per sim tick. */
export const INPUT_SEND_HZ = TICK_HZ;
/** Each input packet repeats this many previous inputs to cover packet loss. */
export const INPUT_REDUNDANCY = 2;

/** Other dragons are drawn this far in the past; the delay adapts to jitter within the bounds. */
export const INTERP_DELAY_MS = 100;
export const INTERP_DELAY_MIN_MS = 70;
export const INTERP_DELAY_MAX_MS = 150;
/** A late snapshot is extrapolated for at most this long before the dragon freezes. */
export const MAX_EXTRAPOLATION_MS = 150;
/** Prediction errors are blended out over this time so reconciliation does not pop. */
export const RECONCILE_SMOOTH_MS = 100;

export const PING_HZ = 2;
/** How much dragon position history the host keeps for lag-compensated hit checks. */
export const LAG_COMP_HISTORY_MS = 300;
/** Upper bound on how far back a hit check may rewind (RTT/2 + interpolation delay, capped). */
export const LAG_COMP_MAX_REWIND_MS = 200;
/** A disconnected player's slot is held this long for a reconnect. */
export const RECONNECT_GRACE_MS = 30_000;

/** Bump on any wire-format change; the host rejects a `hello` with a different version. */
export const PROTOCOL_VERSION = 2;

// --- Rooms and signaling ------------------------------------------------------------------------

export const ROOM_CODE_LENGTH = 5;
/** No 0/O/1/I, so a code read aloud or typed from a screen is unambiguous. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** The host registers the PeerJS id `dragonfall-<CODE>`. */
export const PEER_ID_PREFIX = 'dragonfall-';
/** Matches the `peer:lan` npm script (self-hosted PeerServer). */
export const LAN_PEER_PORT = 9000;
export const LAN_PEER_PATH = '/dragonfall';

// --- Players and teams --------------------------------------------------------------------------

export const MIN_TEAM_SIZE = 1;
export const MAX_TEAM_SIZE = 5;
export const TEAM_COUNT = 2;
/** Active riders in a match; anyone beyond this joins as a spectator. */
export const MAX_PLAYERS = MAX_TEAM_SIZE * TEAM_COUNT;
/** The host plays too, so it holds at most this many client connections for riders. */
export const MAX_CLIENT_RIDERS = MAX_PLAYERS - 1;

/** Player and dragon ids are a `u8` on the wire. A rider's dragon shares the rider's id. */
export type PlayerId = number;
/** "Nobody" sentinel that still fits the wire `u8` (e.g. a takedown by the storm wall). */
export const NO_PLAYER: PlayerId = 255;

export const TEAM_EMBER = 0;
export const TEAM_FROST = 1;
export type TeamId = typeof TEAM_EMBER | typeof TEAM_FROST;
export const TEAM_IDS: readonly TeamId[] = [TEAM_EMBER, TEAM_FROST];

/** Where a lobby member sits: on a team terrace or watching. */
export type LobbySide = TeamId | 'spectator';

export interface TeamInfo {
  readonly id: TeamId;
  readonly key: 'ember' | 'frost';
  readonly name: string;
  /** sRGB hex, as a number so views can feed it to a colour type without parsing. */
  readonly color: number;
  readonly colorCss: string;
  /** Team markers always pair the colour with this shape so they survive colour blindness. */
  readonly icon: 'triangle' | 'diamond';
}

export const TEAMS: Readonly<Record<TeamId, TeamInfo>> = {
  [TEAM_EMBER]: {
    id: TEAM_EMBER,
    key: 'ember',
    name: 'Ember Order',
    color: 0xff7a1a,
    colorCss: '#FF7A1A',
    icon: 'triangle',
  },
  [TEAM_FROST]: {
    id: TEAM_FROST,
    key: 'frost',
    name: 'Frost Order',
    color: 0x3fd7ff,
    colorCss: '#3FD7FF',
    icon: 'diamond',
  },
};

export function otherTeam(team: TeamId): TeamId {
  return team === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER;
}
