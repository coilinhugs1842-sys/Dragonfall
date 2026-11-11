# Dragonfall — instructions for every AI agent (Claude Code + Cursor)

Dragonfall is a browser dragon-riding team battler: **1v1 up to 5v5**, built with **three.js + TypeScript + Vite**.
One player's browser is the **host** (authoritative simulation); everyone else connects to it peer-to-peer
over **WebRTC (PeerJS)**. It must run at a smooth 60 fps on **laptops with Intel Core Ultra 5 integrated
graphics and 16 GB RAM**, including the host laptop, which also plays.

Two agents build this in parallel, in two lanes (below). Read this file before every task.

## Read first

| Doc | What it is |
| --- | --- |
| `docs/GAME_DESIGN.md` | The game: flight, dragons, combat, modes, lobby, cinematics |
| `docs/ARCHITECTURE.md` | Module layout, data flow, the contracts between lanes |
| `docs/NETWORKING.md` | Host-authoritative P2P design, protocol, tick rates |
| `docs/PERFORMANCE.md` | Hardware target, budgets, quality presets, how to measure |
| `docs/ART_DIRECTION.md` | Visual style, the STYLE FORMULA, palette, lighting |
| `docs/ASSET_PIPELINE.md` | Higgsfield → Blender → gltf-transform → `public/assets` |
| `docs/ROADMAP.md` | Phases with exit criteria |
| `docs/tasks/claude-lane.md`, `docs/tasks/cursor-lane.md` | The task lists for each lane |
| `docs/WORKFLOW.md` | How the two agents and the human work at the same time |
| `docs/DECISIONS.md` | Decisions already made; don't relitigate without a new entry |

## Lanes and file ownership

Each lane owns directories. **Only edit files in your own lane.** If you need a change in the other lane,
write it in your handoff file (`docs/handoff/<lane>-lane.md`) under "Requests for the other lane".

| Path | Owner | Contents |
| --- | --- | --- |
| `src/shared/` | **Claude** | Contracts: types, message schemas, constants, math helpers. Both lanes import it. |
| `src/sim/` | **Claude** | Game simulation: flight model, combat, modes, rules. No three.js scene graph, no DOM. |
| `src/net/` | **Claude** | PeerJS transport, binary protocol, host/client sessions, snapshots, prediction. |
| `src/game/` | **Claude** | App state machine (title → lobby → match → results), glue between sim, net and views. |
| `src/dev/` | **Claude** | Perf HUD, debug GUI, benchmark flythrough, network simulator. |
| `src/main.ts`, `index.html`, `vite.config.ts` | **Claude** | Boot and build config. |
| `tools/`, `art-source/`, `public/assets/` | **Claude** | Asset pipeline scripts, raw generations, optimized runtime assets. |
| `src/render/` | **Cursor** | Renderer, quality presets, dynamic resolution, post, camera rig. |
| `src/world/` | **Cursor** | Map loading, islands/terrain, sky, clouds, sea, instanced props, LOD. |
| `src/dragons/` | **Cursor** | Dragon visuals: model loading, animation, team tint, nameplates. |
| `src/vfx/` | **Cursor** | Pooled particles, breath/impact/trail effects. |
| `src/cinematics/` | **Cursor** | Lobby aerie scene, camera splines, match intro/outro sequences. |
| `src/ui/` | **Cursor** | HTML/CSS overlay: menus, lobby panels, HUD, scoreboard, settings. |
| `src/input/` | **Cursor** | Keyboard/mouse/gamepad → `InputFrame`. |
| `src/audio/` | **Cursor** | WebAudio playback engine (Claude supplies the sound files). |
| `tests/` | both | Tests next to the lane they cover: `tests/sim`, `tests/net`, `tests/render`, ... |
| `docs/` | Claude (except your own handoff and lane task file) | |

Contracts in `src/shared/` are changed **only by Claude**. Cursor codes against them and asks for changes
via its handoff file.

## Golden rules

1. **Performance is a feature.** Stay inside the budgets in `docs/PERFORMANCE.md`. Every visual feature
   must have a Low/Medium/High behaviour and must be measurable with the perf HUD.
2. **No allocations in the frame loop.** Reuse vectors, matrices, arrays; use object pools. No
   `new THREE.Vector3()` inside `update()`/`render()`.
3. **Sim and render are separate.** `src/sim` and `src/net` never import from `src/render`, `src/world`,
   `src/dragons`, `src/vfx`, `src/ui`, or touch the DOM. Views only *read* sim state through the contracts in
   `src/shared`. (This keeps the sim cheap, testable, and movable to a Web Worker.)
4. **The host is the only authority.** Clients send inputs, never state. Anything that decides a hit, a kill,
   a score, or a team lives in `src/sim` and runs on the host.
5. **Original work only.** Our dragons, maps, names and UI are our own designs. Don't copy art, names, level
   layouts or UI from any existing game, including the Higgsfield dragon game that inspired this project.
6. **Every asset goes through the pipeline** in `docs/ASSET_PIPELINE.md` and stays inside its budget.
   Never drop a raw generated GLB or PNG into `public/assets/`.
7. **TypeScript strict.** No `any` unless commented why. Small modules, named exports, no default exports.

## Commands

```
npm install          # once per folder (each worktree has its own node_modules)
npm run dev          # dev server (Vite picks the next free port if 5173 is taken)
npm run dev:lan      # dev server reachable from other laptops on the network
npm run typecheck
npm test
npm run build
npm run peer:lan     # optional self-hosted PeerJS signaling server for offline LAN play
```

## Definition of done (every task)

- `npm run typecheck` and `npm test` pass; `npm run build` passes if you touched build config.
- No new console errors or warnings in the browser.
- If the task is visual or touches the frame loop: note the perf HUD numbers (fps, draw calls, triangles,
  frame ms) before and after in your handoff file.
- Mark the task done in your lane's task file, add a short entry to your handoff file, then commit
  **on your own branch** with a message like `cursor: terrain chunk LOD (C-07)` or `claude: snapshot
  interpolation (A-12)`.
- Never commit to the other lane's branch, never rewrite history (`push --force`, `rebase` of shared
  commits), never merge into `main` unless you are Claude doing an integration merge.
