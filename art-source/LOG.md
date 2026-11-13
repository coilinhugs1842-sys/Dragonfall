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

## Trailer (T-7.4, 2026-11-12 — in-game capture, 0 Higgsfield credits)

| Date | Asset | How | Result | Notes |
| --- | --- | --- | --- | --- |
| 2026-11-12 | `art-source/trailer/dragonfall-trailer.mp4` | `node tools/trailer/build.mjs` (frame-exact capture + ffmpeg cut) | ~63 s, 1920×1080@60, 86 MB, game music | Caldera + Ember Relay shots unlocked; Seedance polish needs paid plan (DECISIONS 39). |

## Procedural assets (no Higgsfield job; DECISIONS 36)

| Date | Asset | How it was made | Script | Raw output | Runtime output |
| --- | --- | --- | --- | --- | --- |
| 2026-11-11 | Dragon: Talon (emerald) | Procedural: numpy loft/tube generator, analytic skin weights, numpy-painted 1024 atlas + emissive mask, Blender 5.2 rig/clips/export | `tools/blender/dragons/build_all.sh talon` (`classes/talon.py`) | `art-source/dragons/talon/` | `public/assets/dragons/talon/` |
| 2026-11-11 | Dragon: Bastion (bronze) | same generator, armour plates + club tail | `tools/blender/dragons/build_all.sh bastion` (`classes/bastion.py`) | `art-source/dragons/bastion/` | `public/assets/dragons/bastion/` |
| 2026-11-11 | Dragon: Tempest (sapphire) | same generator, crest fins + five-rib wings | `tools/blender/dragons/build_all.sh tempest` (`classes/tempest.py`) | `art-source/dragons/tempest/` | `public/assets/dragons/tempest/` |
| 2026-11-11 | Dragon: Wraith (obsidian) | same generator, tattered membranes + tail streamers, painted iridescence | `tools/blender/dragons/build_all.sh wraith` (`classes/wraith.py`) | `art-source/dragons/wraith/` | `public/assets/dragons/wraith/` |
| 2026-11-12 | Dragon: Verdant (jade/amethyst) | same generator, leafy crest fins | \	ools/blender/dragons\ (\classes/verdant.py\) | \rt-source/dragons/verdant/\ | \public/assets/dragons/verdant/\ |
| 2026-11-12 | Dragon: Aureate (citrine/gold) | same generator, slim disruptor | \	ools/blender/dragons\ (\classes/aureate.py\) | \rt-source/dragons/aureate/\ | \public/assets/dragons/aureate/\ |
| 2026-11-12 | Dragon: Zephyr (pearl/aquamarine) | same generator, light scout | \	ools/blender/dragons\ (\classes/zephyr.py\) | \rt-source/dragons/zephyr/\ | \public/assets/dragons/zephyr/\ |
| 2026-11-12 | Dragon: Granite (slate-silver) | same generator, siege plates | \	ools/blender/dragons\ (\classes/granite.py\) | \rt-source/dragons/granite/\ | \public/assets/dragons/granite/\ |
| 2026-11-12 | Dragon: Mirage (opal/rose) | same generator, trickster tatters | \	ools/blender/dragons\ (\classes/mirage.py\) | \rt-source/dragons/mirage/\ | \public/assets/dragons/mirage/\ |
| 2026-11-12 | All nine dragons: anim polish rebuild | Stronger dive tuck / flap / bank in \dragonlib/anim.py\; re-export + finish | \uild_dragon.py\ + \inish.mjs\ / optimize | \rt-source/dragons/*/\ | \public/assets/dragons/*/\ |
| 2026-11-11 | Dragons: rider rework, all four classes rebuilt (Talon, Bastion, Tempest, Wraith) | Procedural, 0 credits, same generator: the rider is now a helmed figure (crested helm with a glowing visor slit, shoulder plates, cowl, swallow-tailed cape, hands on a saddle grip), painted in the class's leather and horn colours, with the cape, cowl and crest in the team colour through the emissive mask. LOD0/LOD1 +107/+59 triangles, LOD2 -20 | `python tools/blender/dragons/paint_dragon.py <class>`, `blender -b -P tools/blender/dragons/build_dragon.py -- <class>`, `node tools/blender/dragons/finish.mjs` (`dragonlib/dragon.py` `build_rider`, `dragonlib/paint.py`, `classes/*.py`) | `art-source/dragons/<class>/` | `public/assets/dragons/<class>/` |

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

## T-6.4 Emberfall Caldera map art (2026-11-11, procedural, no Higgsfield job, 0 credits: DECISIONS 36)

| Date | Asset | Tool | Source script | Raw output | Runtime output | Kept? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-11 | 12 hero rocks (crater-wall, crater-breach, rim-tooth, cone-wall, basalt-columns, basalt-tall, obsidian-shards, obsidian-fan, ash-island-large/small, vent-chimney, lava-arch) | Blender 5.2 Python | `tools/blender/map/build_caldera_rocks.py` + `rocklib.py` | `art-source/maps/caldera/rocks/*.glb`, `rocks.blend`, `hulls/*.json` | `public/assets/maps/emberfall-caldera/rocks/*.glb` (4.11 MB) | yes | Basalt columns, obsidian shards and cracked crater walls; lava cracks and pools flagged in `_MASKS.a` in deep crimson (never orange: that is team Ember's); the lava's light from below painted into the vertex colours of undersides; 3 LODs, convex hulls. Blender prints "mesh not valid" for the lowest LOD of five rocks: the exported GLBs load and draw (checked in game), not investigated further |
| 2026-11-11 | 7 props (vent-marker, caldera-gate, basalt-pylon, obsidian-cluster, fumarole, backdrop-ridge, backdrop-cone) | Blender 5.2 Python | `tools/blender/map/build_caldera_props.py` | `art-source/maps/caldera/props/*.glb`, `props.blend`, `hulls/*.json` | `public/assets/maps/emberfall-caldera/props/*.glb` (0.53 MB) | yes | `TeamTint` on the gate trim; vent markers glow magenta ("fly here"). The map also reuses three first-map props as they are: crystal-core, banner-tall, chain |
| 2026-11-11 | 3 tileable textures 1024 (basalt, columnar, ash) | Python numpy + Pillow | `tools/textures/make_textures.py --set caldera` | `art-source/textures-raw/{basalt,columnar,ash}.png`, `means.json` | `public/assets/textures/{basalt,columnar,ash}.ktx2` (0.60 MB), entries added to `textures.json` with `map` and `role` | yes | Fill the world material's `stone`, `cliff` and `moss` slots on this map (`role`); masonry and brush are shared with the first map |
| 2026-11-11 | Map layout + manifest | TypeScript | `src/shared/maps/emberfall-caldera.ts`, `tools/blender/map/export_caldera_manifest.mjs --register` | n/a | `public/assets/maps/emberfall-caldera/manifest.json`, `instances/*.bin`; entry in `public/assets/manifest.json` | yes | 206 placements in 22 types, 9 heat vents, half-turn symmetric. Re-baked after the sky gained its look fields (ash, glow gain) |
| 2026-11-11 | Previews | Blender EEVEE | `tools/blender/map/render_caldera_vista.py` | `art-source/maps/caldera/previews/*.png` | n/a | yes | Vistas of the assembled layout under the dusk light |

Rebuild: `blender -b -P tools/blender/map/build_caldera_rocks.py`, `blender -b -P tools/blender/map/build_caldera_props.py`,
`python tools/textures/make_textures.py --set caldera`, `node tools/blender/map/export_caldera_assets.mjs` (needs
KTX-Software on PATH), `node tools/blender/map/export_caldera_manifest.mjs --register`, then
`blender -b -P tools/blender/map/render_caldera_vista.py`. Either map's export keeps the other map's entries in
`textures.json`.
