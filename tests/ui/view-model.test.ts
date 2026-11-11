import { describe, expect, it } from 'vitest';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../src/shared/constants';
import { MAX_PLAYER_NAME_LENGTH } from '../../src/shared/lobby';
import type { RejectReason } from '../../src/shared/lobby';
import type {
  ConnectFailureReason,
  ConnectionStatus,
  UiError,
  UiScreen,
  UiStartBlocker,
} from '../../src/shared/ui';
import {
  QUALITY_BARS,
  chipKind,
  computeLayers,
  createLayerFlags,
  displayPing,
  pauseRole,
  pingBars,
  qualityBars,
} from '../../src/ui/view-model/connection';
import {
  describeStart,
  describeUiError,
  isSessionEndError,
  uiErrorKey,
} from '../../src/ui/view-model/messages';
import {
  cleanPlayerNameInput,
  extractRoomCode,
  isCompleteRoomCode,
  sanitizeRoomCodeInput,
} from '../../src/ui/view-model/room-code';

describe('room code entry', () => {
  it('upper-cases and keeps only alphabet characters', () => {
    expect(sanitizeRoomCodeInput('kh7p2')).toBe('KH7P2');
    expect(sanitizeRoomCodeInput(' k-h 7.p_2 ')).toBe('KH7P2');
  });

  it('drops the look-alikes a code never contains', () => {
    expect(sanitizeRoomCodeInput('O0I1')).toBe('');
    expect(sanitizeRoomCodeInput('o0ki1h')).toBe('KH');
  });

  it('never exceeds the code length', () => {
    expect(sanitizeRoomCodeInput('ABCDEFGH')).toBe('ABCDE');
    expect(sanitizeRoomCodeInput(ROOM_CODE_ALPHABET)).toHaveLength(ROOM_CODE_LENGTH);
  });

  it('is idempotent', () => {
    for (const raw of ['kh7p2', 'a b c', 'zz99zz99', '', '0O1I', 'héllo wörld']) {
      const once = sanitizeRoomCodeInput(raw);
      expect(sanitizeRoomCodeInput(once)).toBe(once);
    }
  });

  it('knows a complete code', () => {
    expect(isCompleteRoomCode('KH7P2')).toBe(true);
    expect(isCompleteRoomCode('KH7P')).toBe(false);
    expect(isCompleteRoomCode('KH7P2A')).toBe(false);
    expect(isCompleteRoomCode('KH7PO')).toBe(false);
    expect(isCompleteRoomCode('kh7p2')).toBe(false);
  });

  it('finds the code in pasted text', () => {
    expect(extractRoomCode('KH7P2')).toBe('KH7P2');
    expect(extractRoomCode('  kh7p2\n')).toBe('KH7P2');
    expect(extractRoomCode('room code: KH7P2')).toBe('KH7P2');
    expect(extractRoomCode('Join my room! The code is kh7p2.')).toBe('KH7P2');
    expect(extractRoomCode('dragonfall-KH7P2')).toBe('KH7P2');
    expect(extractRoomCode('peer id DRAGONFALL-kh7p2 (online)')).toBe('KH7P2');
  });

  it('prefers the last stand-alone code word', () => {
    // "QUICK" is also five alphabet characters; the code comes last in a sentence.
    expect(extractRoomCode('QUICK KH7P2')).toBe('KH7P2');
  });

  it('falls back to typing rules for spaced or dashed codes', () => {
    expect(extractRoomCode('K H 7 P 2')).toBe('KH7P2');
    expect(extractRoomCode('KH-7P2')).toBe('KH7P2');
    expect(extractRoomCode('')).toBe('');
    expect(extractRoomCode('!!!')).toBe('');
  });

  it('ignores a bad code after the peer-id prefix', () => {
    expect(extractRoomCode('dragonfall-O0O0O then ABCDE')).toBe('ABCDE');
  });
});

describe('rider name entry', () => {
  it('trims and collapses white space', () => {
    expect(cleanPlayerNameInput('  Sky   Rider  ')).toBe('Sky Rider');
    expect(cleanPlayerNameInput('a\t\nb')).toBe('a b');
  });

  it('drops control characters', () => {
    expect(cleanPlayerNameInput('a\u0000b\u0007c\u009f')).toBe('abc');
  });

  it('cuts by code point, not by code unit', () => {
    const dragons = '🐉'.repeat(MAX_PLAYER_NAME_LENGTH + 4);
    expect([...cleanPlayerNameInput(dragons)]).toHaveLength(MAX_PLAYER_NAME_LENGTH);
    expect(cleanPlayerNameInput('x'.repeat(40))).toHaveLength(MAX_PLAYER_NAME_LENGTH);
  });

  it('never ends with a space after the cut', () => {
    const name = cleanPlayerNameInput(`${'x'.repeat(MAX_PLAYER_NAME_LENGTH - 1)} yyy`);
    expect(name).toBe('x'.repeat(MAX_PLAYER_NAME_LENGTH - 1));
    expect(cleanPlayerNameInput(`${'x'.repeat(MAX_PLAYER_NAME_LENGTH)} y`)).toBe(
      'x'.repeat(MAX_PLAYER_NAME_LENGTH),
    );
  });

  it('may be empty and is idempotent', () => {
    expect(cleanPlayerNameInput('   ')).toBe('');
    for (const raw of ['  A  B ', 'Ember🔥 Lord of the Sky', 'x']) {
      const once = cleanPlayerNameInput(raw);
      expect(cleanPlayerNameInput(once)).toBe(once);
    }
  });
});

describe('error text', () => {
  const REJECTS: RejectReason[] = ['full', 'versionMismatch', 'kicked', 'matchInProgress'];
  const FAILURES: ConnectFailureReason[] = [
    'roomNotFound',
    'idTaken',
    'brokerUnreachable',
    'peerUnavailable',
    'timeout',
    'invalidRoomCode',
    'unsupported',
    'unknown',
  ];

  function allErrors(): UiError[] {
    return [
      ...REJECTS.map((reason): UiError => ({ kind: 'rejected', reason })),
      ...FAILURES.map((reason): UiError => ({ kind: 'connectFailed', reason })),
      { kind: 'hostLeft' },
      { kind: 'connectionLost' },
      { kind: 'kicked' },
      { kind: 'signalingFailed', detail: 'socket closed' },
      { kind: 'signalingFailed', detail: '' },
    ];
  }

  it('gives every error a title and a hint', () => {
    for (const error of allErrors()) {
      for (const signaling of ['online', 'lan'] as const) {
        const message = describeUiError(error, signaling);
        expect(message.title.length, JSON.stringify(error)).toBeGreaterThan(5);
        expect(message.hint.length, JSON.stringify(error)).toBeGreaterThan(10);
      }
    }
  });

  it('gives each reject and each connect failure its own title', () => {
    const titles = [
      ...REJECTS.map((reason) => describeUiError({ kind: 'rejected', reason }, 'online').title),
      ...FAILURES.map(
        (reason) => describeUiError({ kind: 'connectFailed', reason }, 'online').title,
      ),
    ];
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('explains client isolation when the connection times out', () => {
    const { hint } = describeUiError({ kind: 'connectFailed', reason: 'timeout' }, 'online');
    expect(hint).toMatch(/client isolation/);
    expect(hint).toMatch(/hotspot/);
    expect(hint).toMatch(/TURN/);
  });

  it('names the look-alike rule for a wrong code', () => {
    expect(
      describeUiError({ kind: 'connectFailed', reason: 'roomNotFound' }, 'online').hint,
    ).toMatch(/O, 0, I or 1/);
  });

  it('gives LAN-specific advice when the relay is unreachable', () => {
    const online = describeUiError(
      { kind: 'connectFailed', reason: 'brokerUnreachable' },
      'online',
    );
    const lan = describeUiError({ kind: 'connectFailed', reason: 'brokerUnreachable' }, 'lan');
    expect(lan.hint).toMatch(/peer:lan/);
    expect(lan.hint).toMatch(/9000/);
    expect(online.hint).toMatch(/internet/);
    expect(lan.title).not.toBe(online.title);
  });

  it('shows free-text signaling detail, with a fallback when there is none', () => {
    expect(
      describeUiError({ kind: 'signalingFailed', detail: ' socket closed ' }, 'online').hint,
    ).toBe('socket closed');
    expect(
      describeUiError({ kind: 'signalingFailed', detail: '  ' }, 'online').hint.length,
    ).toBeGreaterThan(10);
  });

  it('returns shared objects for typed errors (no allocation per call)', () => {
    for (const error of allErrors()) {
      if (error.kind === 'signalingFailed' && error.detail !== '') continue;
      expect(describeUiError(error, 'online')).toBe(describeUiError({ ...error }, 'online'));
    }
  });

  it('separates session-ending errors from failed attempts', () => {
    expect(isSessionEndError(null)).toBe(false);
    expect(isSessionEndError({ kind: 'hostLeft' })).toBe(true);
    expect(isSessionEndError({ kind: 'connectionLost' })).toBe(true);
    expect(isSessionEndError({ kind: 'kicked' })).toBe(true);
    expect(isSessionEndError({ kind: 'rejected', reason: 'kicked' })).toBe(false);
    expect(isSessionEndError({ kind: 'connectFailed', reason: 'timeout' })).toBe(false);
    expect(isSessionEndError({ kind: 'signalingFailed', detail: 'x' })).toBe(false);
  });

  it('keys errors by content, so a rebuilt error object is not a change', () => {
    expect(uiErrorKey(null)).toBe('');
    const keys = allErrors().map(uiErrorKey);
    for (const key of keys) expect(key).not.toBe('');
    expect(uiErrorKey({ kind: 'connectFailed', reason: 'timeout' })).toBe(
      uiErrorKey({ kind: 'connectFailed', reason: 'timeout' }),
    );
    expect(uiErrorKey({ kind: 'connectFailed', reason: 'timeout' })).not.toBe(
      uiErrorKey({ kind: 'connectFailed', reason: 'roomNotFound' }),
    );
    expect(uiErrorKey({ kind: 'hostLeft' })).not.toBe(uiErrorKey({ kind: 'connectionLost' }));
  });
});

describe('start line', () => {
  const BLOCKERS: UiStartBlocker[] = [
    'wrongPhase',
    'noRiders',
    'teamEmpty',
    'teamTooSmall',
    'teamOverSize',
    'teamsUneven',
    'playerReconnecting',
    'notAllReady',
  ];

  it('has a distinct sentence per blocker', () => {
    const lines = BLOCKERS.map((blocker) => describeStart(blocker, true, 4));
    expect(new Set(lines).size).toBe(BLOCKERS.length);
    for (const line of lines) expect(line.length).toBeGreaterThan(10);
  });

  it('shows the blocker to guests too', () => {
    expect(describeStart('notAllReady', false, 4)).toBe(describeStart('notAllReady', true, 4));
  });

  it('distinguishes ready, solo and guest when nothing blocks', () => {
    const ready = describeStart(null, true, 4);
    const solo = describeStart(null, true, 1);
    const guest = describeStart(null, false, 4);
    expect(new Set([ready, solo, guest]).size).toBe(3);
    expect(describeStart(undefined, true, 4)).toBe(ready);
  });
});

describe('connection chip', () => {
  it('maps ping to bars with fixed thresholds', () => {
    expect(pingBars(-1)).toBe(0);
    expect(pingBars(Number.NaN)).toBe(0);
    expect(pingBars(0)).toBe(4);
    expect(pingBars(60)).toBe(4);
    expect(pingBars(61)).toBe(3);
    expect(pingBars(110)).toBe(3);
    expect(pingBars(111)).toBe(2);
    expect(pingBars(180)).toBe(2);
    expect(pingBars(181)).toBe(1);
    expect(pingBars(5000)).toBe(1);
  });

  it('never gains bars as ping rises', () => {
    let previous = QUALITY_BARS;
    for (let ping = 0; ping <= 400; ping += 5) {
      const bars = qualityBars('connected', false, ping);
      expect(bars).toBeLessThanOrEqual(previous);
      previous = bars;
    }
  });

  it('shows no bars without a live link and full bars on the host', () => {
    expect(qualityBars('offline', false, 20)).toBe(0);
    expect(qualityBars('connecting', false, 20)).toBe(0);
    expect(qualityBars('reconnecting', false, 20)).toBe(0);
    expect(qualityBars('connected', true, 0)).toBe(QUALITY_BARS);
    expect(qualityBars('connected', false, -1)).toBe(0);
  });

  it('rounds and caps the displayed ping', () => {
    expect(displayPing(41.6)).toBe(42);
    expect(displayPing(12345)).toBe(999);
    expect(displayPing(-5)).toBe(-1);
    expect(displayPing(Number.NaN)).toBe(-1);
  });

  it('picks the chip wording from status and role', () => {
    expect(chipKind('offline', false)).toBe('hidden');
    expect(chipKind('connecting', false)).toBe('connecting');
    expect(chipKind('reconnecting', false)).toBe('reconnecting');
    expect(chipKind('connected', false)).toBe('ping');
    expect(chipKind('connected', true)).toBe('host');
  });
});

describe('escape menu role', () => {
  it('tells a host (who can end the match or close the room) from a guest and a solo flight', () => {
    expect(pauseRole('connected', true)).toBe('host');
    expect(pauseRole('connecting', true)).toBe('host');
    expect(pauseRole('offline', true)).toBe('solo');
    expect(pauseRole('connected', false)).toBe('guest');
    expect(pauseRole('reconnecting', false)).toBe('guest');
    expect(pauseRole('offline', false)).toBe('guest');
  });
});

describe('layer decisions', () => {
  function layers(
    screen: UiScreen,
    status: ConnectionStatus,
    opts: { lobby?: boolean; ended?: boolean; pause?: boolean } = {},
  ) {
    return computeLayers(
      createLayerFlags(),
      screen,
      status,
      opts.lobby ?? false,
      opts.ended ?? false,
      opts.pause ?? false,
    );
  }

  it('shows only the title card on the title and while connecting', () => {
    for (const screen of ['title', 'connecting'] as const) {
      expect(layers(screen, screen === 'title' ? 'offline' : 'connecting')).toEqual({
        title: true,
        lobby: false,
        loading: false,
        chip: false,
        reconnecting: false,
        pause: false,
        notice: false,
      });
    }
  });

  it('keeps the title card up until the lobby state has arrived', () => {
    expect(layers('lobby', 'connected', { lobby: false })).toMatchObject({
      title: true,
      lobby: false,
    });
    expect(layers('lobby', 'connected', { lobby: true })).toMatchObject({
      title: false,
      lobby: true,
      chip: true,
    });
  });

  it('shows the chip in a session but not in a solo flight', () => {
    expect(layers('match', 'connected').chip).toBe(true);
    expect(layers('loading', 'connected')).toMatchObject({ loading: true, chip: true });
    expect(layers('results', 'connected').chip).toBe(true);
    expect(layers('match', 'offline').chip).toBe(false);
  });

  it('shows the rejoin strip only while reconnecting inside a session', () => {
    expect(layers('match', 'reconnecting').reconnecting).toBe(true);
    expect(layers('lobby', 'reconnecting', { lobby: true }).reconnecting).toBe(true);
    expect(layers('match', 'connected').reconnecting).toBe(false);
    expect(layers('title', 'reconnecting').reconnecting).toBe(false);
  });

  it('opens the escape menu only during a match', () => {
    expect(layers('match', 'connected', { pause: true }).pause).toBe(true);
    expect(layers('match', 'offline', { pause: true }).pause).toBe(true);
    expect(layers('lobby', 'connected', { lobby: true, pause: true }).pause).toBe(false);
    expect(layers('title', 'offline', { pause: true }).pause).toBe(false);
  });

  it('lets a session-ending error cover everything', () => {
    for (const screen of ['title', 'lobby', 'loading', 'match', 'results'] as const) {
      const flags = layers(screen, 'reconnecting', { lobby: true, ended: true, pause: true });
      expect(flags.notice, screen).toBe(true);
      expect(flags.pause, screen).toBe(false);
      expect(flags.lobby, screen).toBe(false);
      expect(flags.chip, screen).toBe(false);
      expect(flags.reconnecting, screen).toBe(false);
    }
  });

  it('refills the same object', () => {
    const flags = createLayerFlags();
    expect(computeLayers(flags, 'match', 'connected', false, false, true)).toBe(flags);
    computeLayers(flags, 'title', 'offline', false, false, false);
    expect(flags).toEqual({ ...createLayerFlags(), title: true });
  });
});
