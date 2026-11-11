# Workflow: building Dragonfall with Claude Code

Claude Code writes the game. You steer, playtest on the laptops, and approve art and Higgsfield spending.

## Starting a session

1. Open a terminal in the project folder and start Claude:
   ```
   cd D:\Dragonfall
   claude
   ```
   (Or open `D:\Dragonfall` in Cursor or VS Code, open the terminal with Ctrl+`, and run `claude`. Claude's edits
   then show up as diffs in the editor. If it doesn't connect, type `/ide`.)
2. Say what you want, for example:
   - **"Start Phase 0"** (first time only)
   - **"Continue"**: Claude reads `docs/PROGRESS.md` and `docs/TASKS.md` and carries on with the next task
   - or anything specific: "make the boost feel stronger", "add a 3v3 test", ...

Starting a new chat is fine at any time. Claude records where it is in `docs/PROGRESS.md` and commits after every
task, so nothing is lost.

## Phase gates (your part)

At the end of each phase, Claude tells you what to test (see `docs/ROADMAP.md`). Usually that means playing it on
the laptops and reporting how it feels and what the perf HUD (`?perf`) shows.

## Playing it while it's being built

- **One laptop:** `npm run dev`, then open the URL it prints.
- **Several laptops (Phase 2 on):** on the host laptop run `npm run dev:lan`. It prints a
  `Network: http://192.168.x.x:5173` address that the other laptops open. They don't need the code, only a browser.
  (Phase 2 checks whether multiplayer works over plain HTTP on LAN. If not, we switch to HTTPS, and you accept a
  certificate warning once per laptop.)
- **For real play:** the Phase 7 deploy gives everyone one HTTPS URL.
- **Laptop settings:** see the end of `docs/PERFORMANCE.md` (plug in, Best performance mode, browser on the high
  performance GPU).

## Pushing to GitHub (when you're ready)

1. Create an **empty** repo on GitHub, with no README or license.
2. Optional: so the commits show up as yours, run this in `D:\Dragonfall`:
   `git config user.email "<your GitHub email or noreply address>"`
3. In `D:\Dragonfall`:
   ```
   git remote add origin https://github.com/<you>/dragonfall.git
   git push -u origin main
   ```
   LFS asset files upload automatically. After this, `git push` (or "push to GitHub" to Claude) is enough.
4. Reference footage from other games stays in `/reference/` (git-ignored). Never push it.

## Higgsfield credits

Claude asks before every generation batch and says what it will make. Nothing is generated without your OK.
