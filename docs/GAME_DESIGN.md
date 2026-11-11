# Game Design — Dragonfall

> Status: draft v0.1. An original design. It shares a genre (dragon riding) with the Higgsfield showcase
> game that inspired it, not its art, names, maps or UI.

## Pitch

Teams of dragon riders fight above a broken sky archipelago. Flying is fast, arcade-style and easy to learn.
Fights are decided by positioning, dodges and team play rather than aim alone. Matches are short (6–10 min)
and every match starts and ends with a cinematic moment.

## Setting

**The Riven Sky.** Long ago the land cracked and its pieces drifted upward. Now stone spires, ruined bridges
and waterfalls pouring into a sea of clouds hang in the sky. Two rider orders fight over the sky-wells, the
glowing cores that keep the islands aloft:

| Team | Colour | Icon | Feel |
| --- | --- | --- | --- |
| **Ember Order** | molten orange `#FF7A1A` | flame / triangle | warm, aggressive |
| **Frost Order** | glacier cyan `#3FD7FF` | crystal / diamond | cool, precise |

Orange vs cyan stays readable for the common types of colour blindness. Every team marker also uses its
shape icon, not colour alone.

## Players and teams

- **1v1 to 5v5.** The host picks the team size (1–5 per side). Uneven teams such as 2v3 are allowed when the
  host enables them.
- The host can drag players between teams, **auto-balance**, **shuffle**, or **lock teams**.
- Extra people beyond 10 join as **spectators**.
- Stretch goal: **bot riders** fill empty slots. Simple bots arrive early anyway, for network load testing.

## Flight (arcade)

- The dragon always moves forward. Cruise speed is about 45 m/s, between a 25 m/s stall and 95 m/s in a full
  dive or boost.
- **Mouse aim:** the dragon turns toward the reticle, and the camera follows behind and slightly above.
  **WASD** gives fine pitch and yaw. **A/D** add roll.
- **Energy:** climbing bleeds speed and diving gains it. Speed is a resource you manage.
- **Shift** boosts (stamina bar). **Space** flaps up hard. **Ctrl** dives or folds the wings.
- **Q/E** barrel-roll dodge: a short burst sideways with about 0.25 s of damage immunity and a 4 s cooldown.
- Hitting terrain bounces you and costs HP. It only kills at very high speed.
- The arena edge is a **storm wall** that pushes you back in and deals damage over time.

## Dragons (4 classes at launch)

Every class has **Primary** (left mouse), **Secondary** (right mouse), **Utility** (F) and an **Ultimate** (R)
that charges by dealing damage and capturing objectives.

| Class | Role | HP | Speed | Primary | Secondary | Utility | Ultimate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Talon** | skirmisher | low | fastest | Fire bolts (rapid projectiles) | Searing dash (damaging lunge) | Afterburn (speed trail that burns pursuers) | Meteor strafe (line of fire bombs) |
| **Bastion** | frontline | high | slow | Flame cone (short range, sustained) | Wing shield (blocks frontal damage) | Rally roar (allies near you heal over time) | Bulwark charge (knock-back wave) |
| **Tempest** | artillery | medium | medium | Lightning lance (charge-up beam, long range) | Static mine (area slow) | Updraft (vertical burst) | Thunderhead (storm cloud that zaps an area) |
| **Wraith** | ambusher | low-med | fast in dives | Shade breath (damage over time) | Veil (briefly invisible until you attack) | Phase dive (pass through terrain for 1 s) | Night terror (blinds enemies in a cone) |

Exact numbers live in `src/shared` tuning tables so they can be balanced without code changes.

Rules that follow from the build (DECISIONS 27, 28): every ability that can hurt an enemy, Afterburn included,
ends spawn protection and Veil. While a Wraith is veiled, enemies get no hit markers, status icons or cast
effects for it, on the host's screen too.

## Modes

| Mode | Teams | Win condition | Phase |
| --- | --- | --- | --- |
| **Skirmish** | 1v1–5v5 | First team to N takedowns, or the most when time runs out | MVP |
| **Duel** | 1v1 (also 2v2) | Best of 5 rounds, no respawns, the storm wall shrinks each round | MVP |
| **Ember Relay** | 2v2–5v5 | Carry the enemy's sky-shard back to your brazier (capture-the-flag) | Phase 6 |
| **Sky Crown** | 2v2–5v5 | Hold a moving control zone for N seconds total | Stretch |

Respawn takes 5 s at the team's aerie gate, with 2 s of spawn protection.

## Maps

1. **Shattered Spires** (MVP). A 2 × 2 km bowl of stone pillars, rope bridges, waterfalls into the cloud sea,
   and a central sky-well with a ring of floating stones. Golden-hour light.
2. **Emberfall Caldera** (Phase 6). A broken volcanic crater: rising heat vents (free speed), drifting ash
   islands, and a lava glow from below. Dusk light.

Map rules: every route has cover within 4 seconds of flight, team gates are mirror-balanced, and the edges
make the arena feel bigger than it is.

## Flow and the cinematic moments

```
Title ─► Host / Join (room code) ─► Lobby (cinematic aerie) ─► Match intro ─► Match ─► Results podium ─┐
                                        ▲                                                         │
                                        └─────────────────────── back to lobby ◄──────────────────┘
```

### Cinematic lobby: "The Aerie"

- A real-time 3D scene: a cliffside aerie at sunset with **two terraces** (Ember left, Frost right) of
  **5 perches** each.
- When a player joins, their chosen dragon **lands on a perch** with an animation. Their name and class float
  above it.
- Ready-up: the dragon rears and its team-coloured glow lights up.
- The camera drifts slowly along a spline. Clicking a player's perch in the UI frames that dragon in a
  close-up.
- **Host panel:** mode, map, team size (1–5), uneven teams on/off, score limit, time limit, friendly fire,
  allowed classes, team assignment (drag, auto-balance, shuffle, lock), kick, and **Start**.
- **Start:** the camera pushes in, the dragons launch in sequence, and the scene fades into the match intro.

### Match intro (~6 s, skippable after the first match)

- A spline flyby of the map with the map name and mode title card, then a cut to each team's gate showing its
  riders, then a 3-2-1 countdown with control handed over.

### During the match

- Killfeed, team score, timer, ability cooldowns, and a teammate compass.
- On death: a 3 s **death cam** that orbits your killer. Stretch: a short replay from the snapshot history.

### Results podium

- The winning team flies a formation pass. The MVP, most takedowns and most damage dragons land on a podium.
  Then everyone goes back to the aerie with teams kept.

## Controls (defaults; rebindable)

| Action | Keyboard / mouse | Gamepad |
| --- | --- | --- |
| Steer | Mouse | Left stick |
| Pitch / yaw fine | W/S, A/D | Right stick |
| Boost | Shift | LB |
| Flap up | Space | A |
| Dive | Ctrl | B |
| Dodge roll | Q / E | LB + stick |
| Primary / Secondary | LMB / RMB | RT / LT |
| Utility / Ultimate | F / R | X / Y |
| Scoreboard | Tab | View |

## Out of scope for v1

Matchmaking servers, accounts or progression, host migration, cosmetics store, mobile.
