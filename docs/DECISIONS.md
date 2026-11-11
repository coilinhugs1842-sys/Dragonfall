# Decisions

Add new entries at the bottom: date, decision, why, what would change it. Don't silently reverse one.

## 2026-11-10: initial setup

1. **TypeScript + Vite + three.js r187, WebGLRenderer (WebGL2).** WebGL2 is the most mature path on Intel
   integrated drivers in Chrome/Edge. WebGPURenderer is a later option *if* it profiles faster on the target
   laptops. Revisit in Phase 6.
2. **Host-authoritative star over WebRTC with PeerJS.** Matches "one host computer, others connect to it". No
   game server to run or pay for. PeerJS's public broker does the signaling; we can self-host it with
   `npm run peer:lan` for offline LAN.
3. **30 Hz sim, 20 Hz snapshots, 100 ms interpolation, client prediction for your own dragon.** Standard
   trade-offs for ≤ 10 players on home or LAN Wi-Fi.
4. **Sim separated from rendering (no three.js scene / DOM in `src/sim`).** It's testable, cheap, and can move to
   a worker if the host needs it.
5. **No physics engine.** Arcade flight and simple hit shapes are cheaper and easier to make feel good. Terrain
   raycasts use `three-mesh-bvh`.
6. **Stylized painterly art.** It looks premium at reduced resolution and needs few lights. The style is pinned
   by the STYLE FORMULA.
7. **Plain HTML/CSS UI (no React).** It's lighter, and there's no framework render loop competing with the game
   loop.
8. **Two lanes with directory ownership + git worktrees.** Lets Claude Code and Cursor work at the same time with
   few merge conflicts. Claude is the integrator on `main`.
9. **Git LFS for binary assets.** Keeps the repo usable once generated assets pile up.

## Open questions (to resolve in the phase noted)

- Phase 2: does WebRTC with our setup work from a plain-HTTP LAN origin (`http://<ip>:4173`)? If not, LAN mode
  uses self-signed HTTPS.
- Phase 2: does PeerJS 1.5 give a truly unreliable channel, or do we open one on the raw `RTCPeerConnection`?
- Phase 4: which Higgsfield 3D model settings give the best dragon meshes. Note the finding here.
- Before Phase 4: the user shares screenshots of the Higgsfield showcase game so our look is checked to be
  different.
- Ask the user: which Core Ultra 5 model (U or H series) each laptop has.
