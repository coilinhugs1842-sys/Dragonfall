import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STUN_URLS,
  FAST_CHANNEL_ID,
  FAST_CHANNEL_INIT,
  buildIceServers,
  buildPeerOptions,
  cloudSignaling,
  lanSignaling,
  mapPeerErrorType,
} from '../../src/net/transport';
import type { TransportErrorReason } from '../../src/net/transport';
import { LAN_PEER_PATH, LAN_PEER_PORT } from '../../src/shared/constants';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('fast channel definition', () => {
  it('is unreliable, unordered and negotiated on a fixed id', () => {
    expect(FAST_CHANNEL_INIT).toEqual({
      negotiated: true,
      id: FAST_CHANNEL_ID,
      ordered: false,
      maxRetransmits: 0,
    });
    // 0 and 1 are what PeerJS's own in-band channel can be assigned.
    expect(FAST_CHANNEL_ID).toBeGreaterThanOrEqual(2);
    expect('maxPacketLifeTime' in FAST_CHANNEL_INIT).toBe(false);
  });
});

describe('buildPeerOptions', () => {
  it('leaves the cloud broker to the PeerJS defaults and adds STUN', () => {
    const options = buildPeerOptions({ signaling: cloudSignaling() });
    expect(options.host).toBeUndefined();
    expect(options.port).toBeUndefined();
    expect(options.path).toBeUndefined();
    expect(options.secure).toBeUndefined();
    expect(options.debug).toBe(0);
    expect(options.config.iceServers).toEqual([{ urls: [...DEFAULT_STUN_URLS] }]);
    expect(options.config.iceTransportPolicy).toBeUndefined();
  });

  it('points LAN mode at the peer:lan server on the page host, without TLS or STUN', () => {
    const options = buildPeerOptions({ signaling: lanSignaling('192.168.1.20') });
    expect(options.host).toBe('192.168.1.20');
    expect(options.port).toBe(LAN_PEER_PORT);
    expect(options.path).toBe(LAN_PEER_PATH);
    expect(options.secure).toBe(false);
    expect(options.config.iceServers).toEqual([]);
  });

  it('honours LAN overrides', () => {
    const options = buildPeerOptions({
      signaling: { mode: 'lan', host: 'box.local', port: 9443, path: '/x', secure: true },
      stunUrls: ['stun:box.local:3478'],
    });
    expect(options).toMatchObject({ host: 'box.local', port: 9443, path: '/x', secure: true });
    expect(options.config.iceServers).toEqual([{ urls: ['stun:box.local:3478'] }]);
  });

  it('adds an optional TURN relay after STUN', () => {
    const turn = { urls: ['turn:relay.example:3478'], username: 'u', credential: 'p' };
    expect(buildIceServers({ signaling: cloudSignaling(), turn })).toEqual([
      { urls: [...DEFAULT_STUN_URLS] },
      { urls: ['turn:relay.example:3478'], username: 'u', credential: 'p' },
    ]);
    expect(
      buildIceServers({
        signaling: cloudSignaling(),
        stunUrls: [],
        turn: { ...turn, urls: 'turn:one.example' },
      }),
    ).toEqual([{ urls: 'turn:one.example', username: 'u', credential: 'p' }]);
    expect(buildIceServers({ signaling: cloudSignaling(), turn: null })).toHaveLength(1);
  });

  it('can force relay-only and pass the debug level', () => {
    const options = buildPeerOptions({ signaling: cloudSignaling(), relayOnly: true, debug: 2 });
    expect(options.config.iceTransportPolicy).toBe('relay');
    expect(options.debug).toBe(2);
  });

  it('does not share arrays with its input', () => {
    const stunUrls = ['stun:a.example'];
    const options = buildPeerOptions({ signaling: cloudSignaling(), stunUrls });
    stunUrls.push('stun:b.example');
    expect(options.config.iceServers).toEqual([{ urls: ['stun:a.example'] }]);
  });
});

describe('mapPeerErrorType', () => {
  const cases: readonly (readonly [string, TransportErrorReason, TransportErrorReason])[] = [
    // PeerJS type, as client, as host
    ['peer-unavailable', 'roomNotFound', 'peerUnavailable'],
    ['unavailable-id', 'idTaken', 'idTaken'],
    ['invalid-id', 'invalidRoomCode', 'invalidRoomCode'],
    ['network', 'brokerUnreachable', 'brokerUnreachable'],
    ['server-error', 'brokerUnreachable', 'brokerUnreachable'],
    ['socket-error', 'brokerUnreachable', 'brokerUnreachable'],
    ['socket-closed', 'brokerUnreachable', 'brokerUnreachable'],
    ['ssl-unavailable', 'brokerUnreachable', 'brokerUnreachable'],
    ['disconnected', 'brokerUnreachable', 'brokerUnreachable'],
    ['webrtc', 'peerUnavailable', 'peerUnavailable'],
    ['negotiation-failed', 'peerUnavailable', 'peerUnavailable'],
    ['connection-closed', 'peerUnavailable', 'peerUnavailable'],
    ['browser-incompatible', 'unsupported', 'unsupported'],
    ['invalid-key', 'unknown', 'unknown'],
    ['not-open-yet', 'unknown', 'unknown'],
    ['message-too-big', 'unknown', 'unknown'],
    ['', 'unknown', 'unknown'],
    ['something-new', 'unknown', 'unknown'],
  ];

  it.each(cases)('%s -> client %s / host %s', (type, asClient, asHost) => {
    expect(mapPeerErrorType(type, 'client')).toBe(asClient);
    expect(mapPeerErrorType(type, 'host')).toBe(asHost);
  });

  it('covers every error type the installed PeerJS declares', () => {
    // Read the enums from the library's typings, so an upgrade that adds an error type fails
    // here instead of silently mapping to 'unknown'.
    const types = readFileSync(resolve(ROOT, 'node_modules/peerjs/dist/types.d.ts'), 'utf8');
    const enumValues = (name: string): string[] => {
      const body = new RegExp(`enum ${name} \\{([\\s\\S]*?)\\n\\}`).exec(types)?.[1] ?? '';
      return [...body.matchAll(/=\s*"([^"]+)"/g)].map((match) => match[1] ?? '');
    };
    const peerTypes = enumValues('PeerErrorType');
    const connTypes = [
      ...enumValues('BaseConnectionErrorType'),
      ...enumValues('DataConnectionErrorType'),
    ];
    expect(peerTypes.length).toBeGreaterThanOrEqual(12);
    expect(connTypes.length).toBeGreaterThanOrEqual(4);
    const known = new Set(cases.map(([type]) => type));
    for (const type of [...peerTypes, ...connTypes]) expect(known.has(type), type).toBe(true);
  });
});
