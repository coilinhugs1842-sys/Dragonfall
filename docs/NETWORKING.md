# Networking: host-authoritative peer-to-peer

## Topology

```
          client ─┐
          client ─┤
 client ── HOST ──┼─ client        star: every client connects only to the host
          client ─┤                the host runs the authoritative sim and also plays
          client ─┘                up to 9 clients (5v5) + spectators
```

- The **host** is the browser tab where someone clicked **Host game**. It owns the sim, decides every hit, kill
  and score, and relays nothing peer-to-peer between clients.
- **Clients** send only inputs and lobby intents. They predict their own dragon locally and interpolate everyone
  else.
- If the host leaves, the match ends and everyone returns to the title screen with a message. Host migration is
  out of scope for v1.

## Connection setup (signaling)

WebRTC needs a signaling step to introduce peers. After that, game traffic flows directly between the host and
each client.

| Mode | Signaling | When to use |
| --- | --- | --- |
| **Online (default)** | PeerJS public cloud broker (`0.peerjs.com`) | Everyone has internet. No setup. |
| **LAN / offline** | Host runs `npm run peer:lan` (self-hosted PeerServer on port 9000) | No internet, or the public broker is down |

- **Room code:** the host registers the peer id `dragonfall-<CODE>`, where CODE is 5 characters from an
  unambiguous alphabet (no 0/O/1/I). Clients type the code to connect.
- **NAT traversal:** STUN (Google's public STUN servers) by default. A **TURN relay** is optional and
  configurable in settings, and is only needed on networks that block peer-to-peer traffic.
- **Important for school, work and hotel Wi-Fi:** many of these networks use *client isolation*, which stops
  laptops on the same Wi-Fi from talking to each other. If players can join the room but never connect, use a
  phone hotspot or home router, or configure TURN.

## Where players load the game from

- **Default:** deploy the static build (`npm run build` → `dist/`) to a free HTTPS static host (Cloudflare Pages,
  Netlify or GitHub Pages). Everyone opens the same URL. HTTPS avoids browser secure-context problems.
- **LAN fallback:** the host runs `npm run preview` and the others open `http://<host-ip>:4173`. Phase 2 must
  verify that WebRTC and everything else we use works from a plain-HTTP LAN origin in Chrome and Edge. If it
  doesn't, we switch the LAN fallback to HTTPS with `@vitejs/plugin-basic-ssl` (players accept a self-signed
  certificate once).

## Channels

Each client↔host link has two data channels:

| Channel | Settings | Carries |
| --- | --- | --- |
| `ctrl` | reliable, ordered | handshake, lobby state, intents, chat, GameEvents (takedowns, objectives, phase changes), pings |
| `fast` | unreliable, unordered (`maxRetransmits: 0`) | client → host inputs, host → client snapshots |

The Phase 2 spike must confirm that PeerJS 1.5 gives us an unreliable channel (`reliable: false`). If it can't,
`net/` creates the second channel directly on the underlying `RTCPeerConnection`.

## Tick rates and timing

| Thing | Rate |
| --- | --- |
| Host sim | 30 Hz fixed |
| Client → host inputs | 30 Hz. Each packet also repeats the previous 2 inputs, which covers packet loss |
| Host → client snapshots | 20 Hz |
| Client interpolation delay | 100 ms (adapts 70–150 ms to measured jitter) |
| Ping / clock sync | 2 Hz on `ctrl` |

## Prediction, reconciliation, lag compensation

- **Own dragon:** the client runs the same `sim` flight code on its own inputs straight away (prediction). When a
  snapshot arrives with `lastProcessedInputTick`, it snaps to the host's state and replays its unacknowledged
  inputs (reconciliation). Small errors are smoothed over about 100 ms so they don't pop visibly.
- **Other dragons:** drawn about 100 ms in the past by interpolating between buffered snapshots. If a snapshot is
  late, the client extrapolates for at most 150 ms.
- **Projectiles and breath:** the client shows its own shot instantly as a cosmetic effect. The host decides the
  hits. **Lag compensation:** the host keeps about 300 ms of dragon position history and checks hits against
  where targets were when the shooter saw them (RTT/2 + interpolation delay, capped at 200 ms).
- **Abilities with big effects** (shield, veil, phase dive) are confirmed by the host before their gameplay
  effect applies. The client plays the wind-up animation in the meantime, so it still feels instant.

## Binary protocol

- `ArrayBuffer` messages with a `DataView` codec in `net/codec.ts`. JSON is used only for rare `ctrl` messages
  such as lobby settings.
- Message header: `u8 type`, `u16 tick`.
- **Dragon state in a snapshot (~22 bytes):** `u8 id`, position as 3 × `i16` (map space quantized to about
  6 cm), orientation as a smallest-three quaternion packed into `u32`, velocity as 3 × `i8` scaled, `u8`
  health, `u8` stamina, `u8` flags, `u8` animation state.
- **Budget:** 10 dragons × 22 B + projectiles + header ≈ 350 B × 20 Hz ≈ **7 KB/s per client**. The host
  uploads about 63 KB/s to 9 clients (about 0.5 Mbps). Laptop Wi-Fi handles that easily.
- Delta compression is optional (Phase 6) and only if measurements show it's needed.

## Lobby protocol (on `ctrl`)

1. Client → host: `hello { name, protocolVersion, reconnectToken? }`
2. Host → client: `welcome { playerId, lobbyState }` or `reject { reason }` (full, version mismatch, kicked,
   match in progress with no spectator slots)
3. The host broadcasts the full `lobbyState` whenever it changes: players, teams, classes, ready flags, host
   settings.
4. Host-only intents (`setTeamSize`, `movePlayer`, `start`, ...) are checked against the host's player id. When
   clients send them, they're ignored.
5. **Reconnect:** a disconnected player's slot is kept for 30 s. The client keeps its `reconnectToken` in
   `sessionStorage` and rejoins the same slot.

## Testing without 10 laptops

- `?bots=N` on the host spawns N headless **net-bots**: in-page fake clients that go through the real codec with
  random inputs. Built in Phase 2 for load testing.
- Several browser tabs on one machine work as real clients. Background tabs throttle timers, so use separate
  windows.
- `dev/netsim` adds artificial latency, jitter and packet loss to the transport. Test at 80 ms ± 20 ms with 2%
  loss as the standard "bad Wi-Fi" profile.
- Before calling a phase done, test on **real target laptops**, with the host on the weakest machine.

## Trust

The host is trusted, which is acceptable for games among friends. Clients can't set state. The host clamps
input values and rate-limits intents, and that covers it.
