# Cursor lane tasks

Status: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked (say why in `docs/handoff/cursor-lane.md`).
Only Cursor edits this file. "Needs" lists Claude-lane tasks that must be merged first: run `git merge main`
after the user tells you they landed.

## Phase 0
Wait. Claude builds the scaffold and contracts (A-01…A-06). Start Phase 1 after the user says "sync with main".

## Phase 1: Flight sandbox
- [ ] C-01 `src/render`: renderer setup, quality preset application, dynamic resolution scaler (needs A-02, A-04)
- [ ] C-02 Third-person chase camera rig: speed-based FOV, banking lag, collision-free offset, subtle shake on boost
- [ ] C-03 `src/input`: keyboard/mouse with pointer lock → `InputFrame`, rebind table (needs A-02)
- [ ] C-04 Sky: gradient sky shader + sun + fog matching ART_DIRECTION lighting recipe
- [ ] C-05 Cloud sea shader + instanced cloud billboards (layers per preset, overdraw-capped)
- [ ] C-06 Greybox map rendering from `MapManifest` (A-12): chunked merged meshes, simple painterly-ish material
- [ ] C-07 Placeholder dragon (primitive body + flapping wing quads) driven by `WorldView` + anim state

## Phase 2: Netcode core (UI side)
- [ ] C-10 Title screen + Host / Join (room code entry, name, errors) using `UiState`/`UiIntent`
- [ ] C-11 2D lobby panel (temporary until Phase 5 aerie): team columns, class picker, ready, host-only controls
- [ ] C-12 Connection status / ping indicator; disconnect + host-left screens
- [ ] C-13 Settings menu: quality preset, render scale, FOV, sensitivity, invert Y, key rebinding, volume

## Phase 3: Combat feedback
- [ ] C-20 `src/vfx`: pooled instanced particle system with per-preset caps
- [ ] C-21 Breath/ability effects for 4 classes, impacts, shield, veil (driven by `GameEvents`)
- [ ] C-22 HUD: health, stamina, cooldowns, ultimate charge, reticle + hit marker, killfeed, score/timer, teammate compass
- [ ] C-23 Scoreboard (Tab), damage direction indicator, low-health vignette (cheap)
- [ ] C-24 `src/audio`: WebAudio engine, voice cap, positional panning, event→sound table

## Phase 4: Art integration
- [ ] C-30 Dragon loader: GLB LODs + KTX2 + meshopt, animation blending (glide/flap/boost/dive/bank), team tint on membrane/runes
- [ ] C-31 Map renderer with real assets: instanced rocks/props, LOD, chunk culling, vertex AO, light shafts
- [ ] C-32 Post pass per preset (combined FXAA + grade + vignette; half-res bloom on High)
- [ ] C-33 Perf pass with real assets: hit the PERFORMANCE.md budgets on Medium and Low, record `?bench` numbers

## Phase 5: Cinematics + lobby
- [ ] C-40 Aerie lobby scene: two terraces × 5 perches, landing/ready animations, nameplates, camera spline drift + close-ups
- [ ] C-41 Host panel inside the aerie UI (mode, map, team size, uneven, limits, friendly fire, classes, assign/balance/shuffle/lock, kick, start)
- [ ] C-42 Match intro: map flyby spline, title card, team gate reveal, countdown (driven by A-50)
- [ ] C-43 Death cam orbit; results podium + formation pass
- [ ] C-44 Scene transitions with proper dispose; loading screen with shader precompile

## Phase 6–7
- [ ] C-50 Auto quality pick (3 s test flight) + GPU name logging
- [ ] C-51 Emberfall Caldera visuals (heat shimmer cheap, lava glow), Ember Relay objective visuals
- [ ] C-52 Gamepad support; accessibility (colour-blind check, UI scale)
- [ ] C-53 Final perf pass on the weakest laptop as host
