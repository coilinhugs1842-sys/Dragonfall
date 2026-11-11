# Art Direction

## Goal

Look **premium and cinematic** while staying cheap to render on integrated graphics. The answer is a
**stylized painterly** look: hand-painted textures with lighting painted in, bold shapes, strong atmosphere
from fog and light shafts, and saturated creatures against a softer world. This style looks deliberate at low
resolution, unlike realistic graphics, which look cheap when scaled down.

It must also be **our own look**, not a copy of the Higgsfield showcase game.

## How we differ from the reference game

The reference video (reviewed 2026-11-10, then deleted; never commit it) shows these choices, which we **avoid**:

| Reference game | Dragonfall instead |
| --- | --- |
| Bright cobalt **midday** sky with huge white cumulus | **Golden hour / dusk** skies, cream-peach-violet gradients, light shafts |
| Ground world far below: rivers, turquoise water, patchwork farmland, villages | **No ground.** Floating stone spires and ruins above an endless **cloud sea** |
| Single-player PvE: purple enemy swarms, XP and level-ups, giant winged stone colossus boss | **Team PvP** (1v1–5v5) with modes and objectives. No XP levels, no colossus boss |
| Red/orange player dragon with orange bat wings; purple enemies | Neutral **jewel-tone** hides (emerald, sapphire, bronze, obsidian); team colour only as glowing accents |
| Comic-book pop-up text ("HIT!", "DOWN! WHOOSH!", "LEVEL UP!") in bold italic with outlines | Restrained cinematic UI: thin serif titles, small killfeed, subtle hit markers, no onomatopoeia |
| Mobile touch layout (virtual joystick, round buttons) | Keyboard + mouse first, gamepad second |
| Golden spark-shower breath, white speed streaks | Each class has its own effect shape (ember bolts with ribbon trails, heavy flame cone, forked lightning, smoky shade), with team-tinted cores |

What both games share is the genre: third-person dragon flight with breath attacks, dodge, boost and lock-on.
That's fine. The art, world, names, UI and structure are ours.

## STYLE FORMULA (draft: needs the user's approval before any asset generation)

Every Higgsfield asset prompt (concept art, textures, skies, 3D texture prompts) contains this paragraph
**byte-for-byte**. After approval it is frozen. Changing it means a full restyle pass
(see `ASSET_PIPELINE.md`).

```
Stylized painterly 3D game art with hand-painted textures and soft baked lighting, chunky readable forms. Bold sweeping silhouettes, angular shattered stone, swept-back wings and horns, no outlines. Environment in weathered slate-blue stone, mossy teal-green and pale cream cloud skies; creatures in saturated jewel tones that pop against the sky, team accents in molten orange versus glacier cyan; hazards and pickups marked with bright magenta glow. Luminous golden-hour atmosphere with long soft light through drifting clouds. High contrast between creatures and background, clean readable silhouettes.
```

**STYLE TOKEN** (≤120 characters, for length-limited fields):

```
stylized painterly hand-painted 3D, slate-blue stone, teal moss, jewel-tone dragons, golden-hour light, magenta accents
```

For 3D concept images, add the camera phrase `three-quarter isometric view, pure flat white background, no
shadow, no ground` *after* the formula (the formula itself stays unchanged).

## Palette by role

| Role | Colours |
| --- | --- |
| Stone, ruins | slate blue `#4E6A86`, deep shadow `#2A3346`, lit edge `#C9B79A` |
| Vegetation, moss | teal green `#3F8F7A`, highlight `#8CC9A1` |
| Sky, clouds | cream `#F4E6CC` → peach `#F2B984` → dusk violet `#5B4C7A` |
| Dragons (base hides) | jewel tones: emerald, sapphire, bronze, obsidian with iridescent edges (never a red/orange body) |
| Team Ember | `#FF7A1A` (glow `#FFB15C`) |
| Team Frost | `#3FD7FF` (glow `#A8F0FF`) |
| Hazards, pickups, objectives | magenta `#FF3FA4` |
| UI | warm parchment-white text `#FFF6E8` on translucent ink `#141824CC`, team colours for accents |

Dragon bodies are **neutral jewel tones**. The team colour is applied at runtime as an emissive accent on wing
membranes, glowing runes and the breath colour, so any dragon model works for either team.

## Lighting recipe (derived from the formula; render code uses these)

| Element | Shattered Spires (golden hour) | Emberfall Caldera (dusk) |
| --- | --- | --- |
| Sun | warm `#FFD9A0`, intensity ~2.2, low angle 18° | orange `#FF9A5C`, 12° |
| Hemisphere | sky `#9FB7D9`, ground `#3F5A55` | sky `#6B5A8C`, ground `#4A2A20` |
| Fog (exp²) | `#E9D9C0`, density tuned so 1.2 km fades out | `#7A4E5A` |
| Tone mapping | ACES Filmic, exposure ~1.0 | same |
| Accents | light shafts as cheap additive cards near the sun | lava glow from below as emissive + vertex colour |

## Dragons

- Four silhouettes that are readable at 200 m:
  - **Talon:** slim, long tail, narrow swept wings.
  - **Bastion:** bulky, armored plates, broad wings.
  - **Tempest:** long neck, crest fins, ribbed wings.
  - **Wraith:** lean, tattered wing edges, smoky tail.
- ≤ 8k triangles at LOD0 (U-series budget), ≤ 24 bones. Wing membranes are separate material slots so they can take the
  team tint.
- Riders are small and readable: a saddle silhouette with a team-coloured cloak.

## UI

Clean and cinematic. A thin serif display font for titles and a geometric sans for HUD numbers, both from Google
Fonts and loaded locally. Parchment-white on translucent ink panels, team colours only for team information. The
HUD stays minimal so the sky remains the star.
