# Performance: Intel Core Ultra 5 integrated graphics, 16 GB

## The target machine

- **CPU/GPU: confirmed U-series** (Core Ultra 5 1xxU/2xxU). That means 15 W chips with **Intel Graphics, 4 Xe
  cores**, about half the GPU of the H-series' Arc graphics. The CPU has only 2 performance cores, and these
  laptops **throttle under sustained load** once they heat up. Everything below is sized for this machine.
  **Medium is the default preset and must hold 60 fps on a U-series laptop.** High is a bonus for stronger
  machines.
- **Memory:** 16 GB shared between the CPU and GPU. Chrome or Edge, Windows and a background app or two leave
  roughly 2–3 GB that a game tab can use comfortably.
- **Browser:** current Chrome or Edge with hardware acceleration on, using WebGL2.
- **The host laptop does more:** it runs the sim for 10 dragons and keeps 9 WebRTC connections alive while
  rendering. The host's sim + net budget is below.

> Every phase gate runs on a U-series laptop. If a laptop has an even weaker chip, that one becomes the gate
> machine.

## Frame budget (60 fps = 16.7 ms)

| Item | Budget |
| --- | --- |
| Sim + net on the host (30 Hz work, averaged per frame) | ≤ 1.5 ms (or moved to a worker, see below) |
| Sim + net on a client (prediction + interpolation) | ≤ 0.8 ms |
| JS render prep (culling, animation, matrices, particles) | ≤ 3.0 ms |
| GPU time | ≤ 11 ms at Medium on a U-series laptop |
| Garbage collection | no visible stalls; zero per-frame allocations in the hot path |

## Scene budgets per quality preset

| Budget | Low | Medium (default, U-series target) | High (stronger PCs) |
| --- | --- | --- | --- |
| Render scale (dynamic, of 1080p) | 0.5–0.7 | 0.6–0.85 | 0.85–1.0 |
| Draw calls | ≤ 120 | ≤ 180 | ≤ 350 |
| Triangles on screen | ≤ 250k | ≤ 450k | ≤ 1.2M |
| Shadow map (sun, near cascade only) | none (blob shadows) | none for world, 1024 for dragons only | 2048 |
| Post-processing | none (tone-map in material) | one combined pass: FXAA + colour grade + vignette | + half-res bloom |
| Max particles alive | 600 | 1,200 | 3,000 |
| Dragon LOD distances (LOD0/LOD1/LOD2) | 25/70/200 m | 40/120/320 m | 80/220/600 m |
| Prop draw distance | 500 m | 800 m | 1,500 m |
| Cloud billboard layers | 1 | 2 | 3 |
| Max texture size (mips skipped below this) | 512² | 1024² | 2048² |
| Texture VRAM (KTX2) | ≤ 180 MB | ≤ 300 MB | ≤ 600 MB |
| Audio voices | 16 | 24 | 32 |

The upscale from a reduced render scale must look intentional. Use the FXAA pass and a light sharpen in the
combined post pass, and render the UI at full resolution as HTML, so text stays crisp at any render scale.

**Never in gameplay:** SSAO, SSR, real-time depth of field, more than one shadow-casting light, dynamic point
lights, full-resolution bloom, or a transparent full-screen effect stacked on another.

## Techniques we rely on

- **Dynamic resolution.** The renderer measures frame time and adjusts the render scale within the preset's
  bounds to hold 60 fps. Fullscreen effects scale with it.
- **Cheap stylized lighting.** One sun plus hemisphere ambient, lighting baked into textures (AO, painted
  highlights) and fog to hide the far plane. The painterly style in `ART_DIRECTION.md` was chosen partly because
  it looks great without expensive lighting.
- **Instancing and merging.** Rocks, crystals, trees, banners and cloud puffs are `InstancedMesh`. Static island
  geometry is merged per world chunk (about 250 m) with shared materials.
- **LOD everywhere.** Dragons get 3 LODs plus a sprite impostor beyond the far LOD. Islands get 2–3 LODs, and
  props are culled by distance.
- **Compressed assets.** KTX2 (Basis) textures stay compressed in GPU memory, which matters on shared-memory
  integrated GPUs. Geometry is meshopt-compressed GLB. Each map's total download should be ≤ 60 MB.
- **Animation cost control.** Dragons have ≤ 24 bones. Distant dragons update animation at 15 Hz instead of 60,
  and dragons outside the view skip animation updates.
- **Overdraw control.** Clouds and particles are the biggest risk on integrated GPUs. Soft particles only on
  High. Large transparent sprites are capped and sorted.
- **No hitches.** Shaders are precompiled with `renderer.compileAsync` during the loading screen, textures are
  uploaded before the match, and effect objects are pooled.
- **Host specifics.** The host's sim is light (≈10 dragons, simple shapes and a BVH raycast against terrain),
  but a U-series chip has only 2 performance cores, and the render loop, WebRTC and the browser all compete for
  them. So the **host sim + net layer is designed to run in a Web Worker from the start** (Phase 2 decides
  after a measurement, Phase 3 at the latest). This is possible because `src/sim` has no DOM or three.js scene
  dependency.
- **Thermal headroom.** A U-series laptop that holds 60 fps for 1 minute may drop after 8 minutes once it heats
  up. The dynamic resolution scaler absorbs most of that, and gates are measured after a 10-minute warm-up.
  Optionally, a "cap at 30/45 fps" setting saves battery and heat.

## Automatic quality pick

On first launch, a 3-second test flight over the title scene measures frame time and picks Low, Medium or High.
The renderer name from `WEBGL_debug_renderer_info` (e.g. "Intel(R) Arc(TM) Graphics") is logged with the result.
The player can always override the choice in Settings.

## How we measure (every phase gate)

1. `?perf` shows the HUD: fps, frame ms (avg and 1 % low), draw calls, triangles, textures/geometries in memory,
   JS heap, render scale, and on the host the sim ms and network KB/s.
2. `?bench` flies a fixed camera path through the busiest part of the map with 10 bot dragons fighting, for 60 s,
   and prints a summary (avg fps, 1 % low, max frame ms) to copy into `docs/PROGRESS.md`.
3. **Pass:** on a **U-series laptop that is hosting a 5v5**, after a **10-minute warm-up**, Medium holds an
   **average ≥ 60 fps with 1 % lows ≥ 45 fps**, and Low holds an average ≥ 60 fps with 1 % lows ≥ 50 fps.

## Laptop setup for testing and play (do this on every machine)

- Plug the laptop in. Windows on battery throttles the GPU heavily.
- Settings → System → Power → Power mode: **Best performance**.
- Settings → System → Display → Graphics: add Chrome or Edge and set it to **High performance**.
- In the browser, check that `chrome://gpu` (or `edge://gpu`) shows "WebGL2: Hardware accelerated".
- Update the Intel graphics driver (Intel Driver & Support Assistant).
- Close other heavy tabs, especially video calls, which compete for the same GPU.
