# Progress log

Newest entries at the top. Claude updates this at the end of every task and session, so a fresh chat can pick
up where the last one stopped.

## Current state

- **Phase:** 1 (Flight sandbox) built, **waiting for the user's gate check** (flight feel + Medium at 60 fps on a
  U-series laptop). The Phase 0 gate has not been reported either; the same session can cover both.
- **Next:** T-2.1 (PeerJS spike) once the Phase 1 gate passes; tune flight from the user's feedback first.
- **Open issues:** see "Known rough edges" in the Phase 1 entry.

## Log

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
