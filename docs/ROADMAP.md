# Roadmap

Each phase ends with a **gate**, a check the user does on real laptops. Tasks for each phase are in `docs/TASKS.md`
(`T-<phase>.<n>`).

| Phase | Goal | Gate |
| --- | --- | --- |
| **0. Scaffold** | Runnable empty app, contracts, renderer base, dev tools | `npm run dev` shows a sky-coloured scene with the perf HUD at 60 fps on a U-series laptop |
| **1. Flight sandbox** | Fly one dragon over a greybox map | Flying feels good; Medium holds 60 fps on a U-series laptop |
| **2. Netcode core** | Host / join by room code, lobby sync, everyone flies together | 2 real laptops + `?bots=8` fly together on LAN with no rubber-banding at the 80 ms/2 % netsim profile; LAN-over-HTTP question answered |
| **3. Combat + MVP modes** | Abilities, damage, respawn, Skirmish + Duel, HUD, settings | A full 1v1 Duel and a 2v2 Skirmish played start to finish on real laptops |
| **4. Art pass (Higgsfield)** | Real dragons, Shattered Spires, sky, textures, audio | Looks like the mood board; the Phase 1 perf gate still passes with real assets |
| **5. Cinematics + lobby** | Aerie lobby, host panel, intro flyby, death cam, results podium | The full flow (title → lobby → intro → match → podium → lobby) works with 4+ players |
| **6. Scale + content** | 5v5 tuning, Ember Relay, Emberfall Caldera, reconnect, auto quality | 5v5 (real laptops + bots) where the **weakest laptop is the host** meets the perf gate in `PERFORMANCE.md` |
| **7. Ship** | Push to GitHub, deploy to HTTPS (GitHub Pages via Actions), LAN docs, polish, trailer | A friend who has never seen it can host and play from the URL using only `README.md` |

## Phase 0 detail (first thing to build)

Phase 0 should take one session. It produces `vite.config.ts`, `index.html` and `src/main.ts`; an empty App state
machine; all `src/shared` contracts (stubs where details are TBD); the quality preset table and renderer base
with dynamic resolution; a fixed-timestep loop; the perf HUD (`?perf`) and lil-gui (`?debug`); and a test that
the sim loop's timestep is stable.
