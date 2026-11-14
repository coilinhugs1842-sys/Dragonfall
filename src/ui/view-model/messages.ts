/**
 * Every sentence the menus show for an error or a blocked action, as a pure mapping from the
 * shared contract values. DOM-free and allocation-free (shared frozen objects), except for
 * `signalingFailed`, which carries free text.
 */

import type { RejectReason } from '../../shared/lobby';
import type { ConnectFailureReason, SignalingMode, UiError, UiStartBlocker } from '../../shared/ui';

export interface MessageText {
  readonly title: string;
  /** What the player can do about it. */
  readonly hint: string;
}

function text(title: string, hint: string): MessageText {
  return Object.freeze({ title, hint });
}

const CODE_RULE = 'Codes are five characters and never use O, 0, I or 1.';

const REJECT_TEXT: Readonly<Record<RejectReason, MessageText>> = {
  full: text(
    'That room is full',
    'Every perch and every watcher seat is taken. Ask the host to free a place, then try again.',
  ),
  versionMismatch: text(
    'Your game and the host’s are different versions',
    'Both of you should reload the page so everyone runs the same build, then join again.',
  ),
  kicked: text(
    'The host removed you from this room',
    'You can’t return to your old seat. Check with the host before joining again.',
  ),
  matchInProgress: text(
    'A match is under way in that room',
    'There is no free watcher seat right now. Try again when the riders are back in the aerie.',
  ),
};

const WIFI_HINT =
  'School, work and hotel Wi-Fi often stop devices from talking to each other (client isolation). ' +
  'Online mode already tries a public TURN relay — if it still fails, try a phone hotspot or home router, ' +
  'or put your own TURN URL in Settings.';

const CONNECT_TEXT_ONLINE: Readonly<Record<ConnectFailureReason, MessageText>> = {
  roomNotFound: text(
    'No room answers to that code',
    `Check it with the host. ${CODE_RULE} The host has to keep the room open.`,
  ),
  idTaken: text(
    'That room code is already taken',
    'Someone else opened a room with the same code a moment ago. Host again to get a new one.',
  ),
  brokerUnreachable: text(
    'Can’t reach the meeting service',
    'Check your internet connection. With no internet, switch to Local network and have the host run the LAN relay.',
  ),
  peerUnavailable: text(
    'Reached the host, but couldn’t link up',
    `The peer link failed after the room answered. ${WIFI_HINT}`,
  ),
  timeout: text('Found the room, but couldn’t link up', `The connection timed out. ${WIFI_HINT}`),
  invalidRoomCode: text('That isn’t a room code', CODE_RULE),
  unsupported: text(
    'This browser can’t join rooms',
    'Dragonfall needs WebRTC data channels. Use a current version of Chrome or Edge.',
  ),
  unknown: text(
    'Something went wrong while connecting',
    'Try again. If it keeps happening, reload the page.',
  ),
};

/** LAN mode differs only where the advice does. */
const CONNECT_TEXT_LAN: Readonly<Record<ConnectFailureReason, MessageText>> = {
  ...CONNECT_TEXT_ONLINE,
  roomNotFound: text(
    'No room answers to that code',
    `Check it with the host. ${CODE_RULE} Host and riders must both be set to Local network.`,
  ),
  brokerUnreachable: text(
    'Can’t reach the local relay',
    'The host computer must be running the LAN relay (npm run peer:lan) and allow port 9000 through its firewall.',
  ),
};

const HOST_LEFT = text(
  'The host has left',
  'The room closed with them, so this flight is over. Anyone can open a new room from the title.',
);
const CONNECTION_LOST = text(
  'Connection lost',
  'The link to the host dropped and could not be restored in time. Check your network, then rejoin with the same room code.',
);
const KICKED = text(
  'You were removed from the room',
  'The host took you out of this room. Check with them before joining again.',
);
const SIGNALING_FALLBACK = text(
  'Couldn’t connect',
  'Check your network and try again. If it keeps happening, reload the page.',
);

/**
 * Title and advice for an error. `signaling` picks LAN-specific advice. Returns a shared object
 * for every typed error; a new one only for `signalingFailed` with detail text.
 */
export function describeUiError(error: UiError, signaling: SignalingMode): MessageText {
  switch (error.kind) {
    case 'rejected':
      return REJECT_TEXT[error.reason] ?? SIGNALING_FALLBACK;
    case 'connectFailed':
      return (
        (signaling === 'lan' ? CONNECT_TEXT_LAN : CONNECT_TEXT_ONLINE)[error.reason] ??
        CONNECT_TEXT_ONLINE.unknown
      );
    case 'hostLeft':
      return HOST_LEFT;
    case 'connectionLost':
      return CONNECTION_LOST;
    case 'kicked':
      return KICKED;
    case 'signalingFailed': {
      const detail = error.detail.trim();
      return detail === '' ? SIGNALING_FALLBACK : { title: SIGNALING_FALLBACK.title, hint: detail };
    }
  }
}

/**
 * True for errors that end a session the player was already in. They get the full-screen notice
 * with "Back to title"; everything else is a failed attempt and shows inline on the title screen.
 */
export function isSessionEndError(error: UiError | null): boolean {
  if (error === null) return false;
  return error.kind === 'hostLeft' || error.kind === 'connectionLost' || error.kind === 'kicked';
}

/**
 * Cheap identity for "is this still the same message": equal keys mean equal text, so the screen
 * rewrites the DOM only when the key changes even if `src/game` rebuilds the error object.
 */
export function uiErrorKey(error: UiError | null): string {
  if (error === null) return '';
  switch (error.kind) {
    case 'rejected':
    case 'connectFailed':
      return error.reason;
    case 'signalingFailed':
      return error.detail === '' ? 'signalingFailed' : error.detail;
    default:
      return error.kind;
  }
}

const START_BLOCKER_TEXT: Readonly<Record<UiStartBlocker, string>> = {
  wrongPhase: 'The riders are already launching.',
  noRiders: 'Nobody is on a team yet.',
  teamEmpty: 'Each order needs at least one rider.',
  teamTooSmall: 'This mode needs more riders on each team.',
  teamOverSize: 'A team has more riders than the team size allows.',
  teamsUneven: 'The teams are uneven. Balance them or allow uneven teams.',
  playerReconnecting: 'A rider is reconnecting. Wait, move them to the watchers, or remove them.',
  notAllReady: 'Waiting for every rider to ready up.',
};

const START_READY = 'All set. Launch when you like.';
const START_SOLO = 'You are alone here: Start launches a free flight.';
const START_GUEST = 'The host starts the match.';

/** The line under the Start button. */
export function describeStart(
  blocker: UiStartBlocker | null | undefined,
  isHost: boolean,
  memberCount: number,
): string {
  if (blocker !== null && blocker !== undefined) {
    return START_BLOCKER_TEXT[blocker] ?? 'The match can’t start yet.';
  }
  if (!isHost) return START_GUEST;
  return memberCount === 1 ? START_SOLO : START_READY;
}
