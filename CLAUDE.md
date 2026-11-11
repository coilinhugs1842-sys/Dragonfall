# Dragonfall: instructions for Claude Code

Dragonfall is a browser dragon-riding team battler: **1v1 up to 5v5**, built with **three.js + TypeScript + Vite**.
One player's browser is the **host** and runs the authoritative simulation. Everyone else connects to it
peer-to-peer over **WebRTC (PeerJS)**. It must run at a smooth 60 fps on **U-series Intel Core Ultra 5 laptops
(integrated graphics, 16 GB RAM)**, including the host laptop, which also plays.

Claude Code builds the whole thing. The user drives the work, playtests, and approves art and Higgsfield spending.

## Start of every session

1. Read `docs/PROGRESS.md`: where we are and what's next. Chats get restarted, so this file is the memory.
2. Read `docs/TASKS.md` and continue with the first task that isn't done, unless the user asks for something else.
3. Before writing code for a system, read its design doc (below).

## Docs

| Doc | What it is |
| --- | --- |
| `docs/GAME_DESIGN.md` | The game: flight, dragons, combat, modes, lobby, cinematics |
| `docs/ARCHITECTURE.md` | Module layout, data flow, contracts between modules |
| `docs/NETWORKING.md` | Host-authoritative P2P design, protocol, tick rates |
| `docs/PERFORMANCE.md` | U-series hardware target, budgets, quality presets, how to measure |
| `docs/ART_DIRECTION.md` | Visual style, STYLE FORMULA, palette, lighting, how we differ from the reference game |
| `docs/ASSET_PIPELINE.md` | Higgsfield → Blender → gltf-transform → `public/assets` |
| `docs/ROADMAP.md` | Phases with gates |
| `docs/TASKS.md` | The task list |
| `docs/PROGRESS.md` | Session log: what was done, what's next, open issues |
| `docs/DECISIONS.md` | Decisions already made; add an entry instead of silently reversing one |
| `docs/WORKFLOW.md` | How the user works with Claude on this project (for the user) |

## Golden rules

1. **Performance is a feature.** Stay inside the budgets in `docs/PERFORMANCE.md`. Every visual feature has a
   Low/Medium/High behaviour and is measurable with the perf HUD. When in doubt, choose the cheaper technique.
2. **No allocations in the frame loop.** Reuse vectors, matrices and arrays; use object pools. Never write
   `new THREE.Vector3()` inside `update()`/`render()`.
3. **Sim and render are separate.** `src/sim` and `src/net` never import from view modules (`render`, `world`,
   `dragons`, `vfx`, `cinematics`, `ui`, `audio`) and never touch the DOM. Views read state only through the
   contracts in `src/shared`. This keeps the sim cheap, testable, and runnable in a Web Worker.
4. **The host is the only authority.** Clients send inputs, never state.
5. **Original work only.** Our dragons, maps, names and UI are our own designs. Don't copy art, names, layouts or
   UI from any existing game, including the Higgsfield dragon game that inspired this (see `ART_DIRECTION.md`,
   "How we differ").
6. **Every asset goes through the pipeline** in `docs/ASSET_PIPELINE.md` and stays inside its budget. Never put a
   raw generated GLB or PNG into `public/assets/`.
7. **TypeScript strict.** No `any` unless commented why. Small modules, named exports, no default exports.

## Commands

```
npm run dev          # dev server
npm run dev:lan      # dev server reachable from other laptops on the network
npm run typecheck
npm test
npm run build
npm run peer:lan     # optional self-hosted PeerJS signaling server for offline LAN play
```

## Definition of done (every task)

- `npm run typecheck` and `npm test` pass; `npm run build` passes if build config or assets changed.
- No new console errors or warnings in the browser.
- Visual or frame-loop changes: record the perf HUD numbers before and after in `docs/PROGRESS.md`.
- Tick the task in `docs/TASKS.md`, add a short entry to `docs/PROGRESS.md`, and commit on `main` with a message
  like `snapshot interpolation (T-2.4)`.
- When a phase ends, tell the user exactly what to test for its gate (`docs/ROADMAP.md`).

## Assets and tools

- Use the Higgsfield skills (`higgsfield-generate`, plus the game references in `higgsfield-websites` for 3D,
  textures, stylization and audio). Every generation prompt embeds the approved STYLE FORMULA from
  `docs/ART_DIRECTION.md` byte-for-byte. Log every job in `art-source/LOG.md`.
- **Higgsfield jobs cost credits:** propose each batch and get the user's OK before running it.
- Blender: `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe` (not on PATH). KTX-Software is in
  `C:\Program Files\KTX-Software\bin`, and ffmpeg was installed via winget. Both are on PATH in new shells.

## Git and GitHub

- Work on `main`, and commit at the end of each task. The repo will be pushed to GitHub. Never commit secrets or
  third-party reference footage (`/reference/` is git-ignored). Binary assets go through Git LFS.
