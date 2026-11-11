# Workflow: Claude Code and Cursor working at the same time

## The layout

```
D:\Dragonfall          branch main          Claude Code works here, and merges everything here
D:\Dragonfall-cursor   branch lane/cursor   Cursor works here (a git worktree of the same repo)
```

Both folders share one git history, so commits made in one are visible from the other immediately. No pushing or
pulling is needed. Each folder has its own files on disk, so the two agents never edit the same file at the same
moment. Each lane only edits the directories it owns (see the ownership table in `AGENTS.md`), so merges rarely
conflict.

## One-time setup (you)

1. **Open the Cursor lane:** in Cursor, *File → Open Folder… → `D:\Dragonfall-cursor`*. Check that
   *Cursor Settings → Rules* lists the project rules `00-project`, `10-rendering` and `20-ui-input-audio`.
   Cursor also reads `AGENTS.md` automatically.
2. **Open the Claude lane:** either keep using Claude Code in a terminal in `D:\Dragonfall`, **or** (recommended)
   open a *second* Cursor window on `D:\Dragonfall`, open its terminal (Ctrl+`), and run `claude`. Inside Cursor,
   Claude's edits show up as diffs in the editor. If it doesn't connect automatically, type `/ide`.
3. **Install dependencies:** Claude runs `npm install` in `D:\Dragonfall` during Phase 0. After you sync Cursor
   for the first time, run `npm install` in `D:\Dragonfall-cursor` too (in Cursor's terminal).
4. **Optional:** give Cursor the Higgsfield skills as well:
   `npx skills add higgsfield-ai/skills -g -a cursor`. Asset generation is Claude's job, so this is optional.

## Phase 0 (Claude alone)

Tell Claude: **"Start Phase 0."** Cursor waits. Claude creates the scaffold, contracts and dev tools, commits on
`main`, and tells you when it's done. Then tell Cursor **"sync with main"** and run `npm install` in its folder.

## The everyday loop (from Phase 1 on)

| Step | Say to **Claude** (`D:\Dragonfall`) | Say to **Cursor** (Agent mode, `D:\Dragonfall-cursor`) |
| --- | --- | --- |
| Start a session | "Continue the Claude lane." | "Continue the Cursor lane." |
| Both work | (works through `docs/tasks/claude-lane.md`) | (works through `docs/tasks/cursor-lane.md`) |
| A Cursor task finished | | Cursor commits on `lane/cursor` by itself |
| Bring Cursor's work into the game | "Merge Cursor's work." (Claude commits its own work, merges `lane/cursor` into `main`, runs typecheck/tests/build, fixes conflicts) | |
| Give Cursor Claude's latest work | | "Sync with main." (runs `git merge main`) |
| Play the combined game | run `npm run dev` in `D:\Dragonfall` and open the URL | |

**How often to sync:** after every finished task in either lane, or whenever one lane's task "Needs" something
the other lane just finished. Frequent small merges are painless; big rare ones aren't.

**When an agent needs something from the other lane:** it writes a request in its own handoff file
(`docs/handoff/claude-lane.md` or `docs/handoff/cursor-lane.md`). Mention it to the other agent at the next sync.

## Running both dev servers at once

Claude's folder usually gets `http://localhost:5173` and Cursor's gets `5174`; Vite picks the next free port.
Each server shows only that folder's version of the game. Play the **combined** game from `D:\Dragonfall` after a
merge.

## Testing with other laptops

The other laptops don't need the code, only a browser.
- **During development:** on the host laptop, run `npm run dev:lan` in `D:\Dragonfall`. It prints a
  `Network: http://192.168.x.x:5173` address that the other laptops open. (Phase 2 confirms whether multiplayer
  works over plain HTTP on LAN. If it doesn't, we switch to HTTPS and you click through a certificate warning once
  per laptop.)
- **For real play:** the Phase 7 deploy gives everyone one HTTPS URL.

## Rules that keep this smooth

- Don't ask both agents to change the same file. If you want something that crosses lanes, ask Claude: it owns
  the contracts and can split the work.
- Cursor never switches branches or commits to `main`. Claude never commits to `lane/cursor`.
- If Cursor edits a file outside its lane, Claude flags it during the merge.
- Higgsfield generations cost credits. Claude asks before every batch.
