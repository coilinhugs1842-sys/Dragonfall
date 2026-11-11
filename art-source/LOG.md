# Higgsfield generation log

One row per job. Keep rejected ones too, so we don't repeat bad prompts.

| Date | Asset | Model | Prompt file | Job id | Result file | Kept? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-11 | Mood board: aerie | `gpt_image_2_6` (1k, low) | `art-source/prompts/moodboard-aerie.txt` | none (refused) | none | no | Refused before it ran: `job_minimum_basic_plan_required`. The account is on the free plan. 0 credits. |
| 2026-11-11 | Mood board: Shattered Spires | `gpt_image_2_6` (1k, low) | `art-source/prompts/moodboard-spires.txt` | none (refused) | none | no | Same refusal. 0 credits. |
| 2026-11-11 | Mood board: Talon dragon | `gpt_image_2_6` (1k, low) | `art-source/prompts/moodboard-dragon.txt` | none (refused) | none | no | Same refusal. 0 credits. |
| 2026-11-11 | Mood board: aerie | `soul_location` | `art-source/prompts/moodboard-aerie.txt` | none (refused) | none | no | Same refusal: Soul Location also needs a paid plan. 0 credits. |
| 2026-11-11 | Mood board: Shattered Spires | `soul_location` | `art-source/prompts/moodboard-spires.txt` | none (refused) | none | no | Same refusal. 0 credits. |
| 2026-11-11 | Mood board: Talon dragon | `z_image` (1024 × 576) | `art-source/prompts/moodboard-dragon.txt` | `938b08f5-2e2a-4487-b3be-dc01472bdec3` | none | no | Accepted on the free plan, ended `failed` after about 4 minutes with no reason given. 0.15 credits spent, then refunded. |
| 2026-11-11 | Mood board: Talon dragon (retry) | `z_image` (1024 × 576) | `art-source/prompts/moodboard-dragon.txt` | `bfc41640-92c4-41b6-aa7d-a6ecd352603a` | none | no | Failed the same way. 0.15 spent, refunded. Not retried again. Balance after all of the above: 10 credits. |

Prompt files are written by `node tools/pipeline/make-prompts.mjs` (STYLE FORMULA byte-for-byte plus the subject);
`--check` fails if a prompt file has drifted from the formula.

## Procedural assets (no Higgsfield job; DECISIONS 36)

| Date | Asset | How it was made | Script | Raw output | Runtime output |
| --- | --- | --- | --- | --- | --- |
| 2026-11-11 | Dragon: Talon (emerald) | Procedural: numpy loft/tube generator, analytic skin weights, numpy-painted 1024 atlas + emissive mask, Blender 5.2 rig/clips/export | `tools/blender/dragons/build_all.sh talon` (`classes/talon.py`) | `art-source/dragons/talon/` | `public/assets/dragons/talon/` |
| 2026-11-11 | Dragon: Bastion (bronze) | same generator, armour plates + club tail | `tools/blender/dragons/build_all.sh bastion` (`classes/bastion.py`) | `art-source/dragons/bastion/` | `public/assets/dragons/bastion/` |
| 2026-11-11 | Dragon: Tempest (sapphire) | same generator, crest fins + five-rib wings | `tools/blender/dragons/build_all.sh tempest` (`classes/tempest.py`) | `art-source/dragons/tempest/` | `public/assets/dragons/tempest/` |
| 2026-11-11 | Dragon: Wraith (obsidian) | same generator, tattered membranes + tail streamers, painted iridescence | `tools/blender/dragons/build_all.sh wraith` (`classes/wraith.py`) | `art-source/dragons/wraith/` | `public/assets/dragons/wraith/` |

Dragon previews (Blender EEVEE, warm low sun + cool hemisphere): `art-source/dragons/previews/`.

## T-4.5 Shattered Spires map art (2026-11-11, procedural, no Higgsfield job: DECISIONS 36)

| Date | Asset | Tool | Source script | Raw output | Runtime output | Kept? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-11 | 12 hero rocks (spire-tall/twin/lean, stump-broken, island-large/small, arch-great/broken, crown-claw/base, shard-cluster, cliff-wall) | Blender 5.2 Python | `tools/blender/map/build_rocks.py` + `rocklib.py` | `art-source/maps/rocks/*.glb`, `rocks.blend`, `hulls/*.json` | `public/assets/maps/shattered-spires/rocks/*.glb` | yes | Angular shards (prisms + planar cuts + chamfers), painted vertex colours (AO, strata, moss, lit edges), 3 LODs, convex hulls per shard |
| 2026-11-11 | 15 props (columns, wall, bridge, stairs, standing stone, crystals, sky-well crystal, 2 banners, brazier, chain, aerie gate, 2 backdrops) | Blender 5.2 Python | `tools/blender/map/build_props.py` | `art-source/maps/props/*.glb`, `props.blend`, `hulls/*.json` | `public/assets/maps/shattered-spires/props/*.glb` | yes | `TeamTint` material on banners and gate trim; emissive faces flagged in `_MASKS.a` |
| 2026-11-11 | 5 tileable textures 1024 (stone, cliff, moss, masonry, brush) | Python numpy + Pillow | `tools/textures/make_textures.py` | `art-source/textures-raw/*.png`, `means.json` | `public/assets/textures/*.ktx2`, `textures.json` | yes | Layered brush strokes drawn with wrap-around; seamless |
| 2026-11-11 | Map layout + manifest | TypeScript | `src/shared/maps/shattered-spires.ts`, `tools/blender/map/export_map_manifest.mjs` | n/a | `public/assets/maps/shattered-spires/manifest.json`, `instances/*.bin` | yes | 165 placements, half-turn symmetric |
| 2026-11-11 | Previews | Blender EEVEE | `tools/blender/map/render_vista.py`, `preview.py` | `art-source/maps/previews/*.png` | n/a | yes | Rock/prop/texture sheets and 10 vistas of the assembled layout |

Rebuild: `blender -b -P tools/blender/map/build_rocks.py`, `blender -b -P tools/blender/map/build_props.py`,
`python tools/textures/make_textures.py`, `node tools/blender/map/export_assets.mjs` (needs KTX-Software on PATH),
`node tools/blender/map/export_map_manifest.mjs`, then `blender -b -P tools/blender/map/render_vista.py`.
