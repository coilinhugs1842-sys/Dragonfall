# Tasks

Status: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked (say why in `PROGRESS.md`).
Ids are `T-<phase>.<n>`. Work top to bottom unless the user says otherwise. Each phase ends with its gate in
`ROADMAP.md`.

## Phase 0: Scaffold
- [x] T-0.1 `vite.config.ts` (copy meshopt decoder + KTX2 transcoder files to `public/`), `index.html`, `src/main.ts`. (`npm install` already done)
- [x] T-0.2 `src/shared` contracts: `InputFrame`, `WorldView`, `GameEvents`, `UiState`/`UiIntent`, `QualityPreset` table, manifests, constants, tuning tables
- [x] T-0.3 Fixed 30 Hz sim loop + render interpolation alpha; App state machine skeleton (title/lobby/match/results)
- [x] T-0.4 `src/render` base: WebGL2 renderer, quality presets, dynamic resolution scaler
- [x] T-0.5 `src/dev`: perf HUD (`?perf`: stats-gl + renderer.info + heap), lil-gui (`?debug`)
- [x] T-0.6 Vitest setup + first sim-loop tests; `npm run build` green; tell the user what to check for the Phase 0 gate

## Phase 1: Flight sandbox
- [x] T-1.1 Flight model in `src/sim` (energy, stall, boost/stamina, flap, dive, roll-dodge) with a tuning table
- [x] T-1.2 `src/input`: keyboard/mouse with pointer lock → `InputFrame`, rebind table
- [x] T-1.3 Chase camera rig: speed-based FOV, banking lag, collision-free offset, subtle boost shake
- [x] T-1.4 Sky: gradient sky shader + sun + fog per the ART_DIRECTION lighting recipe
- [x] T-1.5 Cloud sea shader + instanced cloud billboards (layers per preset, overdraw-capped)
- [x] T-1.6 Greybox map: collider + spawn gates in `MapManifest`; chunked merged meshes for rendering
- [x] T-1.7 Terrain collision: BVH raycasts, bounce + damage; storm wall bounds
- [x] T-1.8 Placeholder dragon (primitive body + flapping wing quads) driven by `WorldView`
- [x] T-1.9 Flight sim tests (no NaNs, bounded energy, determinism for replay); perf check on Medium

## Phase 2: Netcode core
- [x] T-2.1 Spike: PeerJS host/join; confirm unreliable channel + LAN-over-HTTP behaviour → DECISIONS
- [x] T-2.2 `net/codec` binary protocol + tests (round-trip, quantization error bounds)
- [x] T-2.3 `HostSession` / `ClientSession`, room codes, hello/welcome/reject, lobby state broadcast, reconnect token
- [x] T-2.4 Snapshots 20 Hz, interpolation buffer, client prediction + reconciliation
- [x] T-2.5 `dev/netsim` latency/jitter/loss + `?bots=N` net-bots
- [x] T-2.6 Lobby logic: teams 1–5 per side, uneven toggle, move/auto-balance/shuffle/lock, class pick, ready, kick, start
- [x] T-2.7 Title screen + Host / Join (room code entry, name, errors)
- [x] T-2.8 Temporary 2D lobby panel: team columns, class picker, ready, host-only controls
- [x] T-2.9 Connection status / ping; disconnect + host-left screens
- [x] T-2.10 Measure host main-thread cost on U-series with `?bots=9`; move host sim + snapshot encoding to a Web Worker → DECISIONS

## Phase 3: Combat + MVP modes
- [x] T-3.1 Health, damage, takedowns, respawn + spawn protection, GameEvents
- [x] T-3.2 Abilities for 4 classes (data-driven): projectiles, cones, beams
- [x] T-3.3 Host lag compensation (position history, rewind ≤ 200 ms)
- [x] T-3.4 Modes: Skirmish, Duel (rounds + shrinking storm wall); match clock + scoring
- [x] T-3.5 Pooled instanced particle system with per-preset caps; breath/ability/impact effects
- [x] T-3.6 HUD: health, stamina, cooldowns, ultimate, reticle + hit marker, killfeed, score/timer, teammate compass
- [x] T-3.7 Scoreboard (Tab), damage direction indicator, low-health vignette
- [x] T-3.8 WebAudio engine: voice cap, panning, event → sound table (placeholder sounds)
- [x] T-3.9 Settings menu: quality, render scale, FOV, sensitivity, invert Y, rebinding, volume
- [x] T-3.10 Simple bot pilots (fly, chase, shoot) for testing and slot fill

## Phase 4: Art pass (each generation batch needs the user's OK)
- [!] T-4.1 Style gate: user approves the STYLE FORMULA; 3 mood-board images. *Blocked: the free Higgsfield plan refuses or fails every image job (DECISIONS 39). The formula is in use as drafted (DECISIONS 37).*
- [x] T-4.2 `tools/` wrappers: optimize (gltf-transform + KTX2), audio normalise (ffmpeg)
- [x] T-4.3 Dragons ×4: concept → 3D → procedural rig + clips → LODs → optimize → manifest *(procedural, DECISIONS 36)*
- [x] T-4.4 Dragon loader: GLB LODs + KTX2 + meshopt, animation blending, team tint on membrane/runes
- [x] T-4.5 Shattered Spires: hero rocks, props, tileable textures, sky panorama → optimize → manifest *(procedural; the sky is the shader, no panorama)*
- [x] T-4.6 Map renderer with real assets: instancing, LOD, chunk culling, vertex AO, light shafts
- [x] T-4.7 Post pass per preset (combined FXAA + grade + vignette + sharpen; half-res bloom on High)
- [x] T-4.8 Audio: SFX, ambience, lobby + match music, stings → normalise → wire up *(synthesised offline)*
- [~] T-4.9 Perf pass with real assets on U-series: hit the budgets; record `?bench`. *`?bench` is built and recorded on the dev desktop, inside every budget. The U-series run is the user's gate.*

## Phase 5: Cinematics + lobby
- [ ] T-5.1 Host-driven match phase timeline (intro → countdown → live → end → podium), synced to clients
- [ ] T-5.2 Aerie lobby scene: two terraces × 5 perches, landing/ready animations, nameplates, camera drift + close-ups
- [ ] T-5.3 Host panel in the aerie (mode, map, team size, uneven, limits, friendly fire, classes, assign/balance/shuffle/lock, kick, start)
- [ ] T-5.4 Match intro: map flyby, title card, team gate reveal, countdown
- [ ] T-5.5 Death cam orbit; results podium + formation pass; MVP stats
- [ ] T-5.6 Scene transitions with proper dispose; loading screen with shader precompile

## Phase 6: Scale + content
- [ ] T-6.1 5v5 load tests (real laptops + bots) after a 10-min warm-up on the U-series host
- [ ] T-6.2 Auto quality pick (3 s test flight) + GPU name logging
- [ ] T-6.3 Ember Relay mode
- [ ] T-6.4 Emberfall Caldera map (assets, colliders, visuals)
- [ ] T-6.5 Reconnect within 30 s mid-match; spectators
- [ ] T-6.6 Gamepad support; accessibility (colour-blind check, UI scale)

## Phase 7: Ship
- [ ] T-7.1 GitHub: check LFS usage vs quota, push; GitHub Actions → Pages deploy (checkout with `lfs: true`)
- [ ] T-7.2 LAN mode (`peer:lan`) guide; README hosting guide
- [ ] T-7.3 Final perf pass with the weakest laptop as host
- [ ] T-7.4 Trailer from captures (Higgsfield video, user OK)
