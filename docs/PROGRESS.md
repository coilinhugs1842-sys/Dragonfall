# Progress log

Newest entries at the top. Claude updates this at the end of every task and session, so a fresh chat can pick
up where the last one stopped.

## Current state

- **Phase:** 0 (Scaffold) built, **waiting for the user's gate check** on a U-series laptop.
- **Next:** T-1.1 (flight model) once the Phase 0 gate passes.
- **Open issues:** see "Open questions" in the 2026-11-10 Phase 0 entry.

## Log

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
- **Open questions for the user:**
  1. Dragon flags use all 8 bits of the `u8` in NETWORKING.md. Drop `IN_STORM` (clients can derive it) or widen
     to `u16`? Decide before the codec (T-2.2).
  2. ASSET_PIPELINE.md "Map total" says 800k triangles / 400 MB VRAM at Medium; PERFORMANCE.md says 450k / 300 MB.
     The code follows PERFORMANCE.md. Correct ASSET_PIPELINE.md?
  3. Dynamic resolution: if the display refresh rate drops mid-session (60 to 48 Hz on unplugging) the scale can
     stay pinned at minimum. A fix needs a periodic re-test or a manual "re-detect" hook.
  4. `three-mesh-bvh` needs `BufferGeometry`, which the sim boundary test rejects (math-only three imports).
     Settle in T-1.7.

### 2026-11-10: setup finished
- Planning docs, config, folder skeleton, git + LFS on `main`. No game code yet.
- Laptops confirmed U-series, so the budgets in PERFORMANCE.md are tight and the host sim is planned for a Web
  Worker (T-2.10).
- Installed ffmpeg 9.0.2 + KTX-Software 4.4.2; npm dependencies installed.
- Reference video reviewed (differences in ART_DIRECTION.md), then deleted.
- Switched to Claude-only development: the Cursor worktree, rules and lane files are removed.
