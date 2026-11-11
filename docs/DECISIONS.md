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
8. ~~Two lanes (Claude Code + Cursor) with git worktrees.~~ Superseded by decision 13.
9. **Git LFS for binary assets.** Keeps the repo usable once generated assets pile up.

## Open questions (to resolve in the phase noted)

- ~~Phase 2: does WebRTC work from a plain-HTTP LAN origin?~~ Yes, see decision 20.
- ~~Phase 2: does PeerJS 1.5 give a truly unreliable channel?~~ No, we open our own, see decision 19.
- Phase 4: which Higgsfield 3D model settings give the best dragon meshes. Note the finding here.

## 2026-11-10: target hardware, reference review, GitHub

10. **The laptops are U-series Core Ultra 5 (4 Xe cores, 15 W).** Medium is sized so it holds 60 fps on them,
    with tighter budgets (see `PERFORMANCE.md`). Dragons are ≤ 8k triangles. Gates run after a 10-minute
    warm-up. The host sim is planned for a Web Worker (A-26). Revisit only if the hardware changes.
11. **Reference game reviewed and differences written down** in `ART_DIRECTION.md` ("How we differ"). The video
    was deleted afterwards. Reference material goes in `/reference/`, which is git-ignored and never pushed.
12. **The repo will be pushed to GitHub.** Consequences:
    - Binary assets stay in Git LFS. GitHub's free LFS storage and bandwidth are limited, so keep raw
      generations lean, and before each push check `git lfs ls-files -s` against the account's current quota.
    - **GitHub Pages does not serve LFS files** from a plain branch deploy, only pointer files. Deploy with a
      GitHub Actions workflow that checks out with `lfs: true` and publishes `dist/`, or use Cloudflare Pages.
    - Never commit secrets. TURN credentials, if we ever use them, go in a git-ignored `.env`.
    - The git author for commits is currently `aman037 <aman037@example.com>` (global git config). To link commits
      to a GitHub account, set `git config user.email` to the account's email or its GitHub noreply address
      before pushing.

## 2026-11-10: Claude-only development

13. **Claude Code builds the whole project. Cursor is not used as a second agent.** Running two agents was
    confusing to coordinate. The Cursor worktree, branch, rules and lane task files were removed. There is one
    task list (`docs/TASKS.md`) and one progress log (`docs/PROGRESS.md`). Any editor (Cursor, VS Code) can
    still be used to view or edit the code by hand.

## 2026-11-10: Phase 0 follow-ups (user delegated these to Claude)

14. **Dragon snapshot flags are `u16`, not `u8`.** Phase 0 already used all 8 bits. Widening costs 1 byte per
    dragon per snapshot (about 200 B/s per client at 5v5), which is nothing next to the 7 KB/s budget, and leaves
    8 bits for later statuses. Dropping `IN_STORM` would only have bought one bit. Revisit if the snapshot ever
    needs trimming.
15. **`PERFORMANCE.md` is the single source for on-screen budgets.** `ASSET_PIPELINE.md`'s "Map total" row was
    stale (800k triangles / 400 MB, from before the U-series retarget) and now reads 450k / 300 MB at Medium.
16. **No automatic re-test when the display refresh rate drops mid-session.** A periodic probe at minimum scale
    would cause a visible dip for a rare case. The scaler's `reset()` already re-detects; the Settings menu
    (T-3.9) will call it when the player changes quality or presses a "re-detect display" control. Revisit if
    playtests on battery show the scale stuck at minimum.

## 2026-11-10: Phase 1

17. **`src/sim` may import three.js data containers and `three-mesh-bvh`.** Terrain collision builds a
    `BufferGeometry` + `MeshBVH` from the shared map data. Allowed imports are `BufferGeometry`, `BufferAttribute`
    and the math classes: none of them touch the DOM or WebGL, so the sim still runs in node tests and a Web
    Worker. `src/shared` stays free of three.js. The boundary test enforces this allow-list.
18. **Collision and visuals are built from one triangle source.** The greybox map is pure data in
    `src/shared/maps`; `buildMapTriangles` feeds both the sim's BVH and the map view's merged chunks, so what
    you see is what you hit. Real maps (Phase 4) keep the rule with a dedicated collider mesh in the manifest.

## 2026-11-11: Phase 2

19. **`fast` is a second, negotiated data channel on PeerJS's own `RTCPeerConnection`; PeerJS's "unreliable"
    mode is not used.** Spike (PeerJS 1.5.5, Edge/Chromium, `tools/net-spike`): `peer.connect(id, { reliable:
    false })` only sets `ordered: false`; `maxRetransmits` stays null, so that channel still retransmits forever.
    Every `peer.connect()` also builds its own `RTCPeerConnection`. So one link is one PeerJS data connection
    (`ctrl`: serialization `raw`, reliable and ordered) plus a channel both ends create on
    `dataConnection.peerConnection` with `negotiated: true, id: 2, ordered: false, maxRetransmits: 0`.
    This answers the open question "does PeerJS 1.5 give a truly unreliable channel": no, we open our own.
20. **LAN mode is plain HTTP; no self-signed HTTPS.** WebRTC data channels, the LAN PeerServer websocket
    (`ws://<host>:9000/dragonfall`) and the host Web Worker all work from `http://<lan-ip>:<port>`
    (`isSecureContext` false), checked with the production build in Edge. Consequences: nothing in the game may
    need a secure context (`crypto.getRandomValues` instead of `crypto.randomUUID`, a selection-based clipboard
    fallback), and `secure` is always set explicitly for the LAN PeerServer. Checked with two browser instances
    on one machine by LAN IP; two laptops over Wi-Fi is the Phase 2 gate. Revisit if a browser starts requiring
    a secure context for WebRTC.
21. **The host sim runs in a Web Worker by default, with the main thread as an automatic fallback (A-26).**
    `HostCore` (session, lobby, bots, sim, collision, snapshot encoding) is DOM-free and runs in `host.worker`
    on its own 30 Hz timer; the page keeps the WebRTC transport and the input devices and exchanges one
    transferred binary batch per tick. Reasons: the match keeps its pace when the host's tab is hidden or its
    frame hitches, and host work leaves the render thread. Measured with `?bots=9` (dev build, desktop Edge):
    0.025 ms per tick in the worker against 0.045 ms on the main thread, and 0.02 ms against 0.13 ms of host
    work per rendered frame on the main thread. The host's own view receives state by `postMessage` (about
    0.6 ms late on average) and may extrapolate up to half a tick. `?noworker`, a browser without `Worker`, or a
    worker that fails before it says `ready` host on the main thread behind the same `HostHandle`; a worker
    that dies later closes the room. A hidden main-thread host freezes its sim but keeps answering pings.
    Still to measure on a U-series laptop (T-2.10).
22. **Kick bans the browser, not just the seat.** HELLO carries a per-browser `clientId`; the host refuses new
    seats for a kicked id for the life of the room. Clearing site data gets around it, which is fine among friends.
23. **Final visual bar (user, 2026-11-10): hero-shooter polish within the U-series budget.** The greybox and
    placeholder dragons are not the final look. Phase 4 targets the finish of a top stylized hero shooter
    (strong silhouettes, rich materials, rim light, readable VFX, cohesive grading) in our own style; the
    "original work only" rule still applies.
