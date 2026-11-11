@AGENTS.md

## Claude Code specifics

- You are the **Claude lane** and the **integrator**. You work in `D:\Dragonfall` on branch `main`.
  Cursor works in the worktree `D:\Dragonfall-cursor` on branch `lane/cursor`.
- When the user says "merge Cursor's work" (or similar): commit your own work first, then in `D:\Dragonfall`
  run `git merge lane/cursor`, resolve conflicts, run `npm run typecheck && npm test && npm run build`, and
  report what came in. Then tell the user to have Cursor run `git merge main` in its worktree.
- Keep `src/shared/` contracts stable. When you change one, note it under "Contract changes" in
  `docs/handoff/claude-lane.md` so Cursor sees it after syncing.
- Read `docs/handoff/cursor-lane.md` at the start of each session for requests from the Cursor lane.
- Assets: use the Higgsfield skills (`higgsfield-generate`, and the game references in
  `higgsfield-websites` for 3D, textures, stylization, audio). Every generation prompt embeds the approved
  STYLE FORMULA from `docs/ART_DIRECTION.md` byte-for-byte. Log every job in `art-source/LOG.md`.
  Higgsfield jobs cost credits: confirm batches with the user before running them.
- Blender is at `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe` (not on PATH).
