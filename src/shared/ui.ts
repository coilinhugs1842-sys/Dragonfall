/**
 * UiState / UiIntent: the only seam between `src/ui` and the rest of the game.
 * `src/game` builds a UiState and the UI renders it; the UI never reads sim or net objects.
 * Every action a menu or HUD can request is a UiIntent sent back to `src/game`, which applies
 * it locally or forwards it to the host.
 */

import type { AbilitySlot, DragonClassId } from './classes';
import type { LobbySide, PlayerId, TeamId } from './constants';
import type { DamageSource, ObjectiveKind } from './events';
import type {
  HostSettings,
  LobbyBotIntent,
  LobbyState,
  LobbySwitchSideIntent,
  RejectReason,
} from './lobby';
import type { MapId, MatchPhase, MatchWinner, ModeId } from './match';
import { DEFAULT_QUALITY, QUALITY_PRESETS } from './quality';
import type { QualityPresetId } from './quality';

// --- Settings -----------------------------------------------------------------------------------

/** How peers find each other (docs/NETWORKING.md, "Connection setup"). */
export type SignalingMode = 'online' | 'lan';

/** Optional TURN relay for networks that block peer-to-peer traffic. */
export interface TurnSettings {
  readonly url: string;
  readonly username: string;
  readonly credential: string;
}

export interface SettingsState {
  /** `auto` = use the result of the first-launch test flight. */
  readonly quality: QualityPresetId | 'auto';
  /** 0 = uncapped; 30/45 save battery and heat. */
  readonly fpsCap: 0 | 30 | 45;
  /** Volumes are 0..1. */
  readonly masterVolume: number;
  readonly musicVolume: number;
  readonly sfxVolume: number;
  readonly mouseSensitivity: number;
  readonly invertY: boolean;
  readonly signaling: SignalingMode;
  /** Host name or IP of the self-hosted PeerServer; used when `signaling` is `lan`. */
  readonly lanHost: string;
  readonly turn: TurnSettings | null;

  // --- Settings menu (T-3.9). All optional and additive: an absent field means its default in
  // DEFAULT_GAME_SETTINGS. `resolveSettings` fills them in; the settings store always holds the
  // full `GameSettings`. Key bindings are not here: see `ControlsUiState`. -----------------------
  /** false pins the render scale at the cap instead of letting it follow the frame time. */
  readonly dynamicResolution?: boolean;
  /**
   * Upper bound for the render scale as a position inside the preset's own bounds: 0 = the
   * preset's `renderScaleMin`, 1 = its `renderScaleMax` (see `renderScaleCapFor`). A fraction
   * keeps its meaning when the preset changes.
   */
  readonly renderScaleCap?: number;
  /** Vertical base FOV in degrees (SETTINGS_LIMITS.fovDeg). */
  readonly fovDeg?: number;
  /** 0..1 multiplier on camera shake amplitude. */
  readonly cameraShake?: number;
  /** Accessibility: no shake, no camera roll, smaller FOV change, no UI motion. */
  readonly reduceMotion?: boolean;
  /** true: one press of the boost key turns boost on, the next turns it off. */
  readonly boostToggle?: boolean;
  /** 0..1, for menu and HUD sounds. */
  readonly uiVolume?: number;
  /** Multiplier on the size of menus and HUD (SETTINGS_LIMITS.uiScale). */
  readonly uiScale?: number;
  /** Stronger team shapes and outlines on markers, for players who cannot tell the colours apart. */
  readonly colorBlindMarkers?: boolean;
  /** Show the small ping / fps chip during a match. */
  readonly showNetChip?: boolean;
  /** Rider name ('' = the fallback name). */
  readonly playerName?: string;
  /**
   * What the automatic quality pick (T-6.2) chose for this computer; null = not tested yet. Used
   * while `quality` is `auto`. Written by the test, never by a menu control.
   */
  readonly autoQuality?: QualityPresetId | null;

  // --- Gamepad (T-6.6). Optional and additive, like the block above. ---------------------------
  /** Multiplier on the left stick's reach (SETTINGS_LIMITS.gamepadSensitivity). */
  readonly gamepadSensitivity?: number;
  /** true: pushing a stick forward lowers the nose. Both sticks. */
  readonly gamepadInvertY?: boolean;
  /** Fraction of a stick's travel round its centre that gives nothing. */
  readonly gamepadDeadZone?: number;
  /** Left stick response curve: 1 = linear, above 1 = finer control near the centre. */
  readonly gamepadCurve?: number;
  /** Shake the pad on a hit taken and on a takedown, where the browser and the pad can. */
  readonly gamepadRumble?: boolean;
}

export const DEFAULT_SETTINGS: SettingsState = {
  quality: 'auto',
  fpsCap: 0,
  masterVolume: 1,
  musicVolume: 0.7,
  sfxVolume: 1,
  mouseSensitivity: 1,
  invertY: false,
  signaling: 'online',
  lanHost: '',
  turn: null,
};

/** Every setting present. The settings store holds one of these. */
export type GameSettings = Required<SettingsState>;

export type QualityChoice = SettingsState['quality'];
export type FpsCap = SettingsState['fpsCap'];

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  ...DEFAULT_SETTINGS,
  dynamicResolution: true,
  renderScaleCap: 1,
  fovDeg: 62,
  cameraShake: 1,
  reduceMotion: false,
  boostToggle: false,
  uiVolume: 0.8,
  uiScale: 1,
  colorBlindMarkers: false,
  showNetChip: true,
  playerName: '',
  autoQuality: null,
  gamepadSensitivity: 1,
  gamepadInvertY: false,
  gamepadDeadZone: 0.15,
  gamepadCurve: 1.6,
  gamepadRumble: false,
};

export interface NumberLimit {
  readonly min: number;
  readonly max: number;
  /** Slider step; stored values are snapped to it. */
  readonly step: number;
}

/** Ranges of the numeric settings: the store clamps to them, the menu builds sliders from them. */
export const SETTINGS_LIMITS = {
  renderScaleCap: { min: 0, max: 1, step: 0.01 },
  fovDeg: { min: 60, max: 100, step: 1 },
  cameraShake: { min: 0, max: 1, step: 0.05 },
  mouseSensitivity: { min: 0.1, max: 5, step: 0.05 },
  volume: { min: 0, max: 1, step: 0.01 },
  uiScale: { min: 0.8, max: 1.3, step: 0.05 },
  gamepadSensitivity: { min: 0.5, max: 2, step: 0.05 },
  gamepadDeadZone: { min: 0.05, max: 0.4, step: 0.01 },
  gamepadCurve: { min: 1, max: 3, step: 0.1 },
} as const satisfies Record<string, NumberLimit>;

/** In menu order: off first. */
export const FPS_CAPS: readonly FpsCap[] = [0, 45, 30];
export const QUALITY_CHOICES: readonly QualityChoice[] = ['auto', 'low', 'medium', 'high'];

/** Longest strings the store keeps (UTF-16 code units). */
export const MAX_LAN_HOST_LENGTH = 253;
export const MAX_TURN_FIELD_LENGTH = 512;

/** `settings` with every absent field filled from DEFAULT_GAME_SETTINGS. Allocates: not per frame. */
export function resolveSettings(settings: SettingsState): GameSettings {
  return { ...DEFAULT_GAME_SETTINGS, ...settings };
}

/**
 * The preset a quality choice means right now. `auto` is what the automatic pick chose
 * (`SettingsState.autoQuality`), and the default preset until it has run.
 */
export function effectiveQuality(
  choice: QualityChoice,
  autoQuality: QualityPresetId | null = null,
): QualityPresetId {
  return choice === 'auto' ? (autoQuality ?? DEFAULT_QUALITY) : choice;
}

/** The render scale a cap fraction stands for under `presetId`, e.g. Medium at 1 = 0.85. */
export function renderScaleCapFor(presetId: QualityPresetId, capFraction: number): number {
  const preset = QUALITY_PRESETS[presetId];
  const t = capFraction >= 0 ? (capFraction <= 1 ? capFraction : 1) : 0;
  return preset.renderScaleMin + (preset.renderScaleMax - preset.renderScaleMin) * t;
}

/** Inverse of `renderScaleCapFor`, clamped to 0..1. */
export function renderScaleCapFraction(presetId: QualityPresetId, scale: number): number {
  const preset = QUALITY_PRESETS[presetId];
  const span = preset.renderScaleMax - preset.renderScaleMin;
  if (!(span > 0)) return 1;
  const t = (scale - preset.renderScaleMin) / span;
  return t >= 0 ? (t <= 1 ? t : 1) : 0;
}

export type SettingsTab = 'video' | 'controls' | 'audio' | 'game';
export const SETTINGS_TABS: readonly SettingsTab[] = ['video', 'controls', 'audio', 'game'];

/**
 * A rebind table as the UI sees it: action id to key codes (`KeyboardEvent.code`, or `Mouse0`..
 * `Mouse4`). `src/input` owns the real type; `shared` only passes it through.
 */
export type BindingTable = Readonly<Record<string, readonly string[]>>;

/**
 * What the Controls tab needs to draw and edit key bindings. `src/game` fills it from
 * `src/input` (the UI cannot import that module) and applies the `settings.rebind` /
 * `settings.unbind` / `settings.resetBindings` intents with the pure functions there.
 */
export interface ControlsUiState {
  /** Action ids in display order. */
  readonly actions: readonly string[];
  readonly bindings: BindingTable;
  readonly defaults: BindingTable;
  /** Codes that cannot be bound (Escape, the OS keys). */
  readonly reservedCodes: readonly string[];
  /** Key slots per action (primary + alternative). */
  readonly slotsPerAction: number;
}

/** Which of the two rebind tables an intent edits. Absent on an intent = the keyboard's. */
export type BindingDevice = 'keyboard' | 'gamepad';

/**
 * The gamepad as the Controls tab sees it (T-6.6). `src/game` keeps one object and rewrites its
 * fields in place: the UI compares the values, it does not keep the object.
 */
export interface GamepadUiState {
  /**
   * This browser lets this page read gamepads at all. False without the Gamepad API, which
   * some browsers only give to a secure page (see `secure`), and when a policy forbids it.
   */
  readonly supported: boolean;
  /**
   * The page is a secure context: `localhost` or HTTPS. A plain http address on the local
   * network is not, and there a browser may hide gamepads.
   */
  readonly secure: boolean;
  /** A pad is being read. Browsers only reveal a pad after a button on it was pressed. */
  readonly connected: boolean;
  /** `Gamepad.id` (vendor / product text); '' without a pad. */
  readonly name: string;
  /** The browser knows the pad's layout. False: buttons may be mixed up until they are rebound. */
  readonly standard: boolean;
  /** The pad's own rebind table (`Pad0`..`Pad16`, `PadFlickLeft` / `PadFlickRight`). */
  readonly controls: ControlsUiState;
  /**
   * The code of the pad button pressed last while the settings panel was open, and a counter
   * that goes up with every such press: the panel binds `pressCode` when the counter moves
   * while it is listening. '' / 0 before the first press.
   */
  readonly pressCode: string;
  readonly pressSeq: number;
}

/**
 * A menu step asked for by a device that sends no key events (the gamepad): move the focus one
 * control in a direction, press the focused control, or step back (what Esc does).
 */
export type UiNavCommand = 'up' | 'down' | 'left' | 'right' | 'accept' | 'back';

// --- State --------------------------------------------------------------------------------------

/** Which screen the app state machine is showing (docs/GAME_DESIGN.md, "Flow"). */
export type UiScreen = 'title' | 'connecting' | 'lobby' | 'loading' | 'match' | 'results';

export type ConnectionStatus = 'offline' | 'connecting' | 'connected' | 'reconnecting';

export interface ConnectionState {
  readonly status: ConnectionStatus;
  readonly isHost: boolean;
  /** NO_PLAYER until the host has sent `welcome`. */
  readonly localPlayerId: PlayerId;
  /** Round trip to the host in ms (0 on the host). */
  readonly pingMs: number;
  /** Message for the title screen: a reject reason, "host left", a signaling failure. */
  readonly error: UiError | null;
}

/**
 * Why hosting or joining failed before a session existed. Mirrors the transport's error reasons
 * (`src/net/transport`), repeated here because `shared` cannot import `net`; a transport reason
 * is assignable as it stands.
 */
export type ConnectFailureReason =
  | 'roomNotFound'
  | 'idTaken'
  | 'brokerUnreachable'
  | 'peerUnavailable'
  | 'timeout'
  | 'invalidRoomCode'
  | 'unsupported'
  | 'unknown';

export type UiError =
  | { readonly kind: 'rejected'; readonly reason: RejectReason }
  | { readonly kind: 'hostLeft' }
  | { readonly kind: 'signalingFailed'; readonly detail: string }
  | { readonly kind: 'connectionLost' }
  /** Hosting or joining failed with a typed reason (preferred over `signalingFailed`). */
  | { readonly kind: 'connectFailed'; readonly reason: ConnectFailureReason }
  /** The host removed this player from a room they had already joined. */
  | { readonly kind: 'kicked' };

/**
 * Why Start is unavailable. Mirrors `StartBlocker` in `src/sim/lobby` (the UI cannot import the
 * sim); `src/game` passes `canStart(...).reason` straight through.
 */
export type UiStartBlocker =
  | 'wrongPhase'
  | 'noRiders'
  | 'teamEmpty'
  | 'teamTooSmall'
  | 'teamOverSize'
  | 'teamsUneven'
  | 'playerReconnecting'
  | 'notAllReady';

export interface LoadingState {
  /** 0..1. */
  readonly progress: number;
  readonly label: string;
}

export interface KillfeedEntry {
  /** NO_PLAYER for environment takedowns. */
  readonly killerId: PlayerId;
  readonly killerName: string;
  readonly killerTeam: TeamId | null;
  readonly victimId: PlayerId;
  readonly victimName: string;
  readonly victimTeam: TeamId;
  /** Seconds since it happened, so the HUD can fade it out. */
  readonly ageS: number;
  /** What dealt the final blow and the killer's class: picks the row's glyph. Absent = plain. */
  readonly source?: DamageSource;
  readonly killerClassId?: DragonClassId | null;
  /**
   * Set on an Ember Relay line (a shard was picked up, dropped, returned or captured) instead
   * of a takedown: `killer*` is then the rider who did it (NO_PLAYER when nobody did) and
   * `victimTeam` the team whose SHARD it is. `victimId` / `victimName` are unused.
   */
  readonly objective?: ObjectiveKind | null;
}

export interface ScoreboardRow {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly team: TeamId;
  readonly classId: DragonClassId;
  readonly takedowns: number;
  readonly deaths: number;
  readonly damage: number;
  readonly pingMs: number;
  readonly alive: boolean;
  /** Absent = 0. */
  readonly assists?: number;
  /** Shards brought home in Ember Relay. Absent = 0. */
  readonly captures?: number;
}

/** The local rider's own gauges. */
export interface HudLocalState {
  readonly classId: DragonClassId;
  readonly alive: boolean;
  /** 0..1 fractions. */
  readonly health: number;
  readonly stamina: number;
  /** m/s. */
  readonly speed: number;
  /** 0..1; the ultimate is ready at 1. */
  readonly ultimateCharge: number;
  /** Cooldown left per ability as a 0..1 fraction (0 = ready). */
  readonly cooldowns: Readonly<Record<AbilitySlot, number>>;
  readonly dodgeCooldown: number;
  /** Seconds until respawn, 0 while alive. */
  readonly respawnInS: number;
  /** Death cam target, or NO_PLAYER. */
  readonly killerId: PlayerId;

  // --- Combat HUD (T-3.6). All optional: an absent field draws its plain default. -------------
  /** Full health in HP (CLASS_TUNING), for the number next to the bar. Absent = no number. */
  readonly healthMax?: number;
  /** The local dragon's DRAGON_FLAG_* bits: status icons (slowed, burning, veiled…). */
  readonly flags?: number;
  /** Per slot index (ABILITY_SLOTS order), straight from `WorldView.local`. */
  readonly cooldownS?: readonly number[];
  readonly charges?: readonly number[];
  readonly maxCharges?: readonly number[];
  /** Absent = ready when its cooldown is 0 (and the ultimate is charged). */
  readonly ready?: readonly boolean[];
  /** The ability's effect is running (dash window, shield up, held breath). */
  readonly active?: readonly boolean[];
  /** Slot index being wound up, or -1; and how far along (0..1). */
  readonly castSlot?: number;
  readonly castProgress?: number;
  /**
   * The buttons held this frame (BUTTON_* bits of the InputFrame). The HUD lights a held slot
   * and flashes one that is pressed while not ready.
   */
  readonly buttons?: number;
  /** Seconds of blindness left (Night terror): the HUD closes a dark veil in. */
  readonly blindS?: number;
}

/** Where the HUD draws the aim reticle. Absent / null = the HUD draws none. */
export interface HudReticleState {
  /** `InputState.reticleX/Y`: offset from the centre in -1..1, x right, y up. */
  readonly x: number;
  readonly y: number;
  /** Pointer is locked. False shows the "click to fly" prompt instead of the reticle. */
  readonly locked: boolean;
}

/** One "you were hurt from over there" arc. A fixed pool: `ageS` past its life = unused. */
export interface HudDamageArc {
  /**
   * Screen angle to the source in radians, clockwise from straight ahead (0 = ahead / top,
   * PI/2 = right, PI = behind). `src/game` computes it from the hit position and camera yaw.
   */
  readonly angle: number;
  /** 0..1: how hard the hit was (arc weight). */
  readonly strength: number;
  /** Seconds since the hit; the arc fades over about a second. */
  readonly ageS: number;
}

/**
 * `shard` and `brazier` are Ember Relay's: a team's sky-shard wherever it is (on its stand,
 * carried, dropped) and the local team's own brazier.
 */
export type HudCompassKind = 'ally' | 'objective' | 'shard' | 'brazier';

/** A marker on the top strip. */
export interface HudCompassMarker {
  readonly kind: HudCompassKind;
  /** Team colour and shape (for a shard or brazier: its owner); null for a neutral objective. */
  readonly team: TeamId | null;
  /** Screen angle like `HudDamageArc.angle`: 0 = dead ahead, positive = to the right. */
  readonly angle: number;
  readonly distanceM: number;
  /** A downed teammate is drawn dim. */
  readonly alive: boolean;
}

/** One team's sky-shard as the HUD shows it (Ember Relay). */
export interface HudShardState {
  /** SHARD_HOME, SHARD_CARRIED or SHARD_DROPPED (`world-view.ts`). */
  readonly status: number;
  /** Who carries it; '' unless carried. */
  readonly carrierName: string;
  /** Dropped: seconds until it goes home by itself. Otherwise 0. */
  readonly returnInS: number;
}

/** Ember Relay's objective state for the HUD. `src/game` mutates one object in place. */
export interface HudRelayState {
  /** Index = the TeamId that OWNS the shard. */
  readonly shards: readonly [ember: HudShardState, frost: HudShardState];
  /** The local rider carries the enemy shard: the HUD says so in large. */
  readonly carrying: boolean;
  /** Metres from the local rider to its own brazier (printed while carrying). */
  readonly brazierDistanceM: number;
  /** The latest shard event, announced for a few seconds; null = none yet. */
  readonly noticeKind: ObjectiveKind | null;
  /** The team whose SHARD the notice is about. */
  readonly noticeTeam: TeamId;
  /** Seconds since the notice; the HUD drops it after a few. */
  readonly noticeAgeS: number;
}

/**
 * A friend-or-foe marker floating over a dragon in the 3D picture: the team's shape in the
 * team's colour, so team identity never rests on the dragon's tint alone. `src/game` projects
 * the dragons with the frame's camera and decides who gets one (never an enemy the local player
 * may not see). A fixed pool of HUD_DRAGON_TAGS entries mutated in place: `shown` false = unused.
 */
export interface HudDragonTag {
  readonly shown: boolean;
  readonly team: TeamId;
  /** An enemy of whoever is looking. Always false for a spectator (on neither side). */
  readonly foe: boolean;
  /** Close enough for the full-size shape; false draws the small one. */
  readonly near: boolean;
  /** The rider's name, or '' where none is shown (enemies, far team mates not aimed at). */
  readonly name: string;
  /** Picture fractions, 0..1 from the top-left corner: the point the marker stands on. */
  readonly x: number;
  readonly y: number;
  /** 0..1: markers fade out towards the end of their range. */
  readonly opacity: number;
}

export interface HudState {
  readonly mode: ModeId;
  readonly phase: MatchPhase;
  readonly round: number;
  /** Indexed by TeamId. Round wins in Duel, takedowns in Skirmish, captures in Ember Relay. */
  readonly scores: readonly [ember: number, frost: number];
  readonly scoreLimit: number;
  /** Seconds, or Infinity with no time limit. */
  readonly timeRemainingS: number;
  /** Whole seconds left on the 3-2-1, or 0 when not counting down. */
  readonly countdown: number;
  /** Null for spectators. */
  readonly local: HudLocalState | null;
  /** Newest first. */
  readonly killfeed: readonly KillfeedEntry[];
  readonly scoreboard: readonly ScoreboardRow[];
  /**
   * True when this client may ask the host to skip the current shared cinematic (intro, or
   * results podium). Launch skip uses the lobby `starting` phase instead. Always true for every
   * player while those moments run (host advances the shared clock).
   */
  readonly canSkipIntro: boolean;
  /**
   * Local death-cam orbit is on screen. Space skips it without asking the host (camera is local).
   */
  readonly deathCamActive?: boolean;
  /** 0..1 letterbox bar strength while a directed cinematic owns the camera. */
  readonly letterbox?: number;

  // --- Combat HUD (T-3.6 / T-3.7). All optional and additive. ----------------------------------
  /** Own scoreboard row and the lookup for "who am I riding with". Absent = NO_PLAYER. */
  readonly localPlayerId?: PlayerId;
  /** Live entries in `killfeed` / `scoreboard` when `src/game` reuses longer pools. */
  readonly killfeedCount?: number;
  readonly scoreboardCount?: number;
  readonly reticle?: HudReticleState | null;
  /**
   * Counters that go up by one each time the local rider lands a hit / gets a takedown. The HUD
   * shows a hit marker when one changes, so no event object crosses the seam.
   */
  readonly hitSeq?: number;
  readonly takedownSeq?: number;
  /** Fixed pool (HUD_DAMAGE_ARCS entries). */
  readonly damageArcs?: readonly HudDamageArc[];
  readonly compass?: readonly HudCompassMarker[];
  readonly compassCount?: number;
  /** Who won the round / match being shown in `roundEnd` / `results`; null while playing. */
  readonly winner?: MatchWinner | null;
  /** Rider being watched while spectating or dead; '' = free camera. */
  readonly spectatingName?: string;
  /** Names of people watching, for the scoreboard footer. */
  readonly spectators?: readonly string[];
  /** Hold-to-show scoreboard, when `src/game` owns the binding (the HUD also listens for Tab). */
  readonly scoreboardOpen?: boolean;
  /** Key captions per slot index (rebinding). Absent = LMB / V / F / R. */
  readonly keyLabels?: readonly string[];
  /** Match intro (T-5.4): the map / mode title card. Absent or null = no card. */
  readonly introCard?: IntroCardState | null;
  /** Ember Relay (T-6.3): both shards and the carry call-out. Absent or null in other modes. */
  readonly relay?: HudRelayState | null;
  /** Markers over the dragons in view (HUD_DRAGON_TAGS entries). Absent = none. */
  readonly dragonTags?: readonly HudDragonTag[];
}

/** The title card of the match intro flyby. `src/game` may mutate one object in place. */
export interface IntroCardState {
  /** Display names, e.g. "Shattered Spires" and "Skirmish". */
  readonly mapName: string;
  readonly modeName: string;
  /** 0..1: the cinematic fades the card in and out. 0 = do not draw. */
  readonly opacity: number;
}

/**
 * A name card floating over a dragon's perch in the aerie lobby (T-5.2). The 3D scene projects
 * each occupied perch to the screen; the UI draws the rider's name and class there (it looks
 * both up in `UiState.lobby` by `playerId`). A fixed pool: read `lobbyPlateCount` entries.
 */
export interface LobbyPlate {
  readonly playerId: PlayerId;
  /** Viewport fractions, 0..1 from the top-left corner: where the bottom centre of the card goes. */
  readonly x: number;
  readonly y: number;
  /** 1 at the usual lobby camera distance; larger in a close-up. Clamp before use. */
  readonly scale: number;
  /** False when the perch is behind the camera or off screen. */
  readonly visible: boolean;
}

/** Pool sizes the HUD draws; `src/game` sizes its arrays to match. */
export const HUD_DAMAGE_ARCS = 4;
export const HUD_KILLFEED_ROWS = 5;
/** Four team mates plus Ember Relay's two shards and own brazier, with one to spare. */
export const HUD_COMPASS_MARKERS = 8;
/** One per dragon of a full 5v5 room: a rider sees at most nine others, a spectator ten. */
export const HUD_DRAGON_TAGS = 10;

/** TBD in T-5.x (results podium): awards beyond the three named in GAME_DESIGN.md. */
export interface ResultsState {
  readonly winner: MatchWinner;
  readonly scores: readonly [ember: number, frost: number];
  readonly mvpId: PlayerId;
  readonly mostTakedownsId: PlayerId;
  readonly mostDamageId: PlayerId;
  readonly scoreboard: readonly ScoreboardRow[];
  /** The mode that was played: says what `scores` count. Absent = takedowns / rounds. */
  readonly mode?: ModeId;
  /** Ember Relay: who brought the most shards home, or NO_PLAYER. Absent in other modes. */
  readonly mostCapturesId?: PlayerId;
}

export interface UiState {
  readonly screen: UiScreen;
  readonly connection: ConnectionState;
  readonly settings: SettingsState;
  /** Present on the lobby screen and kept through the match (teams persist). */
  readonly lobby: LobbyState | null;
  readonly loading: LoadingState | null;
  readonly hud: HudState | null;
  readonly results: ResultsState | null;
  /**
   * Lobby: why Start is unavailable, or null when the host may start. Absent = not computed (the
   * panel then leaves Start enabled and the host's own check decides).
   */
  readonly startBlocker?: UiStartBlocker | null;
  /**
   * Round trip per player in ms, indexed by PlayerId; a missing or negative entry = unknown.
   * `src/game` may mutate one array in place: the UI reads values, it does not keep the array.
   */
  readonly playerPings?: readonly number[];
  /** Match: the escape menu (resume / leave) is showing. */
  readonly pauseMenuOpen?: boolean;
  /**
   * Settings panel (T-3.9). When present the panel follows it: it opens when this turns true and
   * closes when it turns false. `settingsTab` picks the tab at the moment it opens.
   */
  readonly settingsOpen?: boolean;
  readonly settingsTab?: SettingsTab;
  /** Key bindings for the Controls tab. Absent = the tab shows no rebind list. */
  readonly controls?: ControlsUiState;
  /** The gamepad for the Controls tab. Absent = the tab shows no gamepad section. */
  readonly gamepad?: GamepadUiState;

  // --- Cinematics (Phase 5). All optional and additive. ------------------------------------------
  /**
   * Lobby: the 3D aerie is on screen behind the UI, so the lobby must leave the middle of the
   * screen clear (docked panels, no full-screen card). Absent / false = the flat lobby panel.
   */
  readonly aerie?: boolean;
  /** Lobby: name cards over the perches. `src/game` reuses one array: read `lobbyPlateCount`. */
  readonly lobbyPlates?: readonly LobbyPlate[];
  readonly lobbyPlateCount?: number;
  /** Lobby: the rider the close-up camera frames (`lobby.focusPlayer`), or NO_PLAYER. */
  readonly lobbyFocusId?: PlayerId;
  /**
   * 0..1: a full-screen fade to the sky's cream colour for scene cuts (aerie launch into the
   * match intro, results back to the aerie). 0 / absent = none. The UI only draws it.
   */
  readonly fade?: number;
}

// --- Intents ------------------------------------------------------------------------------------

/**
 * `host.*` intents only take effect for the host: the host checks the sender's player id and
 * ignores them from anyone else, so the UI hiding the host panel is a convenience, not security.
 */
export type UiIntent =
  // Title
  | { readonly type: 'title.host'; readonly name: string }
  | { readonly type: 'title.join'; readonly name: string; readonly roomCode: string }
  | { readonly type: 'title.dismissError' }
  /** Fly alone in the sandbox: no room, no network. */
  | { readonly type: 'title.solo'; readonly name: string }
  /** Abandon a host/join attempt that is still connecting. */
  | { readonly type: 'title.cancel' }
  // Lobby (any player)
  | { readonly type: 'lobby.ready'; readonly ready: boolean }
  | { readonly type: 'lobby.pickClass'; readonly classId: DragonClassId }
  /** Frames a player's perch in a close-up; null returns to the drifting camera. Local only. */
  | { readonly type: 'lobby.focusPlayer'; readonly playerId: PlayerId | null }
  | { readonly type: 'lobby.leave' }
  /** Change your own side; refused while teams are locked or the side is full. */
  | LobbySwitchSideIntent
  // Host panel
  | { readonly type: 'host.setMode'; readonly mode: ModeId }
  | { readonly type: 'host.setMap'; readonly map: MapId }
  | { readonly type: 'host.setTeamSize'; readonly teamSize: number }
  | { readonly type: 'host.setUnevenTeams'; readonly enabled: boolean }
  | { readonly type: 'host.setScoreLimit'; readonly scoreLimit: number }
  | { readonly type: 'host.setTimeLimit'; readonly timeLimitS: number }
  | { readonly type: 'host.setFriendlyFire'; readonly enabled: boolean }
  | { readonly type: 'host.setAllowedClasses'; readonly classes: readonly DragonClassId[] }
  | { readonly type: 'host.movePlayer'; readonly playerId: PlayerId; readonly side: LobbySide }
  | { readonly type: 'host.autoBalance' }
  | { readonly type: 'host.shuffle' }
  | { readonly type: 'host.lockTeams'; readonly locked: boolean }
  | { readonly type: 'host.kick'; readonly playerId: PlayerId }
  | { readonly type: 'host.start' }
  /** Bot riders (T-3.10): add / remove / fill / clear, and how well they fly. Host's page only. */
  | LobbyBotIntent
  // Match
  /** Skip the current shared cinematic (launch / intro / podium). Alias: `match.skipIntro`. */
  | { readonly type: 'match.skipCinematic' }
  /** @deprecated Prefer `match.skipCinematic`; kept so older UI / tests still compile. */
  | { readonly type: 'match.skipIntro' }
  | { readonly type: 'match.leave' }
  /**
   * Host only: end the running match and take the whole room back to the lobby (teams and seats
   * are kept, so the host can start again). Handled on the host's own page; a client has no
   * such button and nothing is sent. `match.leave` on the host closes the room instead.
   */
  | { readonly type: 'match.end' }
  /** Open / close the escape menu. Local only; the match keeps running (it is multiplayer). */
  | { readonly type: 'match.pause' }
  | { readonly type: 'match.resume' }
  // Settings (local; a patch so one intent covers every field)
  | { readonly type: 'settings.update'; readonly patch: Partial<SettingsState> }
  /** Reset all: every setting and every key binding back to its default. */
  | { readonly type: 'settings.reset' }
  /** Show the settings panel (title screen, flight menu). In a match it releases the pointer. */
  | { readonly type: 'settings.open'; readonly tab?: SettingsTab }
  | { readonly type: 'settings.close' }
  /**
   * Bind `code` to slot `slot` of `action`. The code is taken from any action that had it; with
   * `swap` that action gets the code this slot held before (when it held one). `device` picks
   * the table on this and the next two intents: absent = the keyboard's.
   */
  | {
      readonly type: 'settings.rebind';
      readonly action: string;
      readonly slot: number;
      readonly code: string;
      readonly swap: boolean;
      readonly device?: BindingDevice;
    }
  | {
      readonly type: 'settings.unbind';
      readonly action: string;
      readonly slot: number;
      readonly device?: BindingDevice;
    }
  /** One action back to its default keys, or all of them with `action: null`. */
  | {
      readonly type: 'settings.resetBindings';
      readonly action: string | null;
      readonly device?: BindingDevice;
    }
  /** Restart the dynamic-resolution scaler so it measures the display again (DECISIONS 16). */
  | { readonly type: 'settings.redetectDisplay' }
  /** "Test again": run the automatic quality pick again and use what it finds (T-6.2). */
  | { readonly type: 'settings.retestQuality' };

export type UiIntentType = UiIntent['type'];
export type UiIntentOf<T extends UiIntentType> = Extract<UiIntent, { type: T }>;

/** How the UI hands intents to `src/game`. */
export type UiIntentHandler = (intent: UiIntent) => void;

/** True for intents the host must authorise against the sender's id. */
export function isHostIntent(intent: UiIntent): boolean {
  return intent.type.startsWith('host.');
}

/** Host-settings fields a `host.set*` intent may change; handy for a generic host panel. */
export type HostSettingKey = keyof HostSettings;
