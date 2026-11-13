# Dragonfall

A browser dragon-riding team battler, **1v1 up to 5v5**. One player's browser is the host and runs
the sim; everyone else joins with a room code over WebRTC. Built with three.js + TypeScript, tuned
for U-series Intel Core Ultra laptops (integrated graphics, 16 GB RAM).

## Play (once deployed)

1. Open the game URL in Chrome or Edge (HTTPS).
2. Pick a display name.
3. **Host a room**, share the room code, or **Join** with a code a friend sent.
4. In the aerie lobby: pick a class, Ready up. The host sets mode / map / team size and presses **Start**.
5. Fly, fight, then the podium brings everyone back to the aerie with teams kept.

Need nothing installed except a modern browser. The host's laptop is also playing, so plug it in and
set Windows to Best performance if you can.

## Play on a LAN (no public URL)

On the host laptop, in this repo:

```
npm install
npm run peer:lan
npm run dev:lan
```

`dev:lan` prints a `Network: http://192.168.x.x:5173` address. On every laptop open that URL with
`?lan` added (example: `http://192.168.1.20:5173/?lan`). Host a room on one machine; the others join
by code. `peer:lan` is a local PeerJS signaling server so play still works if the public broker is
unreachable.

If WebRTC over plain HTTP is blocked on your network, serve with HTTPS (`npm run build` then
`npm run preview`) and accept the self-signed certificate once per laptop.

## Develop

```
npm install
npm run dev          # http://localhost:5173
npm run typecheck
npm test
npm run build
```

Useful query flags (dev / capture): `?solo`, `?perf`, `?bench`, `?fill`, `?map=emberfall-caldera`,
`?mode=emberRelay`, `?quality=low|medium|high`, `?lan`. See `docs/` for the rest.

## Docs

| Doc | What it is |
| --- | --- |
| `docs/WORKFLOW.md` | How to work on this with Claude |
| `docs/GAME_DESIGN.md` | Flight, dragons, combat, modes, lobby, cinematics |
| `docs/ROADMAP.md` | Phases and gates |
| `docs/ARCHITECTURE.md` | Module layout and contracts |
| `docs/NETWORKING.md` | Host-authoritative P2P |
| `docs/PERFORMANCE.md` | Hardware target, budgets, quality presets |
| `docs/ART_DIRECTION.md` | Style, palette, lighting |
| `docs/TASKS.md` / `docs/PROGRESS.md` | Task list and session log |

## Deploy (GitHub Pages)

The repo ships a workflow at `.github/workflows/pages.yml`. It checks out with **Git LFS enabled**,
builds `dist/`, and publishes it to Pages (plain branch deploys only serve LFS pointer files).

1. Create an empty GitHub repo and push `main` (see `docs/WORKFLOW.md`).
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. After the first green `Deploy to GitHub Pages` run, the site URL is on the Actions summary /
   Environments page.
4. Friends open that HTTPS URL and host / join with only this README.

## Trailer

Frame-exact in-game captures are cut by `node tools/trailer/build.mjs`. The current cut lives at
`art-source/trailer/dragonfall-trailer.mp4` (~63 s, includes Shattered Spires, Emberfall Caldera,
Ember Relay, aerie, fight, podium). A Higgsfield Seedance polish pass needs a paid plan or trial
(see `docs/DECISIONS.md` 39).
