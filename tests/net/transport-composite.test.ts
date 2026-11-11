import { describe, expect, it } from 'vitest';
import {
  NOOP_CLIENT_HANDLERS,
  createCompositeHostTransport,
  createLoopbackHub,
} from '../../src/net/transport';
import type {
  Channel,
  HostTransportHandlers,
  LinkId,
  LoopbackClientTransport,
  TransportError,
  TransportMessage,
} from '../../src/net/transport';

const ROOM = 'KH7P2';

interface Log {
  opened: string[];
  errors: TransportError[];
  connected: LinkId[];
  disconnected: [LinkId, string][];
  messages: [LinkId, Channel, number][];
}

function recorder(): { log: Log; handlers: HostTransportHandlers } {
  const log: Log = { opened: [], errors: [], connected: [], disconnected: [], messages: [] };
  return {
    log,
    handlers: {
      onOpen: (code) => log.opened.push(code),
      onError: (error) => log.errors.push(error),
      onPeerConnected: (link) => log.connected.push(link),
      onPeerDisconnected: (link, reason) => log.disconnected.push([link, reason]),
      onMessage: (link, channel, data: TransportMessage) =>
        log.messages.push([
          link,
          channel,
          typeof data === 'string' ? -1 : (new Uint8Array(data)[0] ?? -1),
        ]),
    },
  };
}

/** Two separate hubs stand in for "WebRTC" and "the in-page bot network". */
function rig() {
  const real = createLoopbackHub();
  const local = createLoopbackHub();
  const composite = createCompositeHostTransport(real.createHost(), local.createHost());
  const { log, handlers } = recorder();
  composite.setHandlers(handlers);
  const pump = (): void => {
    for (let i = 0; i < 4; i++) {
      real.pump();
      local.pump();
    }
  };
  const received = (client: LoopbackClientTransport): number[] => {
    const bytes: number[] = [];
    client.setHandlers({
      ...NOOP_CLIENT_HANDLERS,
      onMessage: (_channel, data) => {
        if (typeof data !== 'string') bytes.push(new Uint8Array(data)[0] ?? -1);
      },
    });
    return bytes;
  };
  return { real, local, composite, log, pump, received };
}

describe('CompositeHostTransport', () => {
  it('opens the secondary under the primary room code and reports one open', () => {
    const { real, local, composite, log, pump } = rig();
    expect(composite.state).toBe('idle');
    composite.open(ROOM);
    pump();
    expect(composite.state).toBe('open');
    expect(composite.roomCode).toBe(ROOM);
    expect(log.opened).toEqual([ROOM]);

    // Both networks now answer to the same code.
    const human = real.createClient();
    const bot = local.createClient();
    human.connect(ROOM);
    bot.connect(ROOM);
    pump();
    expect(human.state).toBe('open');
    expect(bot.state).toBe('open');
    expect(log.connected).toHaveLength(2);
    expect(new Set(log.connected).size).toBe(2);
  });

  it('routes sends, messages and closes to the transport a link came from', () => {
    const { real, local, composite, log, pump, received } = rig();
    composite.open(ROOM);
    pump();
    const human = real.createClient();
    const bot = local.createClient();
    const humanGot = received(human);
    const botGot = received(bot);
    human.connect(ROOM);
    pump();
    bot.connect(ROOM);
    pump();
    const [humanLink, botLink] = log.connected;
    if (humanLink === undefined || botLink === undefined) throw new Error('links missing');
    // Both inner transports number their first link 1; the composite keeps them apart.
    expect(humanLink).not.toBe(botLink);

    human.send('ctrl', new Uint8Array([11]));
    bot.send('fast', new Uint8Array([22]));
    pump();
    expect(log.messages).toEqual([
      [humanLink, 'ctrl', 11],
      [botLink, 'fast', 22],
    ]);

    expect(composite.send(humanLink, 'ctrl', new Uint8Array([33]))).toBe(true);
    expect(composite.send(botLink, 'ctrl', new Uint8Array([44]))).toBe(true);
    expect(composite.send(9998, 'ctrl', new Uint8Array([55]))).toBe(false);
    pump();
    expect(humanGot).toEqual([33]);
    expect(botGot).toEqual([44]);

    composite.close(botLink);
    pump();
    expect(log.disconnected).toEqual([[botLink, 'local']]);
    expect(bot.state).toBe('closed');
    expect(human.state).toBe('open');

    human.close();
    pump();
    expect(log.disconnected[1]).toEqual([humanLink, 'remote']);
  });

  it('fails with the primary and keeps the secondary shut', () => {
    const real = createLoopbackHub();
    const local = createLoopbackHub();
    const squatter = real.createHost();
    squatter.open(ROOM);
    real.pump();
    const secondary = local.createHost();
    const composite = createCompositeHostTransport(real.createHost(), secondary);
    const { log, handlers } = recorder();
    composite.setHandlers(handlers);
    composite.open(ROOM);
    real.pump();
    local.pump();
    expect(log.opened).toEqual([]);
    expect(log.errors.map((e) => [e.reason, e.fatal])).toEqual([['idTaken', true]]);
    expect(composite.state).toBe('closed');
    expect(secondary.state).toBe('idle');

    // A retry under a new code opens both.
    composite.open('ABCDE');
    real.pump();
    local.pump();
    expect(log.opened).toEqual(['ABCDE']);
    expect(secondary.state).toBe('open');
  });

  it('is silent and final after dispose', () => {
    const { real, local, composite, log, pump } = rig();
    composite.open(ROOM);
    pump();
    const human = real.createClient();
    const bot = local.createClient();
    human.connect(ROOM);
    bot.connect(ROOM);
    pump();
    composite.dispose();
    pump();
    expect(human.state).toBe('closed');
    expect(bot.state).toBe('closed');
    expect(log.disconnected).toEqual([]);
    expect(composite.state).toBe('closed');
  });
});
