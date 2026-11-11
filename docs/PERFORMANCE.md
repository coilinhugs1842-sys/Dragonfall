# Performance: Intel Core Ultra 5 integrated graphics, 16 GB

## The target machine

- **CPU/GPU:** Intel Core Ultra 5 with integrated graphics. **H-series** chips (e.g. 125H, 225H) have Intel Arc
  graphics with 7 Xe cores. **U-series** chips (e.g. 125U, 135U) have 4 Xe cores, which is roughly **half the
  GPU**. We design so a U-series laptop is playable on **Low** and an H-series laptop is smooth on **Medium**.
- **Memory:** 16 GB shared between the CPU and GPU. Chrome or Edge, Windows and a background app or two leave
  roughly 2–3 GB that a game tab can use comfortably.
- **Browser:** current Chrome or Edge with hardware acceleration on, using WebGL2.
- **The host laptop does more:** it runs the sim for 10 dragons and keeps 9 WebRTC connections alive while
  rendering. The host's sim + net budget is below.

> Find out exactly which chip each laptop has (Settings → System → About → Processor). If any is a U-series,
> run every phase gate on that machine.

## Frame budget (60 fps = 16.7 ms)

| Item | Budget |
| --- | --- |
| Sim + net on the host (30 Hz work, averaged per frame) | ≤ 2.0 ms |
| Sim + net on a client (prediction + interpolation) | ≤ 1.0 ms |
| JS render prep (culling, animation, matrices, particles) | ≤ 3.5 ms |
| GPU time | ≤ 11 ms at Medium |
| Garbage collection | no visible stalls; zero per-frame allocations in the hot path |

## Scene budgets per quality preset

| Budget | Low | Medium (default) | High |
| --- | --- | --- | --- |
| Render scale (dynamic, of 1080p) | 0.55–0.8 | 0.7–1.0 | 0.85–1.0 |
| Draw calls | ≤ 150 | ≤ 250 | ≤ 400 |
| Triangles on screen | ≤ 400k | ≤ 800k | ≤ 1.5M |
| Shadow map (sun, near cascade only) | none (blob shadows) | 1024 | 2048 |
| Post-processing | none (tone-map in material) | one combined pass: FXAA + colour grade + vignette | + half-res bloom |
| Max particles alive | 800 | 2,000 | 4,000 |
| Dragon LOD distances (LOD0/LOD1/LOD2) | 30/90/250 m | 50/150/400 m | 80/220/600 m |
| Prop draw distance | 600 m | 1,000 m | 1,500 m |
| Cloud billboard layers | 1 | 2 | 3 |
| Texture VRAM (KTX2) | ≤ 256 MB | ≤ 400 MB | ≤ 600 MB |
| Audio voices | 16 | 24 | 32 |

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
- **Host specifics.** The host's sim is light (≈10 dragons, simple shapes and a BVH raycast against terrain).
  If profiling says so, the sim moves into a Web Worker in Phase 6. That's possible because `src/sim` has no
  DOM or three.js scene dependency.

## Automatic quality pick

On first launch, a 3-second test flight over the title scene measures frame time and picks Low, Medium or High.
The renderer name from `WEBGL_debug_renderer_info` (e.g. "Intel(R) Arc(TM) Graphics") is logged with the result.
The player can always override the choice in Settings.

## How we measure (every phase gate)

1. `?perf` shows the HUD: fps, frame ms (avg and 1 % low), draw calls, triangles, textures/geometries in memory,
   JS heap, render scale, and on the host the sim ms and network KB/s.
2. `?bench` flies a fixed camera path through the busiest part of the map with 10 bot dragons fighting, for 60 s,
   and prints a summary (avg fps, 1 % low, max frame ms) to copy into the handoff file.
3. **Pass:** Medium on an H-series laptop holds an **average ≥ 60 fps with 1 % lows ≥ 45 fps**, and Low on a
   U-series laptop holds an average ≥ 50 fps, **while that laptop is the host of a 5v5**.

## Laptop setup for testing and play (do this on every machine)

- Plug the laptop in. Windows on battery throttles the GPU heavily.
- Settings → System → Power → Power mode: **Best performance**.
- Settings → System → Display → Graphics: add Chrome or Edge and set it to **High performance**.
- In the browser, check that `chrome://gpu` (or `edge://gpu`) shows "WebGL2: Hardware accelerated".
- Update the Intel graphics driver (Intel Driver & Support Assistant).
- Close other heavy tabs, especially video calls, which compete for the same GPU.
