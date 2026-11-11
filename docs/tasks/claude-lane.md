# Claude lane tasks

Status: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked (say why in the handoff file).
Only Claude edits this file. "Needs" lists what must exist first.

## Phase 0: Scaffold (solo; Cursor waits)
- [ ] A-01 `npm install`, `vite.config.ts` (meshopt/KTX2 transcoder files copied to `public/`), `index.html`, `src/main.ts`
- [ ] A-02 `src/shared` contracts: `InputFrame`, `WorldView`, `GameEvents`, `UiState`/`UiIntent`, `QualityPreset` table, manifests, constants, tuning tables
- [ ] A-03 Fixed 30 Hz sim loop + render interpolation alpha; App state machine skeleton (title/lobby/match/results)
- [ ] A-04 `src/dev`: perf HUD (`?perf`, stats-gl + renderer.info + heap), lil-gui (`?debug`)
- [ ] A-05 Minimal stub views so the app runs (single sky colour), to be replaced by Cursor lane modules
- [ ] A-06 Vitest set up with the first sim-loop tests; `npm run build` green; commit; tell user Phase 0 is ready

## Phase 1: Flight sandbox
- [ ] A-10 Flight model in `src/sim` (energy, stall, boost/stamina, flap, dive, roll-dodge) with tuning table (needs A-02)
- [ ] A-11 Terrain collision: BVH raycasts against map collider mesh, bounce + damage; storm wall bounds
- [ ] A-12 Greybox map collider + spawn gates in `MapManifest` (shapes only; Cursor renders them)
- [ ] A-13 Sim unit tests for flight (no NaNs, energy conservation within bounds, determinism for replay)

## Phase 2: Netcode core
- [ ] A-20 Spike: PeerJS host/join, confirm unreliable channel + LAN-over-HTTP behaviour; record result in DECISIONS
- [ ] A-21 `net/codec` binary protocol + tests (round-trip, quantization error bounds)
- [ ] A-22 `HostSession` / `ClientSession`, room codes, hello/welcome/reject, lobby state broadcast, reconnect token
- [ ] A-23 Snapshots 20 Hz, interpolation buffer, client prediction + reconciliation
- [ ] A-24 `dev/netsim` latency/jitter/loss + `?bots=N` net-bots
- [ ] A-25 Lobby logic: teams 1–5 per side, uneven toggle, move/auto-balance/shuffle/lock, class pick, ready, kick, start

## Phase 3: Combat + MVP modes
- [ ] A-30 Health, damage, takedowns, respawn + spawn protection, GameEvents
- [ ] A-31 Abilities for 4 classes (data-driven), projectiles, cones, beams
- [ ] A-32 Host lag compensation (position history, rewind ≤ 200 ms)
- [ ] A-33 Modes: Skirmish, Duel (rounds + shrinking storm wall); match clock + scoring
- [ ] A-34 Simple bot pilots (fly, chase, shoot) for testing and slot fill

## Phase 4: Art pass (generation needs user OK per batch)
- [ ] A-40 Style gate: user approves STYLE FORMULA; 3 mood-board images
- [ ] A-41 Install KTX-Software + ffmpeg (user approves); `tools/` wrappers for optimize + audio normalise
- [ ] A-42 Dragons ×4: concept → 3D → procedural rig + clips → LODs → optimize → manifest
- [ ] A-43 Shattered Spires: hero rocks, props, tileable textures, sky panorama → optimize → manifest
- [ ] A-44 Audio: SFX set, ambience, lobby + match music, stings → normalise → manifest

## Phase 5: Cinematics + lobby (logic side)
- [ ] A-50 Match phase timeline (intro → countdown → live → end → podium) driven by host, synced to clients
- [ ] A-51 Death cam data (killer id, last positions), MVP/stat calculation for podium

## Phase 6: Scale + content
- [ ] A-60 5v5 load tests (real laptops + bots), bandwidth + host CPU profiling; sim → Web Worker if needed
- [ ] A-61 Ember Relay mode; Emberfall Caldera map assets + colliders
- [ ] A-62 Reconnect within 30 s mid-match; spectators

## Phase 7: Ship
- [ ] A-70 Deploy to HTTPS static host; LAN mode (`peer:lan`) guide; README hosting guide
- [ ] A-71 Trailer from captures (Higgsfield video, user OK)
