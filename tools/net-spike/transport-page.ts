// Throwaway check of the real transport classes in a browser (see transport.html).
import { generateRoomCode } from '../../src/net/room-code';
import { PeerJsClientTransport, PeerJsHostTransport } from '../../src/net/transport/peerjs';
import type { PeerTransportConfig } from '../../src/net/transport/signaling';
import { cloudSignaling, lanSignaling } from '../../src/net/transport/signaling';
import type { Channel, TransportMessage } from '../../src/net/transport/transport';
import { NOOP_CLIENT_HANDLERS, NOOP_HOST_HANDLERS } from '../../src/net/transport/transport';

const query = new URLSearchParams(location.search);
const role = query.get('role') ?? 'host';
const code = query.get('code') ?? 'ABCDE';
const mode = query.get('mode') ?? 'lan';
const config: PeerTransportConfig = {
  signaling: mode === 'lan' ? lanSignaling(location.hostname) : cloudSignaling(),
};

interface Spike {
  role: string;
  mode: string;
  done: boolean;
  hostOpen: boolean;
  error: string | null;
  log: string[];
  result: Record<string, unknown>;
}
const spike: Spike = { role, mode, done: false, hostOpen: false, error: null, log: [], result: {} };
(window as unknown as { spike: Spike }).spike = spike;
const out = document.getElementById('out');
const t0 = performance.now();
function log(line: string): void {
  spike.log.push(`${Math.round(performance.now() - t0)}ms ${line}`);
  if (out) out.textContent += line + '\n';
}
const show = (data: TransportMessage): string =>
  typeof data === 'string' ? `"${data}"` : `<${data.byteLength} bytes>`;

if (role === 'host') {
  const host = new PeerJsHostTransport(config);
  host.setHandlers({
    onOpen: (room) => {
      log(`open ${room}`);
      spike.hostOpen = true;
    },
    onError: (error) => log(`error ${error.reason} fatal=${error.fatal} ${error.message}`),
    onPeerConnected: (link) => log(`+${link}`),
    onPeerDisconnected: (link, reason) => log(`-${link} ${reason}`),
    onMessage: (link, channel, data) => {
      if (data === 'kick-me') {
        log(`${link} asked to be kicked`);
        host.close(link);
      } else if (typeof data === 'string') {
        log(`${link} ${channel} ${show(data)}`);
        host.send(link, channel, data);
      } else {
        host.send(link, channel, data); // echo
      }
    },
  });
  host.open(code);
} else {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const run = async (): Promise<void> => {
    // 1. Wrong room code.
    const stray = new PeerJsClientTransport(config);
    let wrong = generateRoomCode();
    if (wrong === code) wrong = generateRoomCode();
    const started = performance.now();
    spike.result['wrongCode'] = await new Promise<string>((resolve) => {
      stray.setHandlers({
        ...NOOP_CLIENT_HANDLERS,
        onOpen: () => resolve('unexpected open'),
        onError: (error) =>
          resolve(
            `${error.reason} fatal=${error.fatal} after ${Math.round(performance.now() - started)}ms`,
          ),
      });
      stray.connect(wrong);
    });
    spike.result['wrongCodeState'] = stray.state;
    log(`wrong code: ${String(spike.result['wrongCode'])}`);

    // 2. Second host on a taken code.
    const usurper = new PeerJsHostTransport(config);
    spike.result['secondHost'] = await new Promise<string>((resolve) => {
      usurper.setHandlers({
        ...NOOP_HOST_HANDLERS,
        onOpen: () => resolve('unexpected open'),
        onError: (error) => resolve(`${error.reason} fatal=${error.fatal}`),
      });
      usurper.open(code);
    });
    log(`second host: ${String(spike.result['secondHost'])}`);

    // 3. Real connect, pings on both channels with one reused send buffer.
    const client = new PeerJsClientTransport(config);
    const events: string[] = [];
    let onBinary: ((channel: Channel, data: ArrayBuffer) => void) | null = null;
    let waiter: ((event: string) => void) | null = null;
    const emit = (event: string): void => {
      events.push(event);
      log(event);
      waiter?.(event);
    };
    const next = (prefix: string, ms = 20000): Promise<string> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve('TIMEOUT waiting for ' + prefix), ms);
        waiter = (event) => {
          if (!event.startsWith(prefix)) return;
          clearTimeout(timer);
          waiter = null;
          resolve(event);
        };
      });
    client.setHandlers({
      onOpen: () => emit('open'),
      onClose: (reason) => emit(`close ${reason}`),
      onError: (error) => emit(`error ${error.reason} ${error.message}`),
      onMessage: (channel, data) => {
        if (typeof data === 'string') emit(`msg ${channel} ${show(data)}`);
        else onBinary?.(channel, data);
      },
    });
    const connectStart = performance.now();
    let opened = next('open');
    client.connect(code);
    spike.result['connect'] = await opened;
    spike.result['connectMs'] = Math.round(performance.now() - connectStart);

    const internals = client as unknown as {
      fast: RTCDataChannel;
      conn: { dataChannel: RTCDataChannel };
    };
    const props = (dc: RTCDataChannel): Record<string, unknown> => ({
      label: dc.label,
      id: dc.id,
      ordered: dc.ordered,
      maxRetransmits: dc.maxRetransmits,
      negotiated: dc.negotiated,
      binaryType: dc.binaryType,
    });
    spike.result['channels'] = {
      ctrl: props(internals.conn.dataChannel),
      fast: props(internals.fast),
    };

    const scratch = new ArrayBuffer(64);
    const view = new DataView(scratch);
    const payload = new Uint8Array(scratch, 0, 12);
    const ping = async (channel: Channel): Promise<Record<string, unknown>> => {
      let got = 0;
      let sum = 0;
      let sizesOk = true;
      onBinary = (from, data) => {
        if (from !== channel || data.byteLength !== 12) {
          sizesOk = false;
          return;
        }
        sum += performance.now() - new DataView(data).getFloat64(4);
        got++;
      };
      let sent = 0;
      for (let seq = 0; seq < 60; seq++) {
        view.setUint32(0, seq);
        view.setFloat64(4, performance.now());
        if (client.send(channel, payload)) sent++;
        await sleep(33);
      }
      await sleep(300);
      onBinary = null;
      return { sent, got, avgRttMs: got > 0 ? Number((sum / got).toFixed(2)) : null, sizesOk };
    };
    spike.result['ctrlPing'] = await ping('ctrl');
    spike.result['fastPing'] = await ping('fast');

    const echoed = next('msg ctrl');
    client.send('ctrl', '{"type":"hello"}');
    spike.result['ctrlString'] = await echoed;

    // 4. Host kicks us.
    const kicked = next('close');
    const kickStart = performance.now();
    client.send('ctrl', 'kick-me');
    spike.result['kicked'] = `${await kicked} after ${Math.round(performance.now() - kickStart)}ms`;
    spike.result['sendAfterClose'] = client.send('ctrl', 'x');

    // 5. Reconnect on the same transport, then leave ourselves.
    opened = next('open');
    client.connect(code);
    spike.result['reconnect'] = await opened;
    await sleep(300);
    client.close();
    spike.result['afterLocalClose'] = `${events[events.length - 1] ?? ''} state=${client.state}`;
    await sleep(1500); // let the host notice before the driver reads its log
    spike.result['events'] = events;
  };
  run()
    .catch((error: unknown) => {
      spike.error = String(error);
      log('ERROR ' + spike.error);
    })
    .finally(() => {
      spike.done = true;
    });
}
