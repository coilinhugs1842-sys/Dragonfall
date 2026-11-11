# Architecture

## Stack

| Concern | Choice |
| --- | --- |
| Language / build | TypeScript (strict) + Vite |
| 3D | three.js `WebGLRenderer` (WebGL2). WebGPU is a later option, not the baseline (see DECISIONS) |
| Networking | WebRTC data channels through **PeerJS**: star topology, the host is authoritative |
| Physics | No engine. A custom arcade flight model, plus sphere/capsule hits and `three-mesh-bvh` for terrain raycasts |
| UI | Plain TS + HTML/CSS overlay |
| Audio | WebAudio |
| Dev tools | `stats-gl` (perf HUD), `lil-gui` (tuning), Vitest |
| Assets | GLB with meshopt compression + KTX2 textures, produced by the pipeline in `ASSET_PIPELINE.md` |

## Module map

```
src/
  main.ts            boot: create renderer, load settings, start the App state machine     [Claude]
  shared/            contracts used by both lanes (types, constants, tuning tables)         [Claude]
  sim/               pure game simulation, runs on the host; clients run it for prediction  [Claude]
  net/               transport, protocol codec, HostSession, ClientSession, snapshot buffer [Claude]
  game/              App state machine + scene orchestration, builds WorldView for the views [Claude]
  dev/               perf HUD, debug GUI, ?bench flythrough, latency/loss simulator          [Claude]
  render/            renderer, quality presets, dynamic resolution, post pass, camera rig    [Cursor]
  world/             map loader, islands, sky, clouds, cloud sea, instanced props, LOD       [Cursor]
  dragons/           dragon model + animation controller, team tint, nameplates             [Cursor]
  vfx/               pooled particles and effects driven by GameEvents                      [Cursor]
  cinematics/        aerie lobby scene, camera splines, intro / results sequences            [Cursor]
  ui/                menus, lobby panels, HUD, scoreboard, settings                         [Cursor]
  input/             devices → InputFrame                                                   [Cursor]
  audio/             WebAudio engine driven by GameEvents                                   [Cursor]
```

## Data flow

```
             ┌────────────── HOST browser ──────────────┐            ┌──── CLIENT browser ────┐
 input/ ──► InputFrame ──► sim/ (authoritative, 30 Hz) ──► Snapshot ──net──► SnapshotBuffer
                ▲              │                                         │   + local prediction
     net (client inputs) ──────┘                                         ▼
                               └──► GameEvents ──net (reliable)──► GameEvents
                                                                         │
 game/ builds WorldView (interpolated, read-only) ──► render/ world/ dragons/ vfx/ cinematics/
 game/ builds UiState                             ──► ui/   (ui sends UiIntent ──► game/)
```

The host runs the same views as a client: it renders its own authoritative state with zero network delay.

## Contracts (live in `src/shared/`, owned by Claude, defined in Phase 0)

These are the seams between the lanes. Cursor codes only against these.

- `InputFrame`: per-tick player input (steer vector, buttons bitmask, tick number).
- `WorldView`: read-only, already interpolated state for rendering. It has the list of dragons (id, team,
  class, position, orientation, velocity, health, flags, animation state), projectiles and zones, and the
  match clock. The views must not keep references to its arrays between frames.
- `GameEvents`: discrete events such as `hit`, `takedown`, `spawn`, `abilityCast`, `objective`,
  `matchPhase`. VFX, audio, UI and cinematics subscribe to these.
- `UiState` / `UiIntent`: everything menus and HUD show, and every action they can request
  (`lobby.ready`, `host.setTeamSize`, `host.movePlayer`, `host.start`, ...).
- `QualityPreset`: `low | medium | high` plus the derived numbers (shadow size, particle cap, render-scale
  bounds, post effects).
- `MapManifest` / `DragonManifest`: which assets to load and their gameplay metadata (spawn gates,
  colliders, bone names for wings and tail).

## Timing

- **Sim tick:** fixed 30 Hz (`TICK_MS = 33.33`) with an accumulator. Rendering runs at display rate and
  interpolates between sim states.
- **Network:** clients send inputs every tick and the host sends snapshots at 20 Hz (see `NETWORKING.md`).
- The sim is pure TypeScript with no three.js scene objects, so in Phase 6 it can move into a Web Worker on
  the host if profiling shows it's needed.

## Scenes and memory

Scenes: Title (light), Aerie lobby, Match (map), Results (reuses the match map). Moving between them disposes
whatever the next scene doesn't need. Shared assets such as dragons and VFX textures stay cached. The app keeps
one `WebGLRenderer` for its whole life.
