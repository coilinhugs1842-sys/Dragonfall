# Asset pipeline tools

Raw files (Blender exports, PNG, WAV) live in `art-source/`. Only what these tools write goes into
`public/assets/`. Run everything from the repo root.

Needs: Node 22+, KTX-Software (`toktx`; found in `C:\Program Files\KTX-Software\bin`, on PATH, or
in `$KTX_BIN`), ffmpeg with libvorbis (on PATH or `$FFMPEG`).

| Command                                                                              | What it does                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `npm run assets:optimize -- <in.glb> <out.glb> [--kind dragon\|rock\|prop]`          | Raw GLB to runtime GLB                                  |
| `npm run assets:inspect -- <file\|dir> [--kind ...] [--json]`                        | Report + budget check, exit 1 when over                 |
| `npm run assets:texture -- <in.png> <out.ktx2> [options]`                            | PNG/JPEG to KTX2                                        |
| `npm run assets:audio -- <in.wav\|dir> <out.ogg\|dir> [--kind sfx\|music\|ambience]` | WAV to normalised Ogg Vorbis                            |
| `npm run assets:check [-- --root <assets dir>]`                                      | Validate `public/assets/manifest.json` and all it lists |

Budgets come from `ASSET_BUDGETS` in `src/shared/manifests.ts`. The tools read the JSON mirror
`budgets.json`; `tests/tools/budgets.test.ts` fails when the two differ, so change both together.

## optimize

```
npm run assets:optimize -- art-source/rigged/talon.glb public/assets/dragons/talon/talon.glb --kind dragon
```

Steps: dedup, prune, weld, resample animations, textures to KTX2, meshopt compression
(`EXT_meshopt_compression`, `KHR_mesh_quantization`, `KHR_texture_basisu`, all required).

Kept, and verified against the written file (the command fails if any of it changed): every named
node (`LOD0`..`LOD2`, empty socket nodes), bones, animation clip names, material names (materials
with equal values are not merged), the number of primitives with vertex colours, triangles per
LOD.

- `--kind` sets the texture edge cap (dragon 1024, rock 1024, prop 512) and which budget is
  checked after writing. Without it the kind is taken from the output path (`dragons/`, `rocks/`,
  `props/`). Exit 1 when over budget (`--no-budget` to write anyway).
- `--max-texture <px>` overrides the cap. `--texture-mode auto|uastc|etc1s` forces a codec.
- Positions and UVs stay 32-bit floats by default, so node transforms are untouched and UVs can
  tile outside 0..1. Normals become int16, colours and skin weights uint8 (normalised).
  `--quantize-all` also quantises positions and UVs: smaller, but it rewrites the transform of
  unskinned mesh nodes and can add `KHR_texture_transform`. Do not use it for meshes whose
  geometry is taken out of the node and instanced.
- A texture used for both colour and data is rejected. An existing KTX2 texture is left alone.

Loading the result in three.js:

```ts
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const ktx2 = new KTX2Loader().setTranscoderPath('./vendor/basis/').detectSupport(renderer);
const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
```

GLTFLoader turns a node whose mesh has several primitives (one per material) into a `Group` named
`LOD0` with child meshes `LOD0_1`, `LOD0_2`, ... Look LODs up with `getObjectByName('LOD0')` and
toggle `visible` on that object; find tint materials by `material.name`.

## inspect

```
npm run assets:inspect -- public/assets
npm run assets:inspect -- public/assets/dragons/talon/talon.glb
```

Per GLB: triangles/vertices/primitives per LOD node (a node named `LODn`, `LODn_x` or `x_LODn`,
subtree included), bones, clips with durations, materials, vertex colours, textures, extensions.
Per `.ktx2`: size, codec, colour space, mip levels. Per directory: totals by type.

Exit 1 when a file is over budget: dragon (LOD triangles 8000/3000/1000, all three LOD nodes
present, 24 bones, textures 1024, 2 MB), rock (8000/3000/800, 1 MB), prop (3000 triangles,
300 KB), sky panorama (a `.ktx2` with `sky` or `panorama` in its path: 6 MB, 4096x2048), a
`maps/<id>` directory (60 MB total, 15 MB audio), any Draco-compressed GLB. A GLB whose kind
cannot be told from the path or a skin is reported but not checked; pass `--kind`.

## texture

```
npm run assets:texture -- art-source/textures-raw/stone.png public/assets/textures/stone.ktx2
npm run assets:texture -- art-source/textures-raw/stone_n.png public/assets/textures/stone_n.ktx2 --normal
npm run assets:texture -- art-source/textures-raw/sky.png public/assets/maps/shattered-spires/sky_panorama.ktx2 --kind sky
```

- Edge cap: 1024 by default, `--kind dragon|rock|prop|sky` (1024/1024/512/4096) or `--max <px>`.
  The aspect ratio is kept; sizes are rounded to a multiple of 4. Mipmaps are generated
  (`--no-mipmaps` to skip).
- `--mode auto` (default): UASTC + Zstd for `--normal` / `--linear` maps and for colour maps
  under 512 px, ETC1S for colour maps of 512 px and up. `--mode uastc|etc1s` forces one.
- `--linear` marks data maps (roughness, masks, noise). `--normal` implies it. Everything else is
  sRGB colour.
- KTX2 stores the top row first and compressed textures cannot be flipped on upload: `v = 0` is
  the top of the image, as in glTF. Write shaders and UVs for that.

## audio

```
npm run assets:audio -- art-source/audio-raw/boost.wav public/assets/audio/sfx/boost.ogg --kind sfx --mono
npm run assets:audio -- art-source/audio-raw/music public/assets/audio/music --kind music
```

Output is Ogg Vorbis at 44.1 kHz (decoded by `decodeAudioData` in Chrome, Edge and Firefox; no
encoder padding, so loops stay gapless).

- `sfx` (default): gain so the true peak is -1 dBTP.
- `music`: gain to -16 LUFS integrated; `ambience`: -23 LUFS. Both use plain gain (no limiter) and
  stop at a -1.5 dBTP ceiling, so a very dynamic track can land below the target; the printed
  line shows what was reached.
- The encoded file is measured again and re-encoded lower if the peak overshoots by more than
  0.1 dB.
- `--mono` downmixes (use it for positional SFX), `--quality 0..10` is libvorbis `-q:a`
  (default 5, ambience 4), `--lufs` / `--peak` override the targets.

## check

```
npm run assets:check
```

Validates the root manifest (`version`, `dragons`, `maps`) and every dragon and map manifest it
lists against `src/shared/manifests.ts`: field shapes, every referenced file exists (URLs are
relative to `public/assets/`, forward slashes), and

- dragon: `lods[i].node` exists and `lods[i].triangles` equals the GLB's count; every
  `DRAGON_ANIM_CLIPS` state maps to a clip in the GLB; bone names are nodes of the GLB; tint slot
  names are materials of the GLB; dragon budgets.
- map: chunk and prop files, prop/rock budgets (a prop GLB under `rocks/` gets the rock budget),
  unit `sunDirection`, two spawn gates indexed by team with 5 slots each, `ceilingY > floorY`, a
  collision source (`colliders.terrain` or `solids`), audio at most 15 MB, all referenced files at
  most 60 MB, panorama at most 6 MB.

Extra fields are allowed. `tests/tools/manifest.test.ts` runs the same check in `npm test` once
`public/assets/manifest.json` exists.

## Load check in the browser

`verify.html` loads pipeline output with the game's three.js build and the runtime decoders, and
leaves a report in `window.__verify`:

```
npx vite --port 5211
http://localhost:5211/tools/pipeline/verify.html?file=/assets/dragons/talon/talon.glb&clip=flap
```

`file` is a URL on the dev server (`/assets/...` for `public/assets`, `/art-source/...` for raw
folders). It can be repeated and can be a `.glb`, `.ktx2` or `.ogg` (decoded with `decodeAudioData`).

## Test fixtures

```
python tools/pipeline/fixtures/make_test_media.py art-source/_scratch/pipeline-test
blender -b -P tools/pipeline/fixtures/make_test_glb.py -- art-source/_scratch/pipeline-test/test_raw.glb art-source/_scratch/pipeline-test/color_1024.png
```

A skinned, textured, vertex-coloured GLB with `LOD0..LOD2`, 4 bones, 3 materials and 2 clips, plus
PNGs and WAVs to try the tools on. Not game assets.
