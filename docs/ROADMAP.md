# Roadmap

Each phase ends with a **gate**, a check the user does on real laptops. Task ids: `A-xx` = Claude lane,
`C-xx` = Cursor lane (see `docs/tasks/`).

| Phase | Goal | Who | Gate |
| --- | --- | --- | --- |
| **0. Scaffold** | Runnable empty app, contracts, dev tools | Claude alone (Cursor waits) | `npm run dev` shows a sky-coloured scene with the perf HUD at 60 fps on the target laptop; both folders run `npm install` + `npm run dev` |
| **1. Flight sandbox** | Fly one dragon over a greybox map | both | Flying feels good; Medium holds 60 fps on the target laptop |
| **2. Netcode core** | Host / join by room code, lobby sync, everyone flies together | both | 2 real laptops + `?bots=8` fly together on LAN with no rubber-banding at the 80 ms/2 % netsim profile; LAN-over-HTTP question answered |
| **3. Combat + MVP modes** | Abilities, damage, respawn, Skirmish + Duel, basic HUD | both | A full 1v1 Duel and a 2v2 Skirmish played start to finish on real laptops |
| **4. Art pass (Higgsfield)** | Real dragons, Shattered Spires, sky, textures, audio | both (Claude generates, Cursor integrates) | Looks like the mood board; Phase 1 perf gate still passes with real assets |
| **5. Cinematics + lobby** | Aerie lobby, host panel, intro flyby, death cam, results podium | both | The full flow (title → lobby → intro → match → podium → lobby) works with 4+ players |
| **6. Scale + content** | 5v5 tuning, Ember Relay, Emberfall Caldera, reconnect, auto quality, optional sim worker | both | 5v5 (real laptops + bots) where the **weakest laptop is the host** meets the perf gate in `PERFORMANCE.md` |
| **7. Ship** | Deploy to HTTPS static host, LAN mode docs, settings polish, trailer | both | A friend who has never seen it can host and play from the URL using only `README.md` |

## Phase 0 detail (first thing to build)

Claude does Phase 0 **alone**, because it creates the contracts and boot code everything else depends on. It
should take one session. Then the user syncs Cursor's worktree and both lanes start Phase 1 at the same time.

Contents: `vite.config.ts`, `index.html`, `src/main.ts`, an empty App state machine, all `src/shared` contracts
(stubs where details are TBD), the quality preset table, fixed-timestep loop, perf HUD (`?perf`), lil-gui
(`?debug`), and a test that the sim loop's timestep is stable.
