# Progress log

Newest entries at the top. Claude updates this at the end of every task and session, so a fresh chat can pick
up where the last one stopped.

## Current state

- **Phase:** 3 (Combat + MVP modes) built; Phase 4 (art pass) is next. The user asked (2026-11-10) for all
  remaining phases to be built back to back without stopping; gates for Phases 0-3 are still theirs to run on
  real laptops.
- **Next:** T-4.1.
- **Open issues:** see the latest entry.

## Log

### 2026-11-11: Phase 3 combat + MVP modes (T-3.1 to T-3.10)
- A full Duel and a full Skirmish play start to finish against bots or a second player: countdown, rounds,
  results table, back to the lobby with teams kept. Graphics are still greybox and placeholder dragons; the
  real look lands in Phase 4.
- **T-3.1** Health, damage, takedowns with assists, 5 s respawn with spawn protection, GameEvents.
- **T-3.2** All 16 abilities, data-driven in `src/shared/abilities.ts` (bolts, cones, beams, dash, shield,
  heal, zones, veil, phase dive, blind).
- **T-3.3** Host lag compensation (rewind at most 200 ms). Client on `netsim=bad` firing at a circling host:
  44.6 % hit rate with it, 6.7 % with `?lagcomp=0`.
- **T-3.4** Skirmish (first to N or time) and Duel (rounds, no respawn, storm wall closes after a 20 s hold).
- **T-3.5** Pooled instanced particles, beams and shield shells in `src/vfx`, capped per preset; storm wall
  view in `src/world/storm`.
- **T-3.6 / T-3.7** HUD: health, stamina, four ability slots, ultimate, reticle + hit marker, killfeed, score
  and timer, compass, status chips, respawn panel, damage arcs, low-health vignette, scoreboard (Tab,
  rebindable), results panel.
- **T-3.8** WebAudio engine with voice cap and panning; every sound is synthesised placeholder (DECISIONS 35).
- **T-3.9** Settings panel (Video, Controls, Audio, Game & Network): preset, dynamic resolution, frame cap,
  FOV, shake, sensitivity, invert Y, rebinding, volumes, UI scale. Saved in `localStorage`.
- **T-3.10** Bot pilots (Easy / Normal / Hard) fill seats from the lobby and fly inside the host sim.
- 1732 tests in 85 files; typecheck, test, build pass. Two reviews raised 12 findings: 11 fixed, bandwidth
  partly (DECISIONS 24-26).
- **Measured in headless Edge on the dev desktop, 5v5 bot Skirmish, 62 s per preset (not the U-series target):**

  | | Low | Medium | High | Budget (L / M / H) |
  | --- | --- | --- | --- | --- |
  | Draw calls, max | 27 | 28 | 28 | 120 / 180 / 350 |
  | Triangles, max | 21.5k | 19.8k | 25.4k | 250k / 450k / 1.2M |
  | Particles, peak | 176 | 254 | 406 | 600 / 1200 / 3000 |
  | Audio voices, peak | 14 | 13 | 15 | 16 / 24 / 32 |
  | Host tick in worker, ms | 0.052 | 0.080 | 0.066 | 1.5 |
  | KB/s per client | 6.20 | 6.46 | 6.31 | about 7 |

  Phase 2 figures for comparison: 20 draw calls on Medium, host tick 0.025 ms, 5.7 KB/s (flight only).
- Build: entry 550 kB (180 gzip), three 544 kB, host worker 435 kB, audio 30 kB and settings 18 kB lazy.
- New dev flags: `?autopilot=bot`, `?mode=`, `?score=`, `?time=`, `?teamsize=`, `?botlevel=`, `?fill`,
  `?lagcomp=0`, `?join=CODE`.
- **Phase 3 gate for the user (two real laptops):**
  1. Host: `npm run dev:lan` and `npm run peer:lan`, open `http://<ip>:5173/?lan&perf`, Host a room; the
     second laptop joins by code.
  2. Duel 1v1 to three round wins: 3-2-1, round pips, storm wall closing after 20 s, results, lobby.
  3. Skirmish 2v2 with "Fill with bots": killfeed, score, respawn count, Tab scoreboard, damage arcs point at
     the attacker.
  4. Each class: all four abilities read clearly; Talon dash hits once; a veiled enemy Wraith is fully hidden
     until it attacks; a phase dive that ends in rock pops you out.
  5. Client with `&netsim=bad`: own shots appear at once and hits feel fair.
  6. 60 fps on the U-series host with `?perf`; set a 30 fps cap and check the scale does not drop.
- **Not verified:** anything on real hardware; real pointer lock (headless Edge refuses it, so mouse aim ran
  with a simulated lock); nobody has listened to the audio; the storm wall has not been seen up close in a
  match; veil/phase translucency has no screenshot; spectator HUD and mid-match reconnect in a browser.
- **Open issues:** Talon looks weak 1v1 against Bastion (hard bots, 0-3); bots fly straight during round end
  and results; compass labels overlap when markers bunch; the debug GUI combat tables do not reach a worker
  host (use `?noworker`); rewind assumes a 100 ms interpolation delay instead of the client's real one; Duel
  storm fractions barely show on the greybox map (DECISIONS 34).
- **Repair:** `docs/TASKS.md` was committed empty in `d6bba62` by mistake. It is restored from `d41c844` with
  Phases 2 and 3 ticked.

### 2026-11-11: Phase 2 netcode core (T-2.1 to T-2.10)
- Full flow works: title → Host / Join by room code / Fly solo → lobby → match → back to lobby or title.
- **T-2.1** Transport abstraction with PeerJS and in-memory loopback implementations. Spike answers: PeerJS has
  no truly unreliable channel, so `fast` is our own negotiated channel (DECISIONS 19); plain-HTTP LAN works
  (DECISIONS 20).
- **T-2.2** Binary codec: defensive decode, 10-dragon snapshot inside the 360 B budget, fuzz-tested.
- **T-2.3** `HostSession` / `ClientSession`: handshake, lobby broadcast, reconnect token (30 s slot), kick ban.
- **T-2.4** 20 Hz snapshots, adaptive interpolation buffer, client prediction + reconciliation with smoothing.
- **T-2.5** `?netsim=<profile>` (off/lan/wifi/bad/awful or `ms,±ms,loss%`) and `?bots=N` net-bots
  (`&autostart` to host, fill and start at once).
- **T-2.6** Pure lobby state machine: teams 1-5, uneven toggle, move/auto-balance/shuffle/lock, class, ready,
  kick, start rules.
- **T-2.7 to T-2.9** Title, Host/Join, 2D lobby panel, connection chip, pause menu (host: End match / Close
  room), disconnect and host-left screens.
- **T-2.10** Host sim + snapshot encoding run in a Web Worker by default, main-thread fallback with `?noworker`
  (DECISIONS 21).
- 1206 tests in 60 files; typecheck, test, build pass. Two reviews raised 8 findings, all fixed.
- **Measured in headless Edge on the dev desktop (relative figures, not the U-series target):**
  - Host with 9 bots: 0.025 ms per tick in the worker; 0.02 ms of host work per frame on the main thread
    (0.13 ms with `?noworker`); 5.7 KB/s upload per client (budget 7).
  - Client under `netsim=bad`: remote position error mean 0.03 m, max 0.10 m; own dragon 0 corrections.
  - Draw calls and triangles unchanged from Phase 1 (no visual work in this phase).
- **Phase 2 gate for the user (two real laptops on Wi-Fi):** host runs `npm run dev:lan` and `npm run peer:lan`,
  opens `http://<ip>:5173/?lan&bots=8&perf`, picks Local network → Host a room; the second laptop opens
  `http://<host-ip>:5173/?lan&perf&netsim=bad` and joins by code. Fly a few minutes: no rubber-banding, own
  dragon never snaps. Also try: client tab hidden 20 s, Wi-Fi off 5 s, F5 on the client, kick, host End match.
- **Open questions (defaults chosen, change on request):** a hidden client's dragon flies straight on its last
  input; a hidden main-thread host freezes the sim (worker path does not); Close room has no confirm step.

### 2026-11-10: Phase 1 flight sandbox (T-1.1 to T-1.9)
- The app now boots straight into a flyable sandbox on the greybox Shattered Spires map ("click to fly").
- **T-1.1** Arcade flight model in `src/sim/flight.ts`: energy trade, stall, boost/stamina, flap, dive, barrel-roll
  dodge. Every number is in `FLIGHT_TUNING` (live-editable under `?debug` → Flight). Deterministic.
- **T-1.2** `src/input`: pointer-lock mouse reticle + keyboard → `InputFrame`, serialisable rebind table, keys
  cleared on blur.
- **T-1.3** `ChaseCamera`: frame-rate independent follow, bank lag, speed FOV, boost shake, terrain pull-in, held
  above the cloud sea.
- **T-1.4 / T-1.5** Gradient sky shader + sun + hemisphere + exp² fog matched to the horizon; opaque cloud-sea
  shader; instanced cloud puffs (1/2/3 layers per preset, billboarded in the vertex shader).
- **T-1.6** Greybox map as pure data in `src/shared/maps` (seeded, mirror-symmetric, spawn gates, storm wall);
  rendered as merged 500 m chunks with one material and baked vertex AO.
- **T-1.7** BVH terrain collision (swept sphere, bounce, speed-scaled damage, re-hit grace) and storm wall,
  floor and ceiling. Uses the same triangles as the renderer (DECISIONS 17, 18).
- **T-1.8** Placeholder dragons: one pooled instanced mesh, wings animated in the vertex shader, team colour on
  the membranes.
- **T-1.9** 576 tests in 29 files (no NaN under adversarial input, bounded speed/stamina, determinism, no
  tunnelling, launch from every gate slot, input → sim → camera axis chain). typecheck, test, build pass.
- Dev aids: `?autopilot` (scripted pilot), `?skip=<seconds>` (fast-forward at load).
- Built by six parallel agents, integrated, then two independent reviews; 4 findings, all fixed (outer spawn
  slots hit the gate arch; dragons could sink below all terrain; cloud sea hid the dragon from the camera; far
  chunks popped in on Low/Medium).
- **Perf HUD (headless Edge on the dev machine, so draw calls and triangles only; fps there is meaningless):**

  | | Phase 0 scene | Low | Medium | High | Medium budget |
  | --- | --- | --- | --- | --- | --- |
  | Draw calls | 1 | 19 | 20 | 21 | ≤ 180 |
  | Triangles | 20 | 5,509 | 5,813 | 6,125 | ≤ 450k |

  Sim cost with 10 dragons and collision is far below 1 ms per tick in the tests. **fps on a U-series laptop is
  still unmeasured: that is the gate.**
- **Known rough edges (not blocking the gate):**
  - Flight feel is untested by a human; expect a tuning pass.
  - A head-on bounce flips the heading 180° and the camera swings with it.
  - Lethal impact speed is 85 m/s while Talon can reach about 104 m/s on boost; check it feels fair.
  - No sun shadows on any preset yet (Medium "dragons only" and High shadows come with real assets, T-4.6).
  - Changing the preset live recompiles sky and sea shaders with a short hitch (loading screen is T-5.6).
  - Shadowed rock faces go near-black; edges are aliased at 0.7 to 0.85 render scale until the FXAA pass (T-4.7).
  - Open tuning questions: hard floor/ceiling depth (40 m), whether the cloud sea should throw a diving dragon
    back out, gate arch width (96 m).

### 2026-11-10: Phase 0 scaffold (T-0.1 to T-0.6)
- **T-0.1** `vite.config.ts` (three in its own chunk, `base: './'`, Basis/KTX2 transcoder copied to the git-ignored
  `public/vendor/basis/`; the meshopt decoder is an ES module and is imported, not copied), `index.html`,
  `src/style.css`, `src/main.ts` boot.
- **T-0.2** `src/shared` contracts: constants, `InputFrame`, `WorldView`, `GameEvents` + pooled event bus,
  `UiState`/`UiIntent`, lobby and match types, `QUALITY_PRESETS` (matches the PERFORMANCE.md table), manifests,
  classes, tuning stubs. No three.js or DOM imports.
- **T-0.3** `FixedStepLoop` (30 Hz accumulator, catch-up clamp, alpha), sim skeleton with prev/current state,
  `App` state machine (title/lobby/match/results), rAF `FrameDriver` that resets on tab hide.
- **T-0.4** `createGameRenderer` (one WebGL2 renderer, no MSAA, context-loss handling, render scale relative to
  1080p) and `DynamicResolution` (EMA + hysteresis, 0.05 steps, upward probing because vsync hides headroom,
  adapts to displays slower than 60 Hz).
- **T-0.5** `?perf` HUD (stats-gl + fps / frame ms avg, 1 % low, max / draw calls / triangles / geometries /
  textures / heap / render scale / sim ms, text at 4 Hz) and `?debug` lil-gui panel. Both load by dynamic import;
  the entry chunk is 16 kB and contains neither.
- **T-0.6** Vitest: 169 tests in 11 files (loop stability and determinism, scaler, contracts, App transitions,
  and an allow-list boundary test enforcing golden rule 3). `npm run typecheck`, `npm test`, `npm run build` pass.
- Also: `?quality=low|medium|high` override; the stored preset is read from `localStorage['dragonfall.settings']`
  (nothing writes it until T-3.9).
- Built by five parallel agents, then three independent reviews; all 10 findings were fixed or part-fixed.
- **Perf HUD:** no "before" (first runnable build). Only checked in headless Edge on the dev machine (scene, HUD
  and debug panel render, console clean, 1 draw call, 20 triangles); headless timings mean nothing. **Real
  numbers come from the user's gate check on a U-series laptop.**
- **Follow-ups decided (DECISIONS 14-16):** dragon flags widened to `u16`; ASSET_PIPELINE.md map budget corrected
  to 450k / 300 MB; no automatic refresh-rate re-test (Settings will call the scaler's `reset()`, T-3.9).
- **Still open:** `three-mesh-bvh` needs `BufferGeometry`, which the sim boundary test rejects (math-only three
  imports). Settle in T-1.7.

### 2026-11-10: setup finished
- Planning docs, config, folder skeleton, git + LFS on `main`. No game code yet.
- Laptops confirmed U-series, so the budgets in PERFORMANCE.md are tight and the host sim is planned for a Web
  Worker (T-2.10).
- Installed ffmpeg 9.0.2 + KTX-Software 4.4.2; npm dependencies installed.
- Reference video reviewed (differences in ART_DIRECTION.md), then deleted.
- Switched to Claude-only development: the Cursor worktree, rules and lane files are removed.
