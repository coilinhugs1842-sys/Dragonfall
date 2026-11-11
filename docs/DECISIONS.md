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

- Phase 2: does WebRTC with our setup work from a plain-HTTP LAN origin (`http://<ip>:4173`)? If not, LAN mode
  uses self-signed HTTPS.
- Phase 2: does PeerJS 1.5 give a truly unreliable channel, or do we open one on the raw `RTCPeerConnection`?
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
