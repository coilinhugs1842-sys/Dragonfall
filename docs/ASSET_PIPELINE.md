# Asset Pipeline: Higgsfield → Blender → gltf-transform → game

Claude runs the generations with the Higgsfield skills installed on this machine
(`higgsfield-generate`, plus the game references bundled with `higgsfield-websites`: `game-stylization`,
`game-3d-animation`, `game-procedural-animation`, `game-textures`, `game-audio`).

**Higgsfield jobs cost credits.** Claude proposes each batch (what, how many, which model) and waits for the
user's OK before running it.

## Folders

```
art-source/                 raw material, tracked with Git LFS (never loaded by the game)
  LOG.md                    every Higgsfield job: date, asset, model, prompt id, job id, result, kept?
  prompts/                  the exact prompts used (each one contains the STYLE FORMULA)
  concepts/                 concept images
  raw-3d/                   GLBs straight from image-to-3D
  rigged/                   after Blender rigging + animation
  textures-raw/             tileable texture sources
  audio-raw/                generated audio before normalising
tools/                      pipeline scripts (Python/Node), run from the repo root
public/assets/              optimized runtime assets only, loaded by the game
  dragons/<class>/          <class>.glb (LOD0-2 inside), manifest entry
  maps/<map>/               chunks, props, sky, manifest
  textures/                 shared KTX2
  audio/                    .ogg (music, sfx, ambience)
  manifest.json             what exists + budgets + source references
```

## Tools needed (installed when Phase 4 starts, not yet)

| Tool | Status | For |
| --- | --- | --- |
| Higgsfield CLI + skills | installed, logged in | generation |
| Blender 5.2 | installed at `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe` | rigging, LODs, cleanup |
| Python 3.13 | installed | texture post-process scripts from the skill |
| `@gltf-transform/cli` | in devDependencies | optimize/compress GLB |
| KTX-Software 4.4.2 (`ktx`, `toktx`) | installed at `C:\Program Files\KTX-Software\bin` | KTX2 texture compression used by gltf-transform |
| ffmpeg 9.0.2 | installed via winget (`ffmpeg` on PATH in new shells) | audio normalising, .ogg conversion, video frames |

New terminals pick up both on PATH. A shell that was open before the install needs the full paths, or a restart.

## 1. Style gate (once)

The user approves the STYLE FORMULA in `ART_DIRECTION.md`. Claude then generates **3 mood-board images**
(aerie at sunset, Shattered Spires overview, one dragon) to confirm the look before any batch.

## 2. Dragons (per class)

1. **Concept:** 2–4 images with the formula + the class description + `three-quarter isometric view, pure flat
   white background, no shadow, no ground`. Pick the best. Optionally add a side view for better reconstruction.
2. **Image → 3D:** `image_to_3d` (or `multi_image_to_3d` with several views) with `should_texture true`. Ask for
   the low-poly / target polycount option (about 8k).
3. **Rig + animation:** a dragon isn't a biped, so automatic rigging will likely fail with "pose estimation
   failed". Use the **procedural branch** from `game-procedural-animation`:
   `proc_rig_dragon.py` → `proc_weights.py` → `proc_anim_dragon.py` in headless Blender. Clips: `glide`, `flap`,
   `boost`, `dive`, `bank_l`, `bank_r`, `hover`, `roar`, `land`, `takeoff`, `hit`, `death_fall`. Gameplay
   blends them in `src/dragons`.
4. **LODs:** decimate in Blender to about 8k / 3k / 1k triangles. Export one GLB with `LOD0..2` nodes.
5. **Tint slots:** split the material slots `Hide`, `Membrane`, `Runes` so runtime team tinting works.
6. **Optimize:** `gltf-transform optimize in.glb out.glb --compress meshopt --texture-compress ktx2`, then
   `npm run assets:inspect -- out.glb` and check the budget (≤ 2 MB per dragon, textures ≤ 1024²).
7. **Visual check:** load it in the dev viewer (`?viewer=dragon:<class>`). Check scale (wingspan about 14 m),
   forward axis (+Z), clip names, and that the wings deform cleanly.

**Fallback if a generated mesh can't be rigged well:** build the dragon in parts (body, 2 wings, tail segments)
and animate the parts procedurally in code. This is cheaper at runtime and very robust.

## 3. World

- **Islands and spires:** concept → `image_to_3d` for 6–10 hero rock shapes. Reuse them scaled and rotated as
  instances. Bake vertex AO in Blender. LOD them.
- **Props** (ruins, bridges, crystals, banners, braziers): ≤ 3k triangles each, instanced.
- **Tileable textures** (stone, moss, cliff, sand): the `game-textures` "Texture Tile Factory" (seamless edit +
  `pipeline.py` for palette, seams and PBR maps) → KTX2 at 1024².
- **Sky:** a generated 2:1 panorama of distant clouds and mountains (no sun disk) → KTX2 at 4096×2048. The sun,
  sky gradient and moving cloud layers are done in a shader on top, so the time of day can change per map.
- **Cloud sea:** shader-driven, no texture-heavy approach.

## 4. Audio

- `seed_audio` for SFX (wing flaps, boost whoosh, each breath type, impacts, shield, takedown sting, UI clicks)
  and ambience (high-altitude wind, distant thunder, lava rumble).
- Music: lobby theme, match loop (low/high intensity layers) and victory/defeat stings. Use a music model per
  `game-audio`.
- Normalise with ffmpeg (music about -16 LUFS, SFX peak -1 dBTP) → `.ogg`. Keep the total audio per map under
  15 MB.

## 5. Video (marketing only)

Higgsfield video models (Seedance) can make a trailer from in-game captures or concept art. In-game cinematics
are always **real-time**, never video files, so they react to the actual players and teams.

## Budgets summary

| Asset | Triangles | Textures | File |
| --- | --- | --- | --- |
| Dragon (per class) | 8k / 3k / 1k | ≤ 1024², 3 slots | ≤ 2 MB |
| Hero rock | 8k / 3k / 800 | shared tileables | ≤ 1 MB |
| Prop | ≤ 3k | shared atlas | ≤ 300 KB |
| Sky panorama | — | 4096×2048 KTX2 | ≤ 6 MB |
| Map total | ≤ 800k on screen at Medium | ≤ 400 MB VRAM | ≤ 60 MB download |
